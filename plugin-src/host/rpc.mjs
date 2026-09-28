/**
 * rpc.mjs —— 客户端 ↔ 宿主 RPC 端点。
 *
 * 契约形状是硬性的（沿用本部门已实测过的同一套信封，见 N23）：
 *   客户端：ctx.connection.rpc.call('/api', '<endpoint>', { method, payload }, signal)
 *   宿主：  ctx.connection.fetch.register({ path:'/api/<endpoint>', methods:['POST'],
 *            requestBody:'buffered', fetch })
 *   成功：  { type:'server-response', rpcId, result:{ ok:true, value:<载荷> } }
 *   失败：  { type:'server-response', rpcId, result:{ ok:false, error:{ code, message, details } } }
 *
 * ★ error.details 必须是对象；缺了会被客户端判为非法响应（实测教训）。
 *
 * @module dsh-learn-skills/rpc
 */

/** 端点名（不含 /api/ 前缀）。客户端必须用同一个名字。 */
export const RPC_ENDPOINT = 'dsh-learn-skills'

/** 允许的 method 白名单 —— 未列出的方法一律拒绝，不靠调用方自觉。 */
export const METHODS = Object.freeze([
  'status', 'init', 'initConfirm', 'installPreset', 'distill', 'upgrade', 'upgradeConfirm',
  'audit', 'auditSave', 'rollback', 'cancel',
])

function envelope(rpcId, result) {
  if (result?.ok === false) {
    return Response.json({
      type: 'server-response',
      rpcId,
      result: {
        ok: false,
        error: {
          code: result.code ?? 'error',
          message: result.message ?? '未知错误',
          details: result.details ?? {},
        },
      },
    })
  }
  return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: result } })
}

/**
 * 取宿主的 `connection` 服务；取不到返回 `undefined`，**不抛**。
 *
 * ⚠️ 为什么必须"两种取法都试、且允许取不到"：
 *   cordis 里服务的属性访问**只有在该服务已就绪时才解析得到**。本插件只 inject
 *   `userQuestions` 与 `commands`（见 `index.mjs` 的部署决策），因此 `apply()`
 *   **常常早于 `connection` 就绪**（`connection` 属于 Web 运行时那一层）。
 *   原实现在 apply 那一刻判一次 `ctx.connection`，早到就**永久放弃注册** ——
 *   症状正是「菜单能弹（客户端半侧独立装载）、斜杠命令可用、点菜单报 HTTP 404」。
 * @param {object} ctx 宿主上下文
 * @returns {object|undefined} connection 服务（可能尚未就绪）
 */
function resolveConnection(ctx) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch {
    // 某些 cordis 版本在服务缺席时 get 会抛 —— 一律按"还没就绪"处理
  }
  try {
    const viaProperty = ctx.connection
    if (viaProperty !== undefined && viaProperty !== null) return viaProperty
  } catch {
    // 同上：属性访问在服务缺席时也可能抛
  }
  return undefined
}

/**
 * 注册 RPC 端点（**在 connection 就绪之前调用也安全**）。
 *
 * 注册时机分两段：
 *   ① `connection` 已就绪 ⇒ 当场注册；
 *   ② 尚未就绪 ⇒ 用 `ctx.inject(['connection'], …)` **挂到它就绪之后再注册**
 *      （cordis 的标准"可选依赖"姿势，宿主自身在 60+ 处这样用）。
 *
 * 取 ② 而不是把 `connection` 写进插件静态 `inject`：那会让本插件在**没有 Web
 * 运行时的部署**里整体 inactive —— 而它本可以只降级掉「菜单」这一项能力。
 *
 * 路径口径（已按宿主源码定死）：`rpc-host.ts:266-275` 的
 * `endpointFromPath('/api', path)` 与 `:292-295` 的 `assertFetchRoute` 要求
 * **路径必须带 `/api/` 前缀**；`rpc.ts:117` 那句类型注释 "Absolute path below
 * `/api`" 是**误导**（第二形态在当前宿主上必然抛错，留着只为兼容别的 DSH 版本，
 * 失败原因会写进诊断出口，不被静默吞掉）。
 * @param {object} ctx 宿主上下文
 * @param {object} deps 依赖
 * @param {() => object} deps.flows 取 flows 实例（懒解析，便于宿主重载）
 * @param {string} deps.version 插件版本
 * @param {(line: string) => void} [deps.diagnose] 诊断出口（可选；把注册结论留痕）
 * @returns {{ dispose: () => void, state: { route: string|null, deferred: boolean, reason: string|null } }} 释放函数与注册状态
 */
