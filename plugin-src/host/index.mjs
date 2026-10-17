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
import { plainText } from './ui-text.mjs'

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

/** 插件版本（status 回显与报告用；与 package.json 一致，由 `verify-package.mjs` 断言）。 */
const VERSION = '2.2.8'

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
        // 读统计：连会话都没找到时也必须给出**同形状**的字段（处处按它判"读到了吗"）。
        readStats: { eventsRead: 0, eventTypes: [], eventsSource: 'none', messagesBuilt: 0, textChars: 0, excludedBySource: [] },
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

    // ★ 读事件：**0.2.1-rc.1 的 `Session` 没有 `events()`**。
    //   官方 API 只有 `snapshotEvents(fromSeq,toSeqExclusive)` / `ownEvents()` /
    //   `deriveMessages()` / `deriveEventMessage()`（依据：`packages/core/session/src/index.ts`
    //   的 725 / 742 / 984 / 1013 行，逐条对得上 api-catalog 里的 `class Session` 声明）。
    //   此前这里只查 `session.events`，于是**永远拿到空数组** ⇒ messages 恒空 ⇒
    //   候选恒 0 —— 而界面把这一路结果说成「完整历史」。这就是「收集提炼」只有空表的根因。
    //   现在按"新名 → 老名 → 裸数组"三步取，并把命中哪一步记进 readStats，
    //   下次真机一看 `eventsSource` 就知道走的是哪条路。
    const { events, eventsSource } = readSessionEvents(session)
    const presetId = session?.header?.agentPreset
      ?? (typeof ctx.get('agents')?.presetForSession === 'function'
        ? ctx.get('agents').presetForSession(session) : null)

    // 上下文压缩会写 `surfaceOp: { op:'replace' }` —— 一旦出现，说明历史被折叠过，
    // 当前可见的部分不等于完整历史。这是"只有部分上下文时如实标注"的判据。
    const compacted = events.some(event => event?.surfaceOp !== undefined
      && typeof event.surfaceOp === 'object' && event.surfaceOp?.op === 'replace')

    const messages = []
    // ★ 只把**真人输入**当消息（2026-10 真机：58 条候选里大半是注入噪声）。
    //
    //   宿主把运行时上下文、技能目录、AGENTS.md 指令、时间上下文、goal 轮次等
    //   **统统写成 `user/message`**，只在 `data.source.kind` 上区分。`events()` 修好之后
    //   我们第一次真正读到它们，于是「Current runtime context…」「<system-reminder>…」
    //   「Additional instructions from AGENTS.md」全成了候选。
    //   第一性原理：**知识只能来自人说的话**，机器注入的内容不是知识。
    //   白名单只有 `'user'`；其余按 kind 计数进 readStats —— **看得见地排除**，不静默丢。
    const excludedBySource = new Map()
    for (const event of events) {
      if (event?.type === 'user/message') {
        const kind = sourceKindOf(event.data)
        if (kind !== 'user') {
          excludedBySource.set(kind, (excludedBySource.get(kind) ?? 0) + 1)
          continue
        }
        const text = textOf(event.data)
        if (text === '') continue
        messages.push({
          id: `seq-${event.seq}`,
          seq: Number(event.seq ?? 0),
          role: 'user',
          text,
          // `source` 是**对象**（`{ kind, … }`），不是字符串 —— 宿主侧判据是
          // `event.data.source.kind === 'user'`（依据 `packages/goal/tool-goal/src/authority.ts:83`）。
          // 早期这里按字符串比较，于是"排除本插件自己的提问"从未生效。
          source: kind,
          sessionId,
          // 本插件自己的提问也走 agent.inject，标记出来供 fixRange 排除。
          origin: kind === 'agent.inject' && /learn-skills|AI学习/u.test(text) ? 'learn-skills' : undefined,
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

    // 事件类型分布（前 5）：只用于**报读**，不参与任何判定。
    // 为什么需要它：只认 `user/message` / `assistant/message` 两种类型，若宿主改了
    // 事件名，这里会一个都不匹配 —— 而"类型对不上"与"会话里真没消息"在界面上
    // 长得一模一样。把实际类型打出来，下一次就能一眼分辨。
    const typeCounts = new Map()
    for (const event of events) {
      const type = typeof event?.type === 'string' && event.type !== '' ? event.type : '(无 type)'
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
    }
    const eventTypes = [...typeCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }))

    return {
      sessionId,
      workspace,
      presetId: presetId ?? null,
      messages,
      historyComplete: !compacted,
      compactionNote: compacted ? '该会话发生过上下文压缩，历史为部分范围' : null,
      // ★ 读统计：**"读不到"必须是一个可见的数字**，不能表现成"没有值得记的内容"。
      //   真机症状（两台机器都踩过）：提炼产出 0 条候选，界面却报「完整历史」，
      //   根因就在这一层 —— 事件为 0 条、或事件类型与预期不符、或文本抽不出来，
      //   三种情况的结果都是 `messages: []`，而下游无从区分。这三个数就是判据。
      readStats: {
        eventsRead: events.length,
        // 走的是哪条读取路径：`snapshotEvents`（0.2.1-rc.1 的真身）/ `events` / `events-array` / `none`。
        // 真机看到 `none` ⇒ 宿主又换了 API；看到 `events` ⇒ 跑在旧宿主上。这是定因用的读数。
        eventsSource,
        eventTypes,
        messagesBuilt: messages.length,
        textChars: messages.reduce((sum, message) => sum + message.text.length, 0),
        // 被排除的注入来源（按 kind 计数）。`user/message` 不等于"人说的话" ——
        // 宿主把 runtime-context / agent-instructions / goal / time-context 都写成它。
        // 这份读数让"我排掉了多少机器噪声"也是可见的，而不是让候选数凭直觉变化。
        excludedBySource: [...excludedBySource.entries()]
          .sort((left, right) => right[1] - left[1])
          .map(([kind, count]) => ({ kind, count })),
      },
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
    // 命令输出同样是纯文本：`**没有**` 会连着星号一起显示，与界面同一条判据。
    return `${plainText(result.message)}${extra}`
  }
  return JSON.stringify(result, null, 2)
}

/**
 * 取会话事件，按宿主实际 API 分三步回落。
 *
 * 为什么必须是三步：`Session` 的事件读取新版本叫 `snapshotEvents()`（0.2.1-rc.1 实测，
 * 见 `packages/core/session/src/index.ts:725`；`ownEvents()` 只给本对象生命周期内产生的事件，
 * 语义不同，**不能拿它顶替**），老宿主/部分封装则暴露 `events()` 或裸数组。
 * 只认一种的后果是"读不到"，而"读不到"在界面上与"没有内容"长得一模一样 ——
 * 这正是本插件"提炼恒 0 候选、却报完整历史"的病根。
 *
 * @param {object} session 会话对象（可能为 undefined）
 * @returns {{events: object[], eventsSource: 'snapshotEvents'|'events'|'events-array'|'none'}}
 */
export function readSessionEvents(session) {
  if (session === undefined || session === null) return { events: [], eventsSource: 'none' }
  const snapshotEvents = session.snapshotEvents
  if (typeof snapshotEvents === 'function') {
    const taken = snapshotEvents.call(session)
    // 无参调用即全量：`toSeqExclusive` 默认取 `this.seq`。
    if (taken !== null && typeof taken === 'object' && typeof taken[Symbol.iterator] === 'function') {
      return { events: [...taken], eventsSource: 'snapshotEvents' }
    }
  }
  const events = session.events
  if (typeof events === 'function') return { events: [...events.call(session)], eventsSource: 'events' }
  if (Array.isArray(events)) return { events: [...events], eventsSource: 'events-array' }
  return { events: [], eventsSource: 'none' }
}

/**
 * 取消息来源标识（字符串）。
 *
 * 为什么单独成函数：宿主的 `user/message.data.source` 是**对象**（`{ kind, … }`），
 * 判据是 `source.kind`（依据 `packages/goal/tool-goal/src/authority.ts:83`）；
 * 本插件早期按字符串比较，`'agent.inject'` 永远不成立 ⇒ 自己的提问从未被排除，
 * 会混进候选。这里同时容忍"已经是字符串"的老形状，并且**不允许**回落成 `[object Object]`。
 *
 * @param {object} data 事件 data
 * @returns {string} 来源 kind，识别不出时 `'unknown'`
 */
export function sourceKindOf(data) {
  const source = data?.source
  if (typeof source === 'string') return source
  if (typeof source?.kind === 'string') return source.kind
  return 'unknown'
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
