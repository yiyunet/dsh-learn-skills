/**
 * dsh-learn-skills —— DSH 插件入口（宿主半侧，唯一真源）。
 *
 * 本插件在宿主平面注册**三种入口，同一个流程实现**：
 *   ① 斜杠命令 `/learn <入口> [参数]` —— 人手敲的；
 *   ② HTTP RPC `/api/dsh-learn-skills` —— 输入区菜单按钮敲的；
 *   ③ 自然语言（"帮我初始化学习体系"）—— 模型读 SKILL.md 后调用 ①。
 * 三处最终都进 `flows.mjs` 的同一个函数，不存在两套规则。
 *
 * ⚠️ 本文件是宿主半侧：只用 Node 内置模块与宿主运行时提供的 `@deepseek-ai/*`。
 *    **不得**把 `@deepseek-ai/dsh-*` 写进 package.json 的依赖节 —— DSH 运行时包用
 *    模块局部 Symbol 做 key，装第二份物理副本会破坏 Host 查找。
 *
 * 发布产物由 `npm run build` 生成到 lib/；本文件不直接对外。
 *
 * @module @yiyunet/dsh-learn-skills
 */

import { createFlows, ENTRIES } from './flows.mjs'
import { registerLearnRpc, RPC_ENDPOINT } from './rpc.mjs'

export const name = 'learn-skills'

/**
 * 注入的服务。
 *
 * 这是本插件最重要的部署决策：**只硬依赖 `userQuestions` 与 `commands` 两个已
 * 在 dsh-base 里随宿主提供的服务**（`packages/bundle/base/cordis.patch.yml` 的
 * `user-questions` / `commands` 两行），其余（会话、工作区、RPC 传输）一律用
 * `ctx.get()` 可选获取。
 *
 * 理由：cordis 的 inject 语义是"服务齐了才激活"。把可选能力写进 inject，
 * 会让本插件在缺该能力的部署里**整体 inactive** —— 而它本可以降级工作。
 */
export const inject = ['userQuestions', 'commands']

/** 插件版本（status 回显与报告用；构建时与 package.json 一致）。 */
const VERSION = '2.2.0'

/** 命令名（斜杠后的名字）。 */
const COMMAND = 'learn'

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 * @param {object} [config] cordis.patch.yml 里的 config
 */