export function registerLearnRpc(ctx, deps) {
  const diagnose = typeof deps?.diagnose === 'function' ? deps.diagnose : () => {}
  /** 注册状态（调用方用它如实汇报 RPC 到底有没有挂上）。 */
  const state = { route: null, deferred: false, reason: null }
  /** 已注册路由的释放函数（成功才有）。 */
  let disposeRoute
  /** 等 connection 就绪的那个 fiber（走了延迟注册才有）。 */
  let fiber

  /** 正在跑的流程 → AbortController。取消从这里来。 */
  const running = new Map()

  const methods = {
    /** 状态总览：工作区、初始化情况、待处理批次、体检基线、写门禁。 */
    async status(payload = {}) {
      return deps.flows().status({ sessionId: payload.sessionId })
    },

    /** 初始预设：不带 confirmCreate 时只出预览（六轮问答 + 摘要）。 */
    async init(payload = {}, signal) {
      const controller = new AbortController()
      const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
      running.set('init', controller)
      try {
        return await deps.flows().init({
          sessionId: payload.sessionId,
          signal: combined,
          confirmCreate: payload.confirmCreate === true,
          // `restart: true` ⇒ 明确要求"重答一遍六题"（界面上是「重新回答」按钮）。
          // 不带它时，若上一轮答案还在（phase: awaitingReview），流程直接回到预览、不重问。
          restart: payload.restart === true,
        })
      } finally {
        running.delete('init')
      }
    },

    /** 显式确认创建（与 init 分开，避免"预览即创建"的误触）。 */
    async initConfirm(payload = {}, signal) {
      const controller = new AbortController()
      const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
      running.set('init', controller)
      try {
        return await deps.flows().init({
          sessionId: payload.sessionId,
          signal: combined,
          confirmCreate: true,
        })
      } finally {
        running.delete('init')
      }
    },

    /** 收集提炼：产出候选并逐条裁决。 */
    async distill(payload = {}, signal) {
      const controller = new AbortController()
      const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
      running.set('distill', controller)
      try {
        return await deps.flows().distill({ sessionId: payload.sessionId, signal: combined })
      } finally {
        running.delete('distill')
      }
    },

    /** 关联升级：不带 confirmWrite 时只出变更清单。 */
    async upgrade(payload = {}, signal) {
      const controller = new AbortController()
      const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
      running.set('upgrade', controller)
      try {
        return await deps.flows().upgrade({
          sessionId: payload.sessionId,
          batchId: payload.batchId,
          signal: combined,
          confirmWrite: payload.confirmWrite === true,
        })
      } finally {
        running.delete('upgrade')
      }
    },

    /** 显式确认写入（与 upgrade 分开）。 */
    async upgradeConfirm(payload = {}, signal) {
      const controller = new AbortController()
      const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
      running.set('upgrade', controller)
      try {
        return await deps.flows().upgrade({
          sessionId: payload.sessionId,
          batchId: payload.batchId,
          signal: combined,
          confirmWrite: true,
        })
      } finally {
        running.delete('upgrade')
      }
    },

    /** 沉淀复用：只读体检。 */
    async audit(payload = {}) {
      return deps.flows().runAudit({ sessionId: payload.sessionId })
    },

    /** 保存报告与基线（用户显式选择后）。 */
    async auditSave(payload = {}) {
      return deps.flows().saveAudit({
        sessionId: payload.sessionId,
        report: payload.report ?? '',
        baselineCandidate: payload.baselineCandidate ?? {},
      })
    },

    /** 回滚某个变更批次。 */
    async rollback(payload = {}) {
      if (typeof payload.batchId !== 'string' || payload.batchId === '') {
        return { ok: false, code: 'bad-request', message: '需要 batchId' }
      }
      return deps.flows().rollback({ sessionId: payload.sessionId, batchId: payload.batchId })
    },

    /**
     * 把刚生成的预设 bundle 装进当前 profile（「界面一键」的宿主侧入口）。
     *
     * ★ 只在用户按下「安装预设」按钮时被调用 —— 该点击即审批动作（安装会在
     *   Host 进程执行新代码）。本插件不在生成后自动装，见 flows 里那段说明。
     *   本方法**不接取消信号**：`installBundle` 以 profile 级文件锁串行执行，
     *   中途废弃的写入更危险，取消只能由服务端自己完成。
     */
    async installPreset(payload = {}) {
      return deps.flows().installPreset({
        sessionId: payload.sessionId,
        presetId: payload.presetId,
        requestId: payload.requestId,
      })
    },

    /** 取消正在跑的流程。取消后不再启动后续写入步骤。 */
    async cancel(payload = {}) {
      const key = payload.flow ?? 'init'
      const controller = running.get(key)
      if (controller === undefined) {
        return { ok: true, cancelled: false, message: '当前没有正在运行的流程。' }
      }
      controller.abort(new Error('user cancelled'))
      return { ok: true, cancelled: true, message: '已发出取消信号；已完成的步骤保留，未开始的写入不会执行。' }
    },
  }

  const handle = async (request) => {
    let body
    try {
      body = await request.json()
    } catch {
      return Response.json({ type: 'client-request' }, { status: 400 })
    }
    const rpcId = body?.rpcId
    const method = body?.payload?.method
    const payload = body?.payload?.payload ?? {}
    if (typeof method !== 'string' || !METHODS.includes(method)) {
      return envelope(rpcId, {
        ok: false,
        code: 'unknown-method',
        message: `未知方法：${String(method)}`,
        details: { available: METHODS },
      })
    }
    try {
      const result = await methods[method](payload, request.signal)
      // ★ 失败也留痕：客户端界面在失败时只显示兜底文案，真因必须能在诊断出口看到。
      if (result?.ok === false) {
        diagnose(`RPC ${method} 业务失败 code=${result.code ?? '-'}`
          + ` message=${String(result.message ?? '').slice(0, 200)}`)
      }
      return envelope(rpcId, result)
    } catch (error) {
      diagnose(`RPC ${method} 抛错 ${String(error?.name ?? 'Error')} code=${error?.code ?? '-'}`
        + ` message=${String(error?.message ?? error).slice(0, 200)}`)
      return envelope(rpcId, {
        ok: false,
        code: error?.code ?? 'internal',
        message: String(error?.message ?? error),
        details: { stack: undefined },
      })
    }
  }

  /**
   * 在给定上下文里尝试注册 Fetch 路由，并**把实际用上的路径与失败原因都写进诊断出口**。
   *
   * 两种路径都试：第一形态（带 `/api/` 前缀）按宿主断言**才是合法的那条**；
   * 第二形态只为兼容"注释口径"真的生效的 DSH 版本 —— 在当前宿主上它必然抛
   * `invalid exact Fetch route`，失败原因照实记录，不静默吞。
   * @param {object} target 目标上下文（可能是 `ctx.inject` 给的就绪子上下文）
   * @param {string} phase 触发阶段（apply / connection-ready）
   * @returns {'ok' | 'no-service' | 'failed'} 结果
   */
  function registerOn(target, phase) {
    const connection = resolveConnection(target)
    if (typeof connection?.fetch?.register !== 'function') {
      state.reason = `${phase}: 没有 connection.fetch.register`
      return 'no-service'
    }
    const tryPaths = [`/api/${RPC_ENDPOINT}`, `/${RPC_ENDPOINT}`]
    const attempts = []
    for (const path of tryPaths) {
      try {
        // ⚠️ 返回值可能是**异步** disposer（`() => Promise<void>`），下面统一兼容。
        disposeRoute = connection.fetch.register({
          path,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: handle,
        })
        state.route = path
        state.reason = null
        state.deferred = false
        diagnose(`RPC 已注册 path=${path} phase=${phase}（候选：${tryPaths.join(' / ')}）`)
        ctx.logger?.info?.(`[learn-skills] RPC 端点已注册：${path}`
          + `（候选：${tryPaths.join(' / ')}；phase=${phase}）`)
        return 'ok'
      } catch (error) {
        attempts.push(`${path} → ${String(error?.message ?? error)}`)
        diagnose(`RPC 注册失败 path=${path} phase=${phase} reason=${String(error?.message ?? error)}`)
      }
    }
    state.reason = `${phase}: 两种路径都注册失败（${attempts.join('；')}）`
    ctx.logger?.warn?.('[learn-skills] RPC 端点两种路径都注册失败 —— 输入区菜单不可用'
      + `（斜杠命令 /learn 不受影响）。尝试记录：${attempts.join('；')}`)
    return 'failed'
  }

  // ── 两段式注册：就绪即注；未就绪挂到就绪之后 ─────────────────────────────
  const outcome = registerOn(ctx, 'apply')
  if (outcome === 'no-service') {
    if (typeof ctx.inject === 'function') {
      try {
        fiber = ctx.inject(['connection'], child => {
          // 已经注册过就不重复（inject 回调在重载/重连时可能被多次触发）
          if (state.route === null) registerOn(child, 'connection-ready')
        })
        state.deferred = state.route === null
        diagnose(`connection 未就绪：apply 阶段未注册，已挂到它就绪之后（deferred=${state.deferred}）`)
        ctx.logger?.info?.('[learn-skills] connection 尚未就绪 ⇒ RPC 注册已挂到它就绪之后'
          + '（本插件不把 connection 写进静态 inject，以免在无 Web 运行时的部署里整体 inactive）')
      } catch (error) {
        state.reason = `挂接 connection 失败：${String(error?.message ?? error)}`
        diagnose(state.reason)
        ctx.logger?.warn?.(`[learn-skills] ${state.reason} —— 输入区菜单不可用（斜杠命令 /learn 不受影响）`)
      }
    } else {
      state.reason = 'apply: 宿主既无 connection 也无 ctx.inject'
      diagnose(state.reason)
      ctx.logger?.warn?.('[learn-skills] 宿主既无 connection 也无 ctx.inject —— 输入区菜单不可用（斜杠命令 /learn 不受影响）')
    }
  }
  diagnose(`RPC 状态终值：route=${state.route ?? '(未注册)'} deferred=${state.deferred} reason=${state.reason ?? '-'}`)

  return {
    dispose: () => {
      try {
        disposeRoute?.()
      } catch {
        // 已随 fiber / 服务释放；重复释放不视为错误
      }
      try {
        fiber?.dispose?.()
      } catch {
        // 同上
      }
    },
    state,
  }
}