export function apply(ctx, config = {}) {
  // ⚠️ 临时诊断出口（定位装载 / RPC 注册问题用）——**发布前须移除或改为默认关闭**。
  //
  // 为什么要它：客户端半侧与宿主半侧的装载是**两条独立的路**（菜单能弹 ≠ 路由已挂）。
  //   诊断文件把这条分叉一刀切开：
  //     有 `apply() 已调用`      ⇒ 插件被装配过（问题只可能在注册环节）
  //     无该行                    ⇒ 这个入口压根没被装配（问题在装载层，与插件代码无关）
  //     有 `RPC 已注册`           ⇒ 路由真的挂上了
  //     有 `connection 未就绪`    ⇒ 走的是**延迟注册**（这条路径就是为它写的）
  // 落点选 `~/.dsh/`（DSH 自己的家目录），避免污染任何知识目录；
  // 失败静默吞掉 —— 诊断不该改变插件行为。
  const diagnose = line => {
    void (async () => {
      try {
        const [{ appendFileSync, mkdirSync }, { homedir }] = await Promise.all([
          import('node:fs'),
          import('node:os'),
        ])
        const dir = `${homedir()}/.dsh`
        mkdirSync(dir, { recursive: true })
        appendFileSync(
          `${dir}/learn-skills-boot.log`,
          `[${new Date().toISOString()}] pid=${process.pid} ${line}\n`,
          'utf8',
        )
      } catch {
        // 诊断失败不改行为：插件照常往下走
      }
    })()
  }
  diagnose(`apply() 已调用 cwd=${process.cwd()}`)

  const log = (level, message) => {
    const sink = ctx.logger?.[level]
    if (typeof sink === 'function') sink.call(ctx.logger, `[learn-skills] ${message}`)
  }

  /**
   * 会话读接口。
   *
   * 如实分层：能拿到什么就标什么，拿不到就标"无法访问"，**不猜**。
   * 这里刻意不假设 `ctx.fs` 一定存在 —— workspace 目录里本插件全程走 Node fs，
   * 因为它是宿主进程身份、不受 agent 沙箱约束；这也是为什么插件把
   * allowWrite 默认设计成需要人显式确认。
   */
  async function sessionInfo(sessionId) {
    const agents = ctx.get('agents')
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined) {
      return {
        sessionId: sessionId ?? null,
        workspace: null,
        presetId: null,
        messages: [],
        historyComplete: false,
        reason: '找不到该会话的 live agent（可能已结束或不是当前会话）',
      }
    }
    const session = agent.session
    let workspace = session?.header?.cwd ?? null
    if (workspace === null) {
      const registry = ctx.get('workspaceRegistry')
      if (typeof registry?.list === 'function') {
        const found = registry.list().find(item => (item.sessionIds ?? []).includes(sessionId))
        workspace = found?.path ?? null
      }
    }

    const events = typeof session?.events === 'function'
      ? [...session.events()]
      : Array.isArray(session?.events) ? [...session.events] : []
    const presetId = session?.header?.agentPreset
      ?? (typeof ctx.get('agents')?.presetForSession === 'function'
        ? ctx.get('agents').presetForSession(session) : null)

    // 上下文压缩会写 `surfaceOp: { op:'replace' }` —— 一旦出现，说明历史被折叠过，
    // 当前可见的部分不等于完整历史。这是"只有部分上下文时如实标注"的判据。
    const compacted = events.some(event => event?.surfaceOp !== undefined
      && typeof event.surfaceOp === 'object' && event.surfaceOp?.op === 'replace')

    const messages = []
    for (const event of events) {
      if (event?.type === 'user/message') {
        const text = textOf(event.data)
        if (text === '') continue
        messages.push({
          id: `seq-${event.seq}`,
          seq: Number(event.seq ?? 0),
          role: 'user',
          text,
          source: event.data?.source ?? 'unknown',
          sessionId,
          // 本插件自己的提问也走 agent.inject，标记出来供 fixRange 排除。
          origin: event.data?.source === 'agent.inject' && /learn-skills|AI学习/u.test(text) ? 'learn-skills' : undefined,
        })
        continue
      }
      if (event?.type === 'assistant/message') {
        const text = textOf(event.data?.message)
        if (text === '') continue
        messages.push({
          id: `seq-${event.seq}`,
          seq: Number(event.seq ?? 0),
          role: 'assistant',
          text,
          source: 'assistant',
          sessionId,
        })
      }
    }

    return {
      sessionId,
      workspace,
      presetId: presetId ?? null,
      messages,
      historyComplete: !compacted,
      compactionNote: compacted ? '该会话发生过上下文压缩，历史为部分范围' : null,
    }
  }

  const flows = createFlows({ config, ctx, sessionInfo, version: VERSION })

  // ── 入口 ①：斜杠命令 /learn ────────────────────────────────────────────
  const disposeCommand = ctx.commands.register({
    definitionId: '@yiyunet/dsh-learn-skills',
    name: COMMAND,
    description: 'AI学习：初始预设 / 收集提炼 / 关联升级 / 沉淀复用',
    input: { hint: '<入口> [参数]', attachments: false },
    handler: async invocation => {
      const raw = invocation.rawInput.trim()
      const [entryName, ...rest] = raw.split(/\s+/u)
      const args = rest.join(' ')
      const sessionId = String(invocation.agent?.id ?? '')
      try {
        if (entryName === '' || entryName === 'help') {
          return {
            kind: 'success',
            text: [
              'AI学习 —— 四个入口：',
              ...ENTRIES.map((entry, index) => `${index + 1}. ${entry.label} —— ${entry.description}`),
              '',
              '用法：/learn init ｜ /learn distill ｜ /learn upgrade [批次号] ｜ /learn audit ｜ /learn rollback <批次号>',
            ].join('\n'),
          }
        }
        const entry = ENTRIES.find(item => item.id === entryName || item.label === entryName)
        if (entry === undefined) {
          return { kind: 'error', text: `未知入口「${entryName}」。可用：${ENTRIES.map(item => item.id).join(' / ')}` }
        }
        // 走同一套 flows：命令与按钮不产生第二条规则路径。
        const result = entry.id === 'init'
          ? await flows.init({ sessionId, confirmCreate: args.includes('--confirm') })
          : entry.id === 'distill'
            ? await flows.distill({ sessionId })
            : entry.id === 'upgrade'
              ? await flows.upgrade({ sessionId, batchId: args === '' ? undefined : args, confirmWrite: args.includes('--confirm') })
              : await flows.runAudit({ sessionId })
        return { kind: result?.ok === false ? 'error' : 'success', text: renderForText(result) }
      } catch (error) {
        log('warn', `命令执行失败：${String(error?.message ?? error)}`)
        return { kind: 'error', text: `执行失败：${String(error?.message ?? error)}` }
      }
    },
  })

  // ── 入口 ②：RPC（输入区菜单）────────────────────────────────────────────
  // ⚠️ `connection` 在 apply 时可能**尚未就绪**（它属于 Web 运行时那一层，而本插件
  //    只 inject userQuestions/commands）—— registerLearnRpc 自带两段式注册：
  //    就绪即注、未就绪则用 ctx.inject(['connection'], …) 挂到它就绪之后再注。
  const rpc = registerLearnRpc(ctx, { flows: () => flows, version: VERSION, diagnose })

  ctx.effect(() => () => { disposeCommand?.() }, 'learn-skills: /learn command')
  ctx.effect(() => () => { rpc.dispose?.() }, 'learn-skills: RPC endpoint')

  // ★ 如实汇报 RPC 状态：此前这句**无条件**写 "RPC /api/…"，注册失败时日志在撒谎。
  const rpcText = rpc.state.route !== null
    ? rpc.state.route
    : rpc.state.deferred === true
      ? `/api/${RPC_ENDPOINT}（待 connection 就绪后注册）`
      : `未注册（${rpc.state.reason ?? '原因未明'}）`
  log('info', `已挂载：命令 /${COMMAND}，RPC ${rpcText}，`
    + `写门禁 allowWrite=${config.allowWrite !== false}，行为规则 allowBehaviorRules=${config.allowBehaviorRules === true}`)
}

/** 把结果渲染成命令输出（人读；界面才是主要呈现通道）。 */
function renderForText(result) {
  if (result === undefined || result === null) return '（无输出）'
  if (typeof result === 'string') return result
  if (result.message !== undefined) {
    const extra = result.batchId === undefined ? '' : `\n批次：${result.batchId}`
    return `${result.message}${extra}`
  }
  return JSON.stringify(result, null, 2)
}

/**
 * 从一条会话事件的 data 里抽出文本。
 *
 * 刻意写成"多形状探测"：会话消息的承载字段是宿主内部结构，本插件不该因为
 * 宿主的一次字段重命名就整体失效。探测失败返回空串（该条被跳过），不抛错。
 * @param {unknown} data 事件 data
 * @returns {string} 文本
 */
function textOf(data) {
  if (data === undefined || data === null) return ''
  if (typeof data === 'string') return data
  const content = Array.isArray(data.content) ? data.content : undefined
  if (content !== undefined) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    if (parts.length > 0) return parts.join('\n').trim()
  }
  if (typeof data.text === 'string') return data.text.trim()
  if (Array.isArray(data.stream)) {
    const parts = []
    for (const item of data.stream) {
      if (typeof item?.text === 'string') parts.push(item.text)
    }
    if (parts.length > 0) return parts.join('').trim()
  }
  return ''
}
