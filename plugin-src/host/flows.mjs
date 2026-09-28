/**
 * flows.mjs —— 四个入口的编排层（把纯逻辑接到宿主能力上）。
 *
 * 这一层是"宿主能力"与"领域逻辑"的唯一接缝，因此三条纪律都落在这里：
 *   ① 写盘前必须有过人的明确确认（`confirm` 参数）；
 *   ② 行为规则与普通知识**分开确认**（`scope: 'rule' | 'knowledge'`）；
 *   ③ 取消之后不再启动后续写入步骤，并如实汇报已完成到哪一步。
 *
 * @module dsh-learn-skills/flows
 */

import { existsSync as nodeExists } from 'node:fs'
import { mkdir as nodeMkdir } from 'node:fs/promises'
import { homedir } from 'node:os'

import { collect, audit, renderAuditReport } from './audit.mjs'
import { readDirectory, readJson, readText, withLock, writeIfChanged } from './fsx.mjs'
import {
  CANDIDATE_TYPES, DECISION, contentChanged, dedupeCandidates, extractCandidates,
  findMissingNodes, fixRange, loadNodes as loadNodeFiles, mergeSemanticSuggestions,
  parseFrontmatter, relateToNodes, renderNode, VERIFICATION,
} from './knowledge.mjs'
import {
  baseOf, candidateId, dateStamp, fingerprint, isoDate, isoTimestamp, nextNodeId,
  presetIdFromName, validatePresetName,
} from './paths.mjs'
import {
  BACK_SENTINEL, CANCEL_SENTINEL, DEFAULT_PRESET_DIR, FIXED_QUESTION_IDS, SKIP_OPTION, TOTAL_ROUNDS,
  createPreset, discoverPresetNames, draftQuestion, draftQuestions, extractTopicMap, installInstructions,
  parseThreePart, renderPresetBody, renderPreview, scaffoldWorkspace, validateAnswers,
} from './preset.mjs'
import { BatchesStore, BaselineStore, KnownStore, SessionStore, openJournal } from './status.mjs'
import { MIN_ROUNDS, generateSemanticSuggestions, generateThemeMap } from './model.mjs'
import { redact } from './redact.mjs'

/** 学习插件的四入口（界面顺序即此顺序，固定不变）。 */
export const ENTRIES = Object.freeze([
  { id: 'init', label: '初始预设', description: '七轮问答确定画像，生成预设与工作区框架' },
  { id: 'distill', label: '收集提炼', description: '从当前会话产出候选知识，逐条由你裁决' },
  { id: 'upgrade', label: '关联升级', description: '与既有节点比对后，经你确认写入' },
  { id: 'audit', label: '沉淀复用', description: '只读体检 + 变化对比 + 复用建议' },
])

/** 流程取消：与用户按了取消、或宿主中止（断网/切会话）区分开。 */
export class FlowCancelled extends Error {
  /** @param {string} step 取消发生在哪一步 */
  constructor(step) {
    super(`流程在「${step}」被取消`)
    this.name = 'FlowCancelled'
    this.code = 'FLOW_CANCELLED'
    this.step = step
  }
}

/** 需要用户确认但用户拒绝了（不是错误，是正常的「不」。）。 */
export class FlowDeclined extends Error {
  /** @param {string} step 拒绝发生在哪一步 */
  constructor(step) {
    super(`用户在「${step}」选择了不继续`)
    this.name = 'FlowDeclined'
    this.code = 'FLOW_DECLINED'
    this.step = step
  }
}

/** 把 `ctx.userQuestions.ask` 的失败归一成两种可区分的结果。 */
const CANCEL_ERRORS = new Set(['ASK_CANCELLED', 'ASK_ABORTED'])

/**
 * 造一个 flows 实例。
 * @param {object} options 依赖
 * @param {object} options.config 插件配置
 * @param {object} options.ctx 宿主上下文（提供 logger / userQuestions）
 * @param {(sessionId: string) => Promise<{ workspace: string|null, presetId: string|null, messages: object[], historyComplete: boolean, sessionId: string|null }>} options.sessionInfo 会话读接口
 * @returns {object} 四个入口的实现
 */
export function createFlows(options) {
  const { config, ctx } = options
  const directories = {
    index: config.index ?? 'index',
    inbox: config.inbox ?? 'inbox',
    knowledge: config.knowledge ?? 'knowledge',
    data: config.data ?? 'data',
    task: config.task ?? 'task',
    reports: config.reports ?? 'reports',
    skillsDir: config.skillsDir ?? '.dsh/skills',
    stateDir: config.stateDir ?? '.dsh/learn-skills',
    presetDir: config.presetDir ?? DEFAULT_PRESET_DIR,
  }
  // ★ 2.1.0 起预设 bundle 落在**工作区内**（与官方 `editing-cordis-compositions`
  //   技能同一姿势："Write a bundle directory in the workspace"）。三条理由：
  //     ① 写工作区之外（`<dshHome>`）绕过沙箱，且把"预设身份"散进多个全局落点；
  //     ② 组合包/用户补丁两处落点已由部署方裁定，插件不该造第三处；
  //     ③ 落回工作区后，删除工作区＝连它的预设一起带走，"哪来的还回哪去"。
  //   `presetRoot` 仍保留为**显式绝对路径覆盖**（老配置不动即向后兼容）。
  const presetDir = directories.presetDir
  const configuredPresetRoot = typeof config.presetRoot === 'string' && config.presetRoot !== ''
    ? config.presetRoot
    : null
  /** 该工作区对应的预设根（绝对路径）。 */
  const presetRootFor = workspace => configuredPresetRoot ?? `${workspace}/${presetDir}`
  const limits = {
    maxFiles: config.auditMaxFiles ?? 400,
    maxBytes: config.auditMaxBytes ?? 200000,
    maxMessages: config.maxMessages ?? 400,
  }

  const writeEnabled = config.allowWrite !== false
  const behaviorRulesEnabled = config.allowBehaviorRules === true

  const logger = ctx?.logger
  const log = (level, message) => {
    const sink = logger?.[level]
    if (typeof sink === 'function') sink.call(logger, `[learn-skills] ${message}`)
  }

  /**
   * 取该会话"活着的那个 agent 实例"—— 提问必须带上它。
   *
   * ⚠️ 为什么必须带：`user-questions/request` 是 **Scoped<Agent>** 事件
   *   （宿主 `core/scope/src/scoped-events.generated.ts:37`；API 目录签名
   *   `'user-questions/request'(this: Scoped<Agent>, …)`），UI 的应答者注册在
   *   **Agent 作用域**（`client/ui-user-questions/src/client/index.ts:105`）。
   *   不带 agent 时宿主的瀑布跑在 **root 面**（`user-questions/src/index.ts:135-136`）
   *   ⇒ 没有人应答 ⇒ 抛 `NO_PROVIDER: no user-questions answerer accepted the request`
   *   （同文件 `:130-133`）。**斜杠命令没这个问题**（它本就在 agent 调用栈里），
   *   RPC 路径是"干净的 HTTP 上下文"，必须自己带上 —— 这正是真机上
   *   "点菜单报执行失败"的根因（原实现从未传过 agent）。
   *
   *   宿主身份校验很严（`user-questions/src/index.ts:93-107`）：登记的必须**正是**
   *   注册表里那个实例（否则 `CALLER_NOT_LIVE`），且必须是根 agent（否则
   *   `DELEGATED_CALLER`）。所以这里双重自校之后才敢带。
   * @param {string|undefined} sessionId 会话 id（`ctx.agents.get` 的键就是它）
   * @returns {object|undefined} live agent；拿不准时返回 `undefined`（宁可不带，不带错）
   */
  function liveAgentFor(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return undefined
    // ⚠️ 两种取法都要留：真宿主的 ctx 有 `get()`（服务按名取），而测试桩的 ctx 是个
    //    朴素对象、只挂属性。写死 `ctx.get(...)` 会让**全部流程用例**在第一次提问时抛
    //    `ctx.get is not a function` —— 一个守卫写窄了就炸一片。
    const agents = (typeof ctx.get === 'function' ? ctx.get('agents') : undefined) ?? ctx.agents
    if (typeof agents?.get !== 'function') return undefined
    const agent = agents.get(String(sessionId))
    if (agent === undefined || agent === null) return undefined
    if (typeof agent.id !== 'string' || agents.get(agent.id) !== agent) return undefined
    if (typeof agents.roots === 'function') {
      const roots = agents.roots()
      if (Array.isArray(roots) && !roots.includes(agent)) return undefined
    }
    return agent
  }

  /**
   * 读宿主名册 `ctx.agentPresets` —— **预设身份的唯一权威来源**。
   *
   * ⚠️ 为什么不能靠"扫目录/扫文件"：DSH 0.1.7-alpha.1 起预设是**声明式**的，
   *   身份＝声明行里的 `config.id`，而注册表**不扫描目录、也不接受 preset 路径**
   *   （`agent-preset-registry/README.zh.md:46`）。一份组合包可以声明**很多**个预设
   *   （本机 `dsh-migrated-presets` 一个文件里就有 12 个）—— 按目录名数只会数出
   *   "1 个"，而那个"1 个"的名字还会取错（取到文件里第一个非包名 `name:`）。
   *   官方还明写：**重复的 preset ID 会导致声明加载失败**（`agent-preset/README.zh.md:82`）。
   *   ⇒ 判据必须是名册本身，否则就是在用一个坏的镜子照自己。
   *
   * 取不到名册时**不降级成猜**：调用方据此**拒绝创建**（宁可不出件，也不出重复 id）。
   * @returns {Promise<{ available: boolean, ids: string[], names: string[], broken: {id: string, reason: string}[], reason: string|null }>} 名册快照
   */
  async function readRoster() {
    const service = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) ?? ctx.agentPresets
    if (service === undefined || service === null || typeof service.list !== 'function') {
      return { available: false, ids: [], names: [], broken: [], reason: '宿主未提供 agentPresets 服务（当前组合无名册）' }
    }
    try {
      const rows = await service.list()
      const list = Array.isArray(rows) ? rows : []
      return {
        available: true,
        ids: list.map(row => String(row?.id ?? '')).filter(id => id !== ''),
        names: list.filter(row => typeof row?.name === 'string' && row.name !== '').map(row => row.name),
        broken: list
          .filter(row => row?.broken !== undefined && row.broken !== null)
          .map(row => ({ id: String(row?.id ?? ''), reason: String(row.broken) })),
        reason: null,
      }
    } catch (error) {
      return {
        available: false, ids: [], names: [], broken: [],
        reason: `读取名册失败：${String(error?.message ?? error)}`,
      }
    }
  }

  /** 名册摘要（进结果体，供界面与留痕看"当时名册是什么样"）。 */
  function rosterDigest(roster) {
    if (roster === undefined) return null
    return {
      source: roster.available ? 'agentPresets' : 'unavailable',
      total: roster.available ? roster.ids.length : 0,
      broken: roster.broken ?? [],
      reason: roster.reason ?? null,
    }
  }

  /**
   * 向用户提问（把宿主 ask 的四种结局收成三种）。
   * @param {object[]} questions 问题
   * @param {AbortSignal|undefined} signal 取消信号
   * @param {object} [hooks] 可选钩子
   * @param {(questions: object[]) => void} [hooks.onAsk] 即将提问时的回调（界面显示状态用）
   * @param {string} [hooks.sessionId] 会话 id —— 取 live agent 用（见 `liveAgentFor`）
   * @returns {Promise<{ kind: 'answered'|'cancelled'|'declined', answers: object[] }>} 结局
   */
  async function ask(questions, signal, hooks = {}) {
    hooks.onAsk?.(questions)
    const agent = liveAgentFor(hooks.sessionId)
    try {
      const result = await ctx.userQuestions.ask({
        questions: questions.map(question => ({
          id: question.id,
          question: question.question,
          ...question.header === undefined ? {} : { header: question.header },
          ...question.detail === undefined ? {} : { detail: question.detail },
          ...question.options === undefined ? {} : { options: question.options },
          ...question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect },
        })),
        ...signal === undefined ? {} : { signal },
        ...agent === undefined ? {} : { agent },
      })
      const cancelled = result.answers.some(answer => answer.selected.includes(CANCEL_SENTINEL))
      // 「只点了取消」与「选了取消又输入了文字」都算取消：取消是一个明确动作。
      if (cancelled) return { kind: 'cancelled', answers: result.answers }
      return { kind: 'answered', answers: result.answers }
    } catch (error) {
      if (CANCEL_ERRORS.has(error?.code)) return { kind: 'cancelled', answers: [] }
      throw error
    }
  }

  /** 解包一问一答的答案：优先自由文本，其次选中项。 */
  function answerValue(answer) {
    if (answer === undefined) return ''
    const custom = typeof answer.custom === 'string' ? answer.custom.trim() : ''
    if (custom !== '') return custom
    const selected = (answer.selected ?? []).filter(item => item !== SKIP_OPTION.label)
    if (selected.length === 0) return ''
    return selected.join('、')
  }

  /** 会话与工作区定位：没有工作区就没法做任何落盘的事。 */
  async function resolveTarget(sessionId) {
    const info = await options.sessionInfo(sessionId)
    const workspace = config.workspaceRoot ?? info.workspace
    return { ...info, workspace }
  }

  /**
   * 生成「主题地图」草案（2026-09-28 补上"初始预设只搭空架子"那一环）。
   *
   * ★ 边界（刻意如此）：产出的是**地图**（往哪走 + 起手问题），不是**知识**。
   *   知识节点必须来自用户自己的会话 —— 否则会破「用户认可 ≠ 已事实验证」。
   * ★ 永不抛错：模型不在、超时、输出为空 ⇒ 返回空结构，框架保持旧骨架。
   * @param {{ answers: object, history?: object[], bodyDraft?: string }} options 入参
   * @returns {Promise<{ directions: object[], total: number, reason?: string }>} 地图草案
   */
  async function subjectFor({ answers, history }) {
    const result = await generateThemeMap({ ctx: options.ctx, answers, history })
    if (result.ok !== true) {
      log('info', `主题地图未生成，框架保持旧骨架：${String(result.reason ?? '未给出原因')}`)
      return { directions: [], total: 0, reason: String(result.reason ?? '未生成') }
    }
    const parsed = extractTopicMap(result.text)
    if (parsed.total === 0) {
      log('info', '主题地图解析后为空（模型输出可能不合格式），框架保持旧骨架')
      return { directions: [], total: 0, reason: '解析为空' }
    }
    log('info', `主题地图已生成：${parsed.directions.length} 个方向、${parsed.total} 个条目`)
    return parsed
  }

  /**
   * 由**当前已采集的答案**渲染一份预设正文草稿（纯计算，不落盘）。
   *
   * ★ 方案 B 的关键一环：把这份草稿注入出题提示词，模型才能看见"我这题会改到
   *   正文里的哪一句"。没有它，模型只能猜"还缺什么字段"；有了它，它可以判断
   *   "哪一句还是套话"。这正是"生成的问题要有目的性"的机制落点。
   * @param {object} answers 已采集答案（可能含校验失败的中间态）
   * @returns {string} 正文草稿；拿不出姓名时返回空串（不注入）
   */
  function bodyDraftOf(answers) {
    const name = answers?.name
    if (typeof name !== 'string' || name.trim() === '') return ''
    try {
      const validated = validateAnswers(answers, { usedNames: [] })
      return renderPresetBody(validated.normalized)
    } catch {
      // 草稿只是给模型的提示，拿不到就不注入 —— 绝不因为它失败而打断提问流程。
      return ''
    }
  }

  /**
   * 读既有知识节点摘要（关联与体检共用）。
   *
   * 实现落在 `knowledge.mjs` 的 `loadNodes` 里，因为"缺 id 就静默跳过"这个行为
   * 必须能被测试直接钉住 —— 它内联在这里时，测试只能间接从外部现象猜是哪一环断的。
   * 这里只负责把宿主能力（读文本 / 列目录）与告警通道接上去。
   *
   * 返回值从"只要 nodes"改成"**nodes + skipped**"：写盘侧需要知道
   * "目录里有哪些 .md 是我载入不了的" —— 那些文件仍然**占着写目标**。
   * @param {string} workspace 工作区根
   * @returns {Promise<{ nodes: object[], skipped: object[] }>} 节点摘要与被跳过的文件
   */
  async function loadNodes(workspace) {
    const directory = `${workspace}/${directories.knowledge}/nodes`
    const { nodes, skipped } = await loadNodeFiles({
      directory,
      prefix: `${directories.knowledge}/nodes`,
      readText,
      readDirectory,
      warn: log,
    })
    if (skipped.length > 0) {
      log('warn', `本次有 ${skipped.length} 个节点文件载入不了（缺 frontmatter id）：`
        + `${skipped.map(item => item.relative).join('、')} —— 它们仍占着写目标，不会被当成"不存在"`)
    }
    return { nodes, skipped }
  }

  /**
   * 按节点 id 反查"这个候选可能落在哪个文件上"。
   *
   * 为什么需要它：节点文件名是 `<id>-<slug>.md`，而没有 frontmatter 的文件
   * **解析不出 id**（用户手改后就长这样）。那时"按 id 配对"必然落空，
   * 但文件仍**占着写目标** —— 判据只能退回到"路径里含不含这个 id"。
   * 不这么做，插件就会把它当成"新增"另建一个文件，**用户的改动被无声绕过**。
   *
   * @param {string} id 节点 id（如 `LN-20260920-001`）
   * @param {Map<string, {relative: string, sha: string|null}>} occupancies 占用表
   * @returns {string[]} 可能的目标路径（按写入记录优先排序）
   */
  function pathsForNodeId(id, occupancies) {
    if (typeof id !== 'string' || id === '' || occupancies === undefined) return []
    const marker = `${id}-`
    return [...occupancies.keys()].filter(path => {
      const base = baseOf(path).replace(/\.md$/u, '')
      return base === id || base.startsWith(marker)
    })
  }

  /**
   * 一条变更**可能**落在的所有路径：既有节点的路径、清单给的路径（新建时还是目录、不算），
   * 以及**按节点 id 反查出来的路径**（文件解析不出 id 时唯一能把它认回来的办法）。
   *
   * ⚠️ 一律用**对象形参**（`{ change, existing, occupancies }`）：先前这里是三个位置参数，
   *    而调用点按对象传，于是三个入参同时变成 `undefined` —— 函数**静默返回空数组**，
   *    闸门拿到零条路径，等于没装。症状是"拒绝覆盖不触发"，而它既不报错也不抛异常。
   *    这也是本轮把取键过程打进诊断出口才看见的：`relationIds` 有值、`paths` 却是空。
   * @param {{ change: object, existing?: object, occupancies?: Map<string, object> }} options 入参
   * @returns {string[]} 去重后的候选路径
   */
  function candidatePaths({ change, existing, occupancies }) {
    const out = []
    if (change.path !== undefined && !String(change.path).endsWith('/')) out.push(change.path)
    if (existing !== undefined) out.push(existing.relative)
    for (const relation of change.candidate?.relations ?? []) {
      out.push(...pathsForNodeId(relation.id, occupancies))
    }
    return [...new Set(out.filter(path => typeof path === 'string' && path !== ''))]
  }

  /** 读 inbox 里的候选批次文件。 */
  async function readBatchFile(workspace, batchId) {
    const path = `${workspace}/${directories.inbox}/.candidates-${batchId}.json`
    return readJson(path)
  }

  /** 写候选批次（**只进 inbox**：本阶段不碰正式知识、预设与 AGENTS.md）。 */
  async function writeBatchFile(workspace, batchId, payload) {
    const relativePath = `${directories.inbox}/.candidates-${batchId}.json`
    const decision = await writeIfChanged({
      absolute: `${workspace}/${relativePath}`,
      relative: relativePath,
      content: `${JSON.stringify(payload, null, 2)}\n`,
      baselineSha: null,
      overwrite: true, // 批次文件是本插件自己的产物，允许覆盖自己
    })
    return decision
  }

  const sessions = new Map()
  const storesFor = workspace => {
    if (!sessions.has(workspace)) {
      sessions.set(workspace, {
        session: new SessionStore({
          stateRoot: `${workspace}/${directories.stateDir}`,
          lockRoot: `${workspace}/${directories.stateDir}`,
          workspace,
        }),
        batches: new BatchesStore({ stateRoot: `${workspace}/${directories.stateDir}` }),
        baseline: new BaselineStore({ stateRoot: `${workspace}/${directories.stateDir}` }),
        known: new KnownStore({ stateRoot: `${workspace}/${directories.stateDir}` }),
      })
    }
    return sessions.get(workspace)
  }

  // ── 入口 1：初始预设（七轮互动）────────────────────────────────────────

  /**
   * 七轮问答 → 画像预览 → 用户确认 → 生成预设与工作区框架。
   * @param {object} request 请求
   * @param {string} request.sessionId 会话 id
   * @param {AbortSignal} [request.signal] 取消信号
   * @param {boolean} [request.confirmCreate] 是否已获创建确认（false = 只出预览）
   * @param {object} [request.hooks] 进度钩子
   * @returns {Promise<object>} 结果
   */
  async function init(request) {
    // 把会话 id 并进 hooks：`ask()` 靠它取 live agent（见 `liveAgentFor`）。
    // 顺序刻意如此 —— 传入的 hooks 覆盖不了这里的 sessionId，它才是权威值。
    const hooks = { ...request.hooks, sessionId: request.sessionId }
    const target = await resolveTarget(request.sessionId)
    if (target.workspace === null || target.workspace === undefined) {
      return {
        ok: false,
        code: 'NO_WORKSPACE',
        message: '当前会话没有绑定工作区，无法创建学习体系。'
          + '请先在输入区选择或新建一个工作区（工作区是知识落点，缺了它一切写入都无处可放）。',
      }
    }
    const store = storesFor(target.workspace)
    // ★ 名册闸：**在问第一个问题之前**就要判定，别让人答完七题才被告知"判不出来"。
    //   拿不到名册 ⇒ 无法保证不撞既有 `config.id` ⇒ 直接拒绝（见 `readRoster` 的长注释）。
    //   （预设根由 `finalize` 按同一个工作区算：`presetRootFor(target.workspace)`。）
    const roster = await readRoster()
    if (!roster.available) {
      return {
        ok: false,
        code: 'ROSTER_UNAVAILABLE',
        message: `无法读取宿主预设名册（agentPresets）：${roster.reason ?? '未知原因'}。`
          + '为避免生成与既有预设**重复的 config.id**（官方：重复的 preset ID 会导致声明加载失败），'
          + '本次不创建任何东西。请确认当前会话所在组合挂载了 @deepseek-ai/dsh-agent-preset-registry，'
          + '或改用手工方式新增预设。',
        roster: rosterDigest(roster),
      }
    }
    const presetRoster = { ids: new Set(roster.ids), names: new Set(roster.names) }

    const previous = await store.session.read()
    /** 七题都齐了才算走完问答（用于"预览 → 确认"的第二步）。 */
    const completeAnswerSet = value => value !== undefined
      && value !== null
      && typeof value === 'object'
      && typeof value.name === 'string' && value.name !== ''
      && ['vocation', 'audience', 'expectation', 'goal', 'baseline', 'style', 'priority'].every(key => key in value)
      && 'interests' in value

    // ── 确认阶段：直接复用预览时落盘的答案，**不重问七题** ──────────────
    // 避免"确认创建 = 再答一遍"这种把两件事混在一起的交互，也让重试幂等。
    if (request.confirmCreate === true && completeAnswerSet(previous?.answers)) {
      const confirmed = { values: previous.answers }
      confirmed.unknown = Object.fromEntries(
        ['vocation', 'audience', 'expectation', 'interests', 'goal', 'baseline', 'style', 'priority']
          .map(key => [key, previous.answers[key] === null]),
      )
      return await finalize({
        store, target, normalized: confirmed, presetId: previous.presetId, presetRoster, roster, request,
      })
    }

    // ── 续办：上一轮七题已答完但**没创建** ⇒ 回到预览，不再把人问一遍 ────────
    // 真机症状：每次点「初始预设」都从第 1 题重问一遍。答案就在磁盘上
    // （`phase: 'awaitingReview'`），而 `resumed` 这个变量**算了却没用上** ——
    // 于是"重进一次"等于"重答一遍"。想重答的走 `restart: true`（界面上是「重新回答」）。
    if (request.restart !== true && previous?.phase === 'awaitingReview' && completeAnswerSet(previous.answers)) {
      const reused = {
        values: previous.answers,
        unknown: Object.fromEntries(
          ['vocation', 'audience', 'expectation', 'interests', 'goal', 'baseline', 'style', 'priority']
            .map(key => [key, previous.answers[key] === null]),
        ),
      }
      const result = await finalize({
        store, target, normalized: reused, presetId: previous.presetId, presetRoster, roster,
        request: { ...request, confirmCreate: false },
      })
      return {
        ...result,
        reused: true,
        message: '上一轮七题已经答完（尚未创建）：以下是那一次的画像与拟建路径。'
          + '点「确认创建」就按它生成；想重新回答，点「重新回答」，我会再问一遍七题。',
      }
    }

    const answers = {}
    let index = 0
    const steps = []
    /** 逐轮记下实际问过的题与出题来源，供界面与留痕回答"这题是谁出的"。 */
    const askedQuestions = []
    /**
     * 逐轮记下"问了什么、他怎么答的"，供下一轮模型出题时**接着上文**。
     *
     * ★ 方案 B 的核心修复：早先每轮只把结构化 `answers` 丢给模型，
     *   模型看不到自己上一轮问了什么、用户原话是什么，于是每轮都是无状态冷启动
     *   —— 真机体感就是"题目像模板、不随前文变化"。
     */
    const history = []

    // ★ 轮次编排（2026-09-23 改）：前两轮固定（名字 / 三参数），第 3 轮起**由模型
    //   逐轮现场生成** —— 每轮都带上已经采集到的全部上下文，模型据此决定"下一步
    //   最缺什么"。模型不可用时 `draftQuestion` 内部回退到硬编码候选（老板裁决：
    //   模型优先、硬编码兜底），因此这条循环**不会**因为模型失败而中断。
    //   `async` 是这里唯一的新增复杂度来源：取题现在要等一次模型调用。
    //
    // ★ 2026-09 方案 B：模型现在还能判定"画像已足够"并**提前收尾**。下限护栏在
    //   `MIN_ROUNDS` —— 前几轮一律不认 done，免得退化成"三题流水线"。
    while (index < TOTAL_ROUNDS) {
      const question = await draftQuestion({
        answers,
        round: index + 1,
        total: TOTAL_ROUNDS,
        // ⚠️ 必须是 `options.ctx`：`ctx` 不在本闭包作用域内（它只存在于
        //    `createFlows(options)` 的形参里）。写 `ctx` 会在第 3 题抛
        //    `ctx is not defined` —— 而前两题固定、根本不调模型，所以这个错
        //    会精准地躲过前两轮的冒烟测试。本文件既有惯例见 `readRoster()`。
        ctx: options.ctx,
        signal: request.signal,
        log,
        options: {
          questions: askedQuestions.filter(entry => entry !== undefined),
          // 方案 B 的三样新上下文（见 model.mjs 的 buildMessages）。
          history: history.filter(entry => entry !== undefined),
          bodyDraft: bodyDraftOf(answers),
          doneAllowed: index + 1 >= MIN_ROUNDS,
        },
      })
      // ★ 提前收尾：模型判定"再问下去没有增量"。**不写任何东西**，直接复用
      //   `finalize` 出预览 —— 用户仍要点「确认创建」才会落盘。
      if (question.done === true) {
        if (index + 1 < MIN_ROUNDS) {
          // 护栏挡下的 done：留痕之后再继续问，避免"模型想停但停不了"被静默吞掉。
          log('info', `第 ${index + 1} 轮模型判定信息已足够，但未到最小轮数 ${MIN_ROUNDS}，继续提问`)
        } else {
          // ⚠️ 必须先归一化再 finalize：它内部读 `normalized.values.name`，
          //    直接传 undefined 会在早退路径上抛错（而这条路径没有测试覆盖就没人发现）。
          const earlyValidated = validateAnswers(answers, { usedNames: [...presetRoster.names] })
          if (earlyValidated.ok === false) {
            // 画像还不合法（例如名字撞了名册）——不能假装能收尾，继续问下去让用户修正。
            log('info', `第 ${index + 1} 轮模型判定已足够，但画像未通过校验（`
              + `${earlyValidated.errors.map(error => `${error.topic}:${error.code}`).join('、')}），继续提问`)
          } else {
            const stopReason = String(question.reason ?? '').trim()
            const early = await finalize({
              store, target, normalized: earlyValidated.normalized,
              presetId: undefined, presetRoster, roster, request,
            })
            return {
              ...early,
              stoppedEarly: true,
              answeredRounds: index,
              stopReason,
              message: `画像已经足够，提前结束提问（答完 ${index} 轮，上限 ${TOTAL_ROUNDS} 轮）。`
                + `${stopReason === '' ? '' : `理由：${stopReason}。`}`
                + '以下是画像与拟建路径；点「确认创建」才会生成。',
            }
          }
        }
      }
      // ⚠️ 这里**不能**记 history —— 此刻 "他怎么答的" 还不存在（`raw` 在下面才取）。
      //    早先把 history 写在这一位，会直接抛 `raw is not defined`。
      const persisted = (await store.session.read()) ?? {}
      const resumed = persisted.flow === 'init' && persisted.answers !== undefined && Object.keys(persisted.answers).length > 0
      if (steps.length === 0) {
        await store.session.open('init', { step: question.id, answers })
      } else {
        await store.session.step('init', question.id, answers)
      }

      const asked = await ask([question], request.signal, hooks)
      // ★ 在"返回"判定**之前**记录：这一次确实问出去了（重答时旧记录会被覆盖）。
      askedQuestions[index] = {
        round: index + 1,
        topic: question.topic,
        question: question.question,
        source: question.promptSource ?? 'fixed',
      }
      // ⚠️ `history[index]` 不在这里记（位置见下方 `raw` 之后那一处）。
      if (asked.kind === 'cancelled') {
        await store.session.write({
          flow: 'init', phase: 'aborted', step: question.id, answers,
          note: '用户取消；已收集的答案已保留，可稍后续办',
        })
        return {
          ok: false,
          code: 'FLOW_CANCELLED',
          step: question.topic,
          message: `已在「${question.header}」取消。已完成 ${index} / ${TOTAL_ROUNDS} 题；`
            + '已收集的答案保留在工作区状态里，重新进入可以续办；没有任何文件被创建。',
          completed: index,
          answers,
          resumed,
        }
      }

      const raw = answerValue(asked.answers[0])
      // ★ 记下"这一轮问了什么 + 他实际怎么答的"，供下一轮模型接着上文（方案 B）。
      //   位置必须在这里：`raw` 已到手；且早于下面的"返回修改"判定 ——
      //   返回时下标回退、旧记录会被重答覆盖，正好保持"一轮一条"。
      history[index] = {
        round: index + 1,
        header: question.header ?? '',
        question: question.question ?? '',
        raw,
        source: question.promptSource ?? 'fixed',
      }
      if (raw === BACK_SENTINEL) {
        if (index === 0) {
          steps.push({ topic: question.topic, note: '已是第一题，无处可返' })
          continue
        }
        index -= 1
        // ⚠️ 不要引用 `draftQuestions` 的返回值：方案 B 后循环里只取一题，
        //    那个列表已不再存在（写 `questions[index]` 会抛 ReferenceError）。
        steps.push({ topic: question.topic, note: `返回重答「${askedQuestions[index]?.topic ?? '上一题'}」` })
        continue
      }

      // ★ 答案落库（2026-09-23 改）：分两路，因为第 2 题收的是**三段式一条文本**。
      //
      //   多选题的答案必须保留**完整 selected 数组** —— 早先用 `answerValue()`
      //   （自由文本优先、否则 `join('、')`）会让两项被拼成一项、再被逗号拆开，
      //   于是"最多选 N 个"与"自定义项"双双失真（实测踩过）。这条不是新问题，
      //   但改动这段时必须照着它写，否则会以同样的方式回归。
      let candidateAnswer
      let probe
      if (question.multiSelect === true) {
        // ★ 2026-09-28：多选题（第 3 题，以及改造后的第 4/5/6/7 题）统一走这条 ——
        //   保留**完整 selected 数组**，再并入自定义输入（按常见分隔符拆开）。
        //   `validateAnswers` 的 single() 会把数组用「、」连接，故下游无需感知数组。
        const picked = (asked.answers[0]?.selected ?? []).filter(item => item !== SKIP_OPTION.label)
        const custom = (asked.answers[0]?.custom ?? '')
          .split(/[,，、;；]/u).map(item => item.trim()).filter(item => item !== '')
        candidateAnswer = [...picked, ...custom]
        probe = { ...answers, [question.topic]: candidateAnswer }
        // 兴趣题另走数组语义（归一化里对它单独处理）；两者按下标一致，故此处不合并。
      } else if (question.topic === 'vocation') {
        // 三参数拆分：只填一段时**只当职业**，其余保持未知（在 preset.mjs 的
        // `parseThreePart` 里实现，规则只有那一处）。
        const three = parseThreePart(raw)
        const skipLabels = new Set([SKIP_OPTION.label, '暂不透露'])
        const asField = value => (value === null || skipLabels.has(String(value)) ? '' : value)
        candidateAnswer = three.vocation ?? ''
        probe = {
          ...answers,
          vocation: asField(three.vocation),
          audience: asField(three.audience),
          expectation: asField(three.expectation),
        }
      } else {
        candidateAnswer = raw
        probe = { ...answers, [question.topic]: candidateAnswer }
      }
      const validated = validateAnswers(probe, { usedNames: [...presetRoster.names].filter(name => name !== answers.name) })
      const ownError = validated.errors.find(error => error.topic === question.topic)

      if (ownError !== undefined) {
        // 校验失败**不往下走**：把错误作为下一轮的建议选项回问，而不是替用户决定。
        steps.push({ topic: question.topic, note: `校验失败：${ownError.code}` })
        const retry = {
          ...question,
          detail: `⚠️ ${ownError.message}（上一轮的答案没有被采用）`,
          options: [{ label: CANCEL_SENTINEL, description: '不创建任何东西' }, ...(question.options ?? [])],
        }
        const again = await ask([retry], request.signal, hooks)
        if (again.kind === 'cancelled') {
          await store.session.write({ flow: 'init', phase: 'aborted', step: question.topic, answers })
          return {
            ok: false, code: 'FLOW_CANCELLED', step: question.topic,
            message: `已在「${question.header}」取消（校验失败后取消）。已完成 ${index} / ${TOTAL_ROUNDS} 题，未创建任何文件。`,
            completed: index, answers,
          }
        }
        const retryRaw = answerValue(again.answers[0])
        // ★ 重试分支必须与首次落库**同形状**：第 2 题是三段式、兴趣题是多选数组。
        //   早先这里只处理 interests 且丢了 `custom`，于是"重试"与"首次"两条路
        //   对同一份输入给出不同结果 —— 这类不对称是流程类缺陷的高发处。
        let retryProbe
        if (question.multiSelect === true) {
          retryProbe = {
            ...answers,
            interests: [
              ...(again.answers[0]?.selected ?? []).filter(item => item !== SKIP_OPTION.label),
              ...(again.answers[0]?.custom ?? '').split(/[,，、;；]/u).map(item => item.trim()).filter(item => item !== ''),
            ],
          }
        } else if (question.topic === 'vocation') {
          const retryThree = parseThreePart(retryRaw)
          const retrySkip = new Set([SKIP_OPTION.label, '暂不透露'])
          const retryField = value => (value === null || retrySkip.has(String(value)) ? '' : value)
          retryProbe = {
            ...answers,
            vocation: retryField(retryThree.vocation),
            audience: retryField(retryThree.audience),
            expectation: retryField(retryThree.expectation),
          }
        } else {
          retryProbe = { ...answers, [question.topic]: retryRaw }
        }
        const retryValidated = validateAnswers(retryProbe, {
          usedNames: [...presetRoster.names].filter(name => name !== answers.name),
        })
        const stillBad = retryValidated.errors.find(error => error.topic === question.topic)
        if (stillBad !== undefined) {
          return {
            ok: false, code: 'INVALID_ANSWER', step: question.topic,
            message: `${stillBad.message}请重新进入「初始预设」再试；没有创建任何文件。`,
            completed: index, answers,
          }
        }
        Object.assign(answers, retryValidated.normalized.values)
        index += 1
        continue
      }

      Object.assign(answers, validated.normalized.values)
      if (question.topic !== 'name') {
        answers[`unknown_${question.topic}`] = validated.normalized.unknown[question.topic] === true
      }
      steps.push({ topic: question.topic, note: raw === '' ? '跳过（保持未知）' : '已记录' })
      index += 1
    }

    const finalValidation = validateAnswers(answers, { usedNames: [] })
    const normalized = finalValidation.normalized
    // ★ id 判据必须含**名册里的 id**：ASCII 名字会直接取 slug 当 id
    //   （`presetIdFromName`），用户起名 `alpha`／`beta` 时若名册里看不到这些 id，
    //   就会生成一个重复的 `config.id` ⇒ 同批声明加载失败（本轮复检抓到的硬风险）。
    const usedIds = new Set([...(await store.known.read()).presetIds, ...presetRoster.ids])
    const presetId = presetIdFromName(normalized.values.name, usedIds)
    return await finalize({ store, target, normalized, presetId, presetRoster, roster, request, history })
  }

  /**
   * 「预览 → 确认 → 创建」的共用收尾。
   *
   * 抽出来的理由不是好看，而是**幂等**：第二步必须复用第一步落盘的答案，
   * 而不是把人再问一遍七题 —— 后者会让"重试"变成"又走一遍问答"。
   */
  async function finalize({ store, target, normalized, presetId, presetRoster, roster, request, history = [] }) {
    const preview = renderPreview(normalized, {
      presetId: presetId ?? presetIdFromName(normalized.values.name, []),
      workspaceRoot: target.workspace,
      dirs: directories,
    })
    const resolvedPresetId = presetId ?? preview.presetId

    await store.session.write({
      flow: 'init', phase: 'awaitingReview', step: 'confirm',
      answers: normalized.values, presetId: resolvedPresetId, preview,
    })

    // ── 主题地图（2026-09-28）：预览阶段生成**草案**，人看见才落盘 ──────────
    // ★ 为什么在预览阶段生成：让 AI 推出来的东西**先过人的眼**。
    //   本插件最重要的边界是「用户认可 ≠ 已事实验证」，主题地图虽不是知识，
    //   但同样不该在人没看见的情况下写进他的工作区。
    // ★ 降级：模型不可用/超时 ⇒ 返回空地图，框架保持旧骨架（零破坏）。
    if (request.confirmCreate !== true) {
      // ★ 主题地图在此生成（而不是在 finalize 开头）：写门禁与 id 判重都已在前面返回，
      //    走到这里才值得花一次模型调用 —— 否则"门禁关闭"时也会白烧一次。
      const draftTopicMap = await subjectFor({ answers: normalized.values, history })
      // ★ 生成后**回写会话**：确认创建时要复用"他刚才在预览里看到的那份地图"。
      //   早先这里漏了回写，于是会话里存的始终是不含地图的旧预览 ⇒ 确认时
      //   复原出空地图 ⇒ 框架又变回空骨架（整条特性静默失效，且不报错）。
      await store.session.write({
        flow: 'init', phase: 'awaitingReview', step: 'confirm',
        answers: normalized.values, presetId: resolvedPresetId,
        preview: { ...preview, topicMap: draftTopicMap },
      })
      return {
        ok: true,
        stage: 'preview',
        preview: {
          ...preview,
          topicMap: draftTopicMap,
          topicMapAvailable: (draftTopicMap?.directions ?? []).length > 0,
        },
        answers: normalized.values,
        decisions: [],
        roster: rosterDigest(roster),
        message: (draftTopicMap?.directions ?? []).length > 0
          ? '以上是画像摘要、「主题地图」草案与拟建路径。确认后才会创建；'
            + '主题地图若不合你意，可以先「返回修改」再重来（它是草案，不是结论）。'
          : '以上是画像摘要与拟建路径。确认后才会创建；也可以返回修改任何一题。',
        canRevise: true,
      }
    }
    if (!writeEnabled) {
      return {
        ok: false,
        code: 'WRITE_DISABLED',
        message: '写门禁关闭（allowWrite: false），已展示预览但未创建任何文件。',
        preview,
      }
    }

    // ★ 二次闸（纵深防御）：`presetIdFromName` 已经避开名册 id，这里再断言一次。
    //   真要撞上说明判据本身坏了 —— 那就不出件，绝不写一个重复的 `config.id`。
    if (presetRoster !== undefined && presetRoster.ids.has(resolvedPresetId)) {
      return {
        ok: false,
        code: 'PRESET_ID_TAKEN',
        message: `预设 id「${resolvedPresetId}」已被宿主名册占用 —— 重复的 preset ID 会导致声明加载失败，`
          + '本次不创建任何预设文件（工作区框架也未改动）。',
        preview,
        roster: rosterDigest(roster),
      }
    }

    // ★ 复用预览阶段已生成并**回写**的地图：避免二次调用模型，也保证
    //   "落盘的内容 ＝ 他刚才在预览里看到的那份"。
    //   ⚠️ 不能引用 `draftTopicMap` —— 它定义在预览分支内，这里不在其作用域。
    const persistedReview = await store.session.read()
    const topicMapForScaffold = persistedReview?.preview?.topicMap ?? { directions: [], total: 0 }
    const scaffold = await scaffoldWorkspace({
      workspace: target.workspace,
      dirs: directories,
      answers: normalized,
      topicMap: topicMapForScaffold,
      mkdir: path => nodeMkdir(path, { recursive: true }),
    })
    const preset = await createPreset({
      presetRoot: presetRootFor(target.workspace),
      presetId: resolvedPresetId,
      displayName: normalized.values.name,
      answers: normalized,
    })
    // ★ 只写盘不算预设存在 —— 但**安装这一步不由本插件代做**：
    //   安装会在 Host 进程执行新代码（官方 SKILL 明写 "requires Full access or
    //   approval"，`plugin_manager` 工具为此强制 danger-full-access 审批），
    //   而服务方法 `installBundle()` 本身**没有审批闸** ⇒ 插件直接调＝替用户越权。
    //   故这里只**出指引**（命令 / 工具 / 复核 / 撤销），把点头的动作留给人。
    const install = preset.ok
      ? describeInstall(preset.directory, resolvedPresetId)
      : { attempted: false, ok: false, code: 'NOT_CREATED', message: '预设未创建成功，无安装指引' }
    if (preset.ok) {
      // 预设提示词属**行为规则**：默认不开（allowBehaviorRules: false）时仍写入known记录，
      // 因为创建预设本身是在生成"未生效"的规则，真正生效要用户在新会话里选它。
      await store.known.add({ presetNames: [normalized.values.name], presetIds: [resolvedPresetId] })
    }
    await store.session.clear()

    const verified = await verifyPreset(preset.directory, resolvedPresetId)
    return {
      ok: true,
      stage: 'created',
      preview,
      scaffold: {
        created: scaffold.created,
        skipped: scaffold.skipped,
        conflicts: scaffold.conflicts,
        decisions: scaffold.decisions,
      },
      preset: {
        ok: preset.ok,
        code: preset.code ?? null,
        message: preset.message ?? null,
        presetId: resolvedPresetId,
        directory: preset.directory,
        decisions: preset.decisions,
        install,
      },
      verification: verified,
      roster: rosterDigest(roster),
      message: preset.ok
        ? `预设 bundle 已生成：${preset.directory}（**尚未安装**）。`
          + `安装（二选一，都要过审批）：① 终端跑一行 \`${install.command}\`；`
          + '② 在「创造模式」会话里让 Agent 用 `plugin_manager`（action=install_bundle，target=该目录）。'
          + `装完**新建会话**并选择「${normalized.values.name}」——`
          + '预设在一个进程内按 standing scope 挂载一次，**不会**在当前会话即时生效。'
          + `⚠️ ${install.caution}`
        : '工作区框架已就绪，但预设未创建成功（见 preset.message）。',
    }
  }

  /**
   * 出安装指引（**不安装**）。
   *
   * ★ 为什么本插件不代做：安装会在 **Host 进程**执行新代码。同一动作的官方入口
   *   `plugin_manager` 工具**强制**弹 `danger-full-access` 审批
   *   （`plugin-manager/src/tools.ts:34-41`），而服务方法 `installBundle()`
   *   **本身没有审批闸**（`plugin-manager/src/index.ts:461-462`，`@Remote`）—— 插件直接调它
   *   等于**替用户越权**。故这里只返回"怎么装"，把点头的动作留给人。
   * @param {string} directory bundle 目录（绝对路径）
   * @param {string} presetId 预设 id
   * @returns {object} 指引
   */
  function describeInstall(directory, presetId) {
    const instructions = installInstructions({ directory, presetId })
    return {
      attempted: false,
      ok: false,              // 未安装就是未安装：**不假装成功**
      code: 'MANUAL_INSTALL',
      requiresApproval: true,
      directory,
      ...instructions,
      message: '已生成 bundle（两件套）；**尚未安装** —— 安装会在 Host 进程执行新代码，必须由你批准。',
    }
  }

  /**
   * 装预设进 profile —— 「界面一键」的宿主侧实现。
   *
   * 人工触发区·install-on-click（发布契约 `verify-package.mjs` ⑥-b 的锚点标记）：
   * 本函数是**唯一**被允许出现 `installBundle` 调用的地方。标记在上、调用在下，
   * 判据据此把"有人点过才装"与"生成路径自动装"分开 —— 契约原文见该脚本 ⑥-b。
   * ⚠️ 不要移动这段标记，也不要在别的函数里新增 installBundle 调用（会让 verify 转红）。
   *
   * ★ 为什么这件事必须由**人点一下**才发生（方案 A′ 的边界）：
   *   安装 bundle 会在 Host 进程执行新代码。官方入口 `plugin_manager` 工具为此
   *   **强制**弹 `danger-full-access` 审批（`plugin-manager/src/tools.ts:38-42`），
   *   而 `installBundle()` **服务方法本身没有审批闸**（`plugin-manager/src/index.ts:461-462`）。
   *   所以本动作**只在用户按下界面的「安装预设」按钮时**执行 ——
   *   那一次点击就是审批动作，且按钮文案写明"会在宿主进程执行新代码"。
   *   本插件**绝不**在生成后自动安装（自动安装＝绕过人的点头）。
   *
   * ★ 本动作只做"替人把 ID 与路径算清楚"这一件事：用户不需要知道 preset id、
   *   不需要知道 profile 名、不需要开终端 —— 那三步正是原先手工流程的痛点。
   * @param {object} request 请求
   * @param {string} request.sessionId 会话 id
   * @param {string} [request.presetId] 要安装的预设 id（缺省时从会话记录推断）
   * @param {string} [request.requestId] 安装请求 id（供取消）
   * @returns {Promise<object>} 结果（含需否重启）
   */
  async function installPreset(request = {}) {
    const target = await resolveTarget(request.sessionId)
    if (target.workspace === null || target.workspace === undefined) {
      return { ok: false, code: 'NO_WORKSPACE', message: '当前会话没有绑定工作区，无法定位预设 bundle。' }
    }
    const store = storesFor(target.workspace)

    // ★ 只装"本插件刚刚生成过"的那个 bundle：known.json 里有记录才认。
    //   凭据来自磁盘记录，不是"目录碰巧存在" —— 免得把用户手放的任何目录装进 profile。
    const known = await store.known.read()
    const presetId = request.presetId ?? known.presetIds[known.presetIds.length - 1]
    const presetName = known.presetNames[known.presetNames.length - 1] ?? presetId ?? ''
    if (presetId === undefined || presetId === null || presetId === '') {
      return { ok: false, code: 'NO_PRESET', message: '本工作区还没有生成过预设。请先跑「初始预设」并确认创建。' }
    }
    if (!known.presetIds.includes(presetId)) {
      return {
        ok: false,
        code: 'PRESET_NOT_OURS',
        message: `预设 id「${presetId}」不在本工作区的生成记录里，拒绝安装（本插件只装自己生成过的 bundle）。`,
      }
    }

    const directory = `${presetRootFor(target.workspace)}/${presetId}`
    const manifestText = await readText(`${directory}/package.json`)
    if (manifestText === undefined) {
      return {
        ok: false,
        code: 'BUNDLE_MISSING',
        message: `找不到 bundle 清单：${directory}/package.json —— 该目录被删或被移走了（请不要移动它）。`,
        directory,
      }
    }
    let name
    try {
      name = JSON.parse(manifestText).name
    } catch {
      name = undefined
    }
    // 包名形状自证：不正常就退回手工指引，不把一个可疑 spec 交给 pnpm。
    if (typeof name !== 'string' || !name.startsWith('@local/dsh-learn-preset-')) {
      return manualInstall(directory, presetId, presetName, `bundle 清单里的包名不正常：${String(name)}`)
    }

    const fallback = reason => manualInstall(directory, presetId, presetName, reason)

    // 宿主平面的插件管理器。取不到就**如实降级**为手工指引，不假装能装。
    // ⚠️ 安装互斥：**必须是本函数自己的状态**。
    //   早先这里写的是 `running.get('install')` —— 那个 Map 属于 `rpc.mjs` 的
    //   `registerLearnRpc`，在 flows 作用域里根本不存在，于是"人工点击才装"这条
    //   路径一走到这里就 `ReferenceError: running is not defined`（被真机测试抓出，
    //   而"服务缺席降级"那条路径在更早处就返回了，所以它当时照绿 —— 假绿）。
    let installing = false

    let manager
    try {
      manager = typeof options.ctx?.get === 'function' ? options.ctx.get('pluginManager') : undefined
      if (manager === undefined || manager === null) manager = options.ctx?.pluginManager
    } catch {
      manager = undefined
    }
    if (typeof manager?.installBundle !== 'function') {
      return fallback('宿主没有把 pluginManager 服务解析给插件（本部署可能未装 dsh-plugin-manager）')
    }

    if (installing) {
      return { ok: false, code: 'ALREADY_RUNNING', message: '已有一个安装动作在执行，请等它结束。' }
    }
    installing = true
    try {
      const spec = `link:${String(directory).replace(/\\/gu, '/')}`
      const installResult = await manager.installBundle(spec, { requestId: request.requestId })
      if (installResult?.application === 'cancelled') {
        return { ok: false, code: 'INSTALL_CANCELLED', message: '安装已取消；profile 未改动。', directory, command: spec }
      }
      if (installResult?.application === 'failed') {
        return {
          ok: false,
          code: 'INSTALL_FAILED',
          message: `安装失败：${installResult?.error?.message ?? '原因未明'}。可用下面这条命令在终端重试。`,
          directory,
          command: `dsh plugin --profile web add "${spec}"`,
          details: installResult?.error ?? {},
        }
      }
      // ★ 如实区分"已生效"与"需重启"：新包的声明行进不了当前 namebook
      //   （`plugin-manager/src/index.ts:561` 对首次安装的包返回 'restart-required'）。
      //   把这一步说反，用户就会得到"装了却选不到"的二次误判。
      const needsRestart = installResult?.application !== 'applied'
      return {
        ok: true,
        stage: 'installed',
        presetId,
        presetName,
        bundle: installResult?.bundle ?? name,
        directory,
        application: installResult?.application ?? 'restart-required',
        changed: installResult?.changed === true,
        warnings: installResult?.warnings ?? [],
        needsRestart,
        message: needsRestart
          ? `预设「${presetName}」已装入 profile（bundle：${installResult?.bundle ?? name}）—— **需要重启一次**：`
            + '新装的 bundle 声明只在宿主启动时读取，重启后新建会话即可选到它。'
          : `预设「${presetName}」已装入 profile，且已在当前进程生效：新建会话即可选到它。`,
        nextStep: needsRestart
          ? '关掉 DSH 后重新打开，然后**新建会话**并在预设列表里选择它。'
          : '**新建会话**并在预设列表里选择它。',
      }
    } catch (error) {
      log('warn', `安装预设失败：${String(error?.message ?? error)}`)
      return {
        ok: false,
        code: 'INSTALL_FAILED',
        message: `安装失败：${String(error?.message ?? error)}。可用下面这条命令在终端重试。`,
        directory,
        command: `dsh plugin --profile web add "link:${String(directory).replace(/\\/gu, '/')}"`,
      }
    } finally {
      installing = false
    }
  }

  /**
   * 降级：出手工安装指引（**不假装成功**）。
   *
   * 什么时候走这里：服务取不到 / bundle 清单坏了。这时仍然把"要跑哪一行"
   * 完整给出（含绝对路径），人复制粘贴即可 —— 比让他自己去翻目录名强。
   * @param {string} directory bundle 目录
   * @param {string|undefined} presetId 预设 id
   * @param {string} presetName 预设显示名
   * @param {string} reason 降级原因（会如实展示）
   * @returns {object} 结果
   */
  function manualInstall(directory, presetId, presetName, reason) {
    const instructions = installInstructions({ directory, presetId: presetId ?? '' })
    return {
      ...instructions,
      ok: false,
      code: 'MANUAL_INSTALL',
      presetId,
      presetName,
      needsRestart: true,
      reason,
      message: `未能通过插件服务自动安装（${reason}）—— 可用下面这条命令在终端安装，装完重启一次。`,
    }
  }

  /** 预设创建后的自证：bundle 两件套齐备，且声明里真有插件行。 */
  async function verifyPreset(directory, presetId) {
    // ★ 官方 SKILL 原文："exactly two files"。2.1.0 起不再产出 `AGENTS.md`
    //   （新架构的指令面里没有"预设目录"这个概念 —— 那个文件没有消费者）。
    const files = ['package.json', 'cordis.patch.yml']
    const found = []
    const missing = []
    for (const file of files) {
      const text = await readText(`${directory}/${file}`)
      if (text === undefined) missing.push(file)
      else found.push({ file, bytes: Buffer.byteLength(text, 'utf8') })
    }
    const patch = await readText(`${directory}/cordis.patch.yml`)
    // `- id:` 命中声明行自身 + 各插件行，减 1 得插件行数。
    const counted = patch === undefined ? 0 : (patch.match(/^\s*-\s*id:/gmu) ?? []).length - 1
    const rows = counted < 0 ? 0 : counted
    return {
      presetId,
      directory,
      found,
      missing,
      rows,
      // 只做"结构有效"判定；"已进名册"由**你是否安装**＋选择器共同证明（本插件不代装）。
      structurallyValid: missing.length === 0 && rows > 0,
      note: '结构自证通过 ≠ 宿主已发现：先按指引安装该 bundle，再新建会话确认预设出现在选择列表里。',
    }
  }

  // ── 入口 2：收集提炼 ──────────────────────────────────────────────────

  /**
   * 从当前会话产出候选知识（**不写正式知识、不改预设、不改 AGENTS.md**）。
   * @param {object} request 请求
   * @param {string} request.sessionId 会话 id
   * @param {AbortSignal} [request.signal] 取消信号
   * @param {object} [request.hooks] 进度钩子
   * @returns {Promise<object>} 结果
   */
  async function distill(request) {
    // 同上：把会话 id 并进 hooks，供 `ask()` 取 live agent。
    const hooks = { ...request.hooks, sessionId: request.sessionId }
    const target = await resolveTarget(request.sessionId)
    if (target.workspace === null || target.workspace === undefined) {
      return { ok: false, code: 'NO_WORKSPACE', message: '当前会话未绑定工作区，无处存放候选。' }
    }
    const store = storesFor(target.workspace)

    // ── 并发防线（两道，各有分工）────────────────────────────────────────
    // ① 会话状态闸：进入时若已有流程在跑 → 立刻明确拒绝（不排队，见 SessionStore）。
    // ② 文件锁：**只包住真正的写入段**，不包住等人回答的那几分钟。
    //    把锁跨在 `ask()` 上会让"锁超时"变成用户在长达数分钟的问答里
    //    任何其它操作的报错原因 —— 那是把工具缺陷伪装成人机交互问题。
    const running = await store.session.read()
    if (running !== undefined && running.phase === 'collecting') {
      return {
        ok: false,
        code: 'FLOW_RUNNING',
        message: `已有学习流程正在运行（${running.flow} · ${running.step ?? '进行中'}）。`
          + '请先取消它，或等它结束再启动新的流程。',
        running,
      }
    }
    // 先落断点：界面据此显示"某流程正在运行"，并发点击者据此被明确拒绝。
    await store.session.open('distill', { step: 'collect', answers: {} })

    const prepared = await withLock(`${target.workspace}/${directories.stateDir}/flow.lock`, async () => {
      const ledger = await store.batches.read()
      const range = fixRange(target.messages, {
        limit: limits.maxMessages,
        highWaterSeq: request.highWaterSeq,
        historyComplete: target.historyComplete,
      })
      // ⚠️ `loadNodes` 返回值是 `{ nodes, skipped }`，**不是数组**。
      //    这一行曾经漏改，于是 `relateToNodes(candidates, {nodes,skipped})` 拿到一个
      //    非数组 ⇒ 关联**静默为空** ⇒ 后续"按 id 配对"当然找不到 ⇒ 全判成"新增"。
      //    静默是这个式子最坏的地方：它不报错，只是把关系变没。
      const { nodes } = await loadNodes(target.workspace)
      const batch = await store.batches.openBatch('distill', {
        sessionId: target.sessionId,
        range: range.range,
        complete: range.complete,
        limitations: range.limitations,
      })
      const extracted = extractCandidates(range.items, {
        batchId: batch.batchId,
        existing: ledger.seen,
        candidateId,
        maxCandidates: 60,
      })
      const deduped = dedupeCandidates(extracted.candidates)
      relateToNodes(deduped.candidates, nodes)

      // ── 语义增强（方案 B-1：双轨并存 + 冲突标记）─────────────────────────
      // ⚠️ **默认关闭**（`allowModelSemantics: false`）：打开后会把**会话原文**
      //    发给模型。数据出站属合规红线（须合规负责人裁断），故必须由人显式开启。
      // 降级纪律：任何失败（无模型 / 超时 / 输出不合格 / 超预算）都**不抛错** ——
      //    候选照常产出，只是缺了语义那一轨。
      let semantic = { enabled: false }
      if (config.allowModelSemantics === true && deduped.candidates.length > 0) {
        const semanticResult = await generateSemanticSuggestions({
          ctx: options.ctx,
          candidates: deduped.candidates,
          nodes,
          batchSize: config.semanticBatchSize,
          budgetMs: config.semanticBudgetMs,
          signal: request.signal,
        })
        semantic = mergeSemanticSuggestions(deduped.candidates, semanticResult.suggestions, {
          calls: semanticResult.calls,
          considered: semanticResult.considered,
          stopped: semanticResult.stopped,
          reason: semanticResult.reason ?? null,
        }).summary
        if (semanticResult.ok !== true) {
          log('info', `语义增强未生效，已全部回退基线轨：${String(semanticResult.reason ?? '未给出原因')}`)
        } else {
          log('info', `语义增强已生效：${semanticResult.calls} 次调用、${semanticResult.suggestions.length} 条建议`
            + `（类型分歧 ${semantic.typeDivergence} 处、关系分歧 ${semantic.relationsDivergence} 处）`)
        }
      } else if (config.allowModelSemantics !== true) {
        semantic = { enabled: false, reason: '语义增强未开启（allowModelSemantics: false）' }
      }

      await writeBatchFile(target.workspace, batch.batchId, {
        version: 1,
        batchId: batch.batchId,
        createdAt: isoTimestamp(),
        sessionId: target.sessionId,
        range: range.range,
        complete: range.complete,
        limitations: range.limitations,
        stats: { ...extracted.stats, merged: deduped.merged, semantic },
        candidates: deduped.candidates,
        semantic,
      })
      await store.batches.markSeen(Object.fromEntries(
        deduped.candidates.map(candidate => [candidate.fingerprint, batch.batchId]),
      ))
      await store.batches.update(batch.batchId, {
        status: 'awaitingUpgrade',
        candidateCount: deduped.candidates.length,
      })
      // ★ 把语义摘要一并带回：界面要靠它如实展示"本次有没有语义增强、有几处分歧"。
      //   早先只带 stats，于是语义轨即使落盘了，界面上也无从显示。
      return { batch, range, candidates: deduped.candidates, stats: extracted.stats, semantic }
    })
    const { batch, range, candidates, stats } = prepared
    const semanticSummary = prepared.semantic ?? { enabled: false }

    // 逐条由用户裁决：保留 / 排除 / 修订 / 标待验证。分批进行，避免一屏几十条。
    const decided = await reviewCandidates({
      candidates, batchId: batch.batchId, signal: request.signal, hooks,
    })
    if (decided.kind === 'cancelled') {
      await store.batches.update(batch.batchId, { status: 'awaitingUpgrade', note: '用户中断裁决，可续办' })
      await store.session.write({
        flow: 'distill', phase: 'aborted', step: 'review',
        batchId: batch.batchId, note: '用户中断裁决，可续办',
      })
      return {
        ok: false,
        code: 'FLOW_CANCELLED',
        batchId: batch.batchId,
        message: `已在候选裁决阶段取消。批次 ${batch.batchId} 已保存，可稍后从「关联升级」续办；`
          + '正式知识、预设与 AGENTS.md 均未被改动。',
        candidates: candidates.length,
      }
    }

    await withLock(`${target.workspace}/${directories.stateDir}/flow.lock`, async () => {
      await writeBatchFile(target.workspace, batch.batchId, {
        version: 1,
        batchId: batch.batchId,
        createdAt: isoTimestamp(),
        sessionId: target.sessionId,
        range: range.range,
        complete: range.complete,
        limitations: range.limitations,
        stats,
        candidates: decided.candidates,
        reviewedAt: isoTimestamp(),
      })
    })
    await store.session.clear()

    return {
      ok: true,
      batchId: batch.batchId,
      complete: range.complete,
      range: range.range,
      limitations: range.limitations,
      stats,
      // ★ 语义轨字段必须在这里显式带出：本映射是**白名单式**的，漏一个字段
      //   界面上就少一列信息，而且不会有任何报错（静默丢数据）。
      semantic: semanticSummary,
      candidates: decided.candidates.map(candidate => ({
        id: candidate.id,
        title: candidate.title,
        type: candidate.type,
        typeSemantic: candidate.typeSemantic,
        typeDivergence: candidate.typeDivergence === true,
        typeWhy: candidate.typeWhy,
        decision: candidate.decision,
        verification: candidate.verification,
        relations: candidate.relations,
        relationsSemantic: candidate.relationsSemantic,
        relationsDivergence: candidate.relationsDivergence === true,
        alreadyProcessed: candidate.alreadyProcessed,
      })),
      kept: decided.candidates.filter(candidate => candidate.decision === DECISION.keep).length,
      excluded: decided.candidates.filter(candidate => candidate.decision === DECISION.exclude).length,
      message: `候选已生成（批次 ${batch.batchId}）。本阶段**没有**修改任何正式知识、预设或 AGENTS.md。`
        + '下一步请点「关联升级」做比对与写入审核。',
    }
  }

  /** 分批让用户裁决候选。 */
  async function reviewCandidates({ candidates, batchId, signal, hooks }) {
    const reviewed = []
    const actionable = candidates.filter(candidate => candidate.type !== 'noise')
    if (actionable.length === 0) return { kind: 'answered', candidates }

    const already = actionable.filter(candidate => candidate.alreadyProcessed !== null)
    const fresh = actionable.filter(candidate => candidate.alreadyProcessed === null)

    for (let offset = 0; offset < fresh.length; offset += 8) {
      const chunk = fresh.slice(offset, offset + 8)
      const questions = [{
        id: `review-${chunk[0].id}`,
        header: `候选裁决 ${offset + 1}–${Math.min(offset + 8, fresh.length)} / 共 ${fresh.length}`,
        question: chunk.map((candidate, index) => `${index + 1}. [${candidate.type}] ${candidate.summary.slice(0, 160)}`).join('\n'),
        detail: `批次 ${batchId}。请选出你**认可保留**的编号（可多选）；不选的按「排除」处理。`
          + '若其中有你暂时无法判断的，选「标记待验证」——待验证不等于已证实。',
        options: [
          { label: '全部保留' },
          ...chunk.map((candidate, index) => ({ label: `保留 ${index + 1}`, description: candidate.title.slice(0, 40) })),
          { label: '标记待验证（本轮不写知识）' },
          { label: SKIP_OPTION.label },
          { label: CANCEL_SENTINEL, description: '中断裁决；批次已保存，可续办' },
        ],
        multiSelect: true,
      }]
      const asked = await ask(questions, signal, hooks)
      if (asked.kind === 'cancelled') return { kind: 'cancelled', candidates }
      const selected = new Set(asked.answers[0]?.selected ?? [])
      const custom = answeredCustom(asked.answers[0])
      const all = selected.has('全部保留')
      const unverified = selected.has('标记待验证（本轮不写知识）') || selected.has(SKIP_OPTION.label)
      chunk.forEach((candidate, index) => {
        const keep = all || selected.has(`保留 ${index + 1}`) || (custom !== '' && custom.includes(String(index + 1)))
        reviewed.push({
          ...candidate,
          decision: keep ? DECISION.keep : DECISION.exclude,
          // ★ 用户点了保留 ≠ 已证实。verification 只在用户另外明确时才变，见下。
          verification: VERIFICATION.unverified,
          unverifiedFlag: unverified,
        })
      })
    }

    return {
      kind: 'answered',
      candidates: [...reviewed, ...already.map(candidate => ({
        ...candidate,
        decision: DECISION.keep,
        verification: VERIFICATION.unverified,
        note: `与批次 ${candidate.alreadyProcessed.batchId} 已处理过的内容相同（重复项，不重复创建）`,
      }))],
    }
  }

  function answeredCustom(answer) {
    return typeof answer?.custom === 'string' ? answer.custom : ''
  }

  // ── 入口 3：关联升级 ──────────────────────────────────────────────────

  /**
   * 读取未处理批次 → 与既有节点比对 → 分批审核 → 确认后写入。
   * @param {object} request 请求
   * @param {string} request.sessionId 会话 id
   * @param {string} [request.batchId] 指定批次；多批时必填
   * @param {AbortSignal} [request.signal] 取消信号
   * @param {boolean} [request.confirmWrite] 是否已获写入确认
   * @param {object} [request.hooks] 进度钩子
   * @returns {Promise<object>} 结果
   */
  async function upgrade(request) {
    // 同上：把会话 id 并进 hooks，供 `ask()` 取 live agent。
    const hooks = { ...request.hooks, sessionId: request.sessionId }
    const target = await resolveTarget(request.sessionId)
    if (target.workspace === null || target.workspace === undefined) {
      return { ok: false, code: 'NO_WORKSPACE', message: '当前会话未绑定工作区。' }
    }
    const store = storesFor(target.workspace)
    const pending = await store.batches.pending()
    const usable = []
    for (const batch of pending) {
      const file = await readBatchFile(target.workspace, batch.batchId)
      if (file !== undefined) usable.push({ batch, file })
    }
    if (usable.length === 0) {
      return {
        ok: false,
        code: 'NO_BATCH',
        message: '没有待处理的候选批次。请先点「收集提炼」产出一批候选。',
      }
    }
    let chosen = usable
    if (request.batchId !== undefined) {
      const found = usable.find(item => item.batch.batchId === request.batchId)
      if (found === undefined) {
        return { ok: false, code: 'UNKNOWN_BATCH', message: `找不到批次 ${request.batchId} 或它已处理完。` }
      }
      chosen = [found]
    } else if (usable.length > 1) {
      // 多批时不替用户挑：让他明确选。
      const asked = await ask([{
        id: 'pick-batch',
        header: '选择要处理的批次',
        question: '有多个待处理批次，请选择本次处理哪一个。',
        options: [
          ...usable.map(item => ({
            label: `批次 ${item.batch.batchId}`,
            description: `${item.batch.createdAt ?? ''} · ${item.file.candidates?.length ?? 0} 条候选`,
          })),
          { label: CANCEL_SENTINEL, description: '不处理' },
        ],
        multiSelect: false,
      }], request.signal, hooks)
      if (asked.kind === 'cancelled') {
        return { ok: false, code: 'FLOW_CANCELLED', message: '已取消；没有选择任何批次。' }
      }
      const label = (asked.answers[0]?.selected ?? [])[0] ?? ''
      const picked = usable.find(item => label.includes(item.batch.batchId))
      if (picked === undefined) return { ok: false, code: 'NO_BATCH', message: '没有选中有效批次。' }
      chosen = [picked]
    }

    const { nodes, skipped: unreadable } = await loadNodes(target.workspace)
    // ★ 写目标占用表：目录里"存在但我载入不了"的文件（典型：用户把手改的内容写成了
    //   没有 frontmatter 的散文）。判据必须是"这个路径上有没有我的历史写入"，
    //   而不是"它现在能不能被解析成节点" —— 否则下面 `classifyChange` 会另建新节点，
    //   表面看是"新增"，实质是**绕过拒绝覆盖**。
    //   顺序上先铺 skipped 再铺已载入节点：同名冲突时以能解析的那份为准。
    const occupancies = new Map()
    for (const item of unreadable) occupancies.set(item.relative, item)
    for (const node of nodes) occupancies.set(node.relative, { relative: node.relative, sha: node.sha, raw: node.raw })

    // ⚠️ 变更清单**必须在这里先定**（在重建确认之前）：`classifyChange` 要读占用表来判定
    //    "这个候选其实指向一个已存在、但载入不了的文件"。放到确认之后算，
    //    就会出现"确认界面上说新增、实际写成补充"这种自相矛盾。
    const changes = []
    for (const item of chosen) {
      for (const candidate of item.file.candidates ?? []) {
        if (candidate.decision !== DECISION.keep) continue
        changes.push(classifyChange(candidate, nodes, occupancies))
      }
    }

    // ★★ 缺内容节点：**总索引有记录、节点却载入不了**。
    //
    //   判据取"框架曾记过什么"而不是"现在能读出什么"：frontmatter 被手工改坏之后，
    //   唯一还记得它本该是哪个文件的就是总索引（那是插件自己写的，写的时候它还好好的）。
    //
    //   为什么要在**写入之前**处理：节点一旦恢复成可载入，指向它的候选就能按 id 落到
    //   那个文件上（而不是另算一个新文件名）。顺序反了会出现"清单与实际写入不一致"。
    const frameworkCurrent = await readText(`${target.workspace}/${directories.knowledge}/framework.md`)
    const missing = findMissingNodes({ frameworkText: frameworkCurrent, nodes, skipped: unreadable })
    // 只修"本轮真的有候选指向它"的那些，并且**只认总索引给的路径**。
    // 索引里躺着的陈年孤儿不在这里动手 —— 它们归体检点名（见 audit 的异常节点项）。
    const occupanciesByPath = new Map(unreadable.map(item => [item.relative, item]))
    const repairs = missing.filter(item => occupanciesByPath.has(item.relative))

    // 重建是**覆盖用户手改**的动作，必须显式确认后才做；默认不确认 ⇒ 行为与修复前一致。
    // 用宿主原生问答（与候选裁决同一条通道，界面无需新增分支）。
    // ⚠️ 选择集合声明在**外层**：下面算"真正重建哪些 / 哪些继续占着写目标"都要用它。
    //    写成内层 `const selected` 再在外面引用，就是一处 `xxx is not defined` ——
    //    这类错我在这个文件里已经犯过两次，所以这次把它提到外面。
    const repairSelection = new Set()
    let repairAnswered = false
    if (repairs.length > 0 && request.confirmWrite === true) {
      const asked = await ask([{
        id: 'repair-missing-nodes',
        header: '缺内容节点',
        question: repairs
          .map((item, index) => `${index + 1}. ${item.relative}\n   ${item.reason}\n   总索引记录：${item.id}`
            + `${item.indexed.title === null ? '' : ` · ${item.indexed.title}`}`
            + `${item.indexed.updated === null ? '' : ` · 更新于 ${item.indexed.updated}`}`)
          .join('\n\n'),
        detail: '这些文件在总索引里有记录，但当前载入不了（通常是手工编辑后 frontmatter 丢失）。'
          + '**重建**会按本插件的写入语义重写节点正文，当前文件内容会**原样存进变更日志**，'
          + '事后可用回滚完整取回。不重建则它们继续缺席于关联与体检。',
        options: [
          { label: '全部重建' },
          ...repairs.map((item, index) => ({ label: `重建 ${index + 1}`, description: item.relative })),
          { label: '本轮不动（保持现状）', description: '这些节点继续以"载入不了"的状态存在，本轮不写它们' },
          { label: CANCEL_SENTINEL, description: '中断本次升级；批次已保存，可续办' },
        ],
        multiSelect: true,
      }], request.signal, hooks)
      if (asked.kind === 'cancelled') {
        return { ok: false, code: 'FLOW_CANCELLED', batchId: null, message: '已取消；本轮没有写入任何内容。' }
      }
      repairAnswered = true
      for (const label of asked.answers[0]?.selected ?? []) repairSelection.add(label)
      const custom = answeredCustom(asked.answers[0])
      if (custom !== '') repairSelection.add(`__custom__${custom}`)
    }
    const wantsRepair = index => repairSelection.has('全部重建')
      || repairSelection.has(`重建 ${index + 1}`)
      || [...repairSelection].some(label => label.startsWith('__custom__') && label.slice(10).includes(String(index + 1)))
    /** 真正要重建的那部分（确认之后按选择筛）。 */
    const repairTargets = repairAnswered && !repairSelection.has('本轮不动（保持现状）')
      ? repairs.filter((_item, index) => wantsRepair(index))
      : []
    /** 未确认重建的缺内容节点：仍然占着写目标 ⇒ 保持"拒绝覆盖"，但报**被保护的那个文件**。 */
    const guardedPaths = new Map(
      repairs.filter(item => !repairTargets.some(target => target.relative === item.relative))
        .map(item => [item.relative, item]),
    )

    // ★ 把"缺内容节点"的目标路径**钉在总索引给出的那个文件上**。
    //   `classifyChange` 已按占用表尽量反查出真实路径，这里再钉一道：**总索引的路径是权威**。
    //   不钉的话，候选就可能被写进一个**算出来、磁盘上并不存在**的新文件名里，
    //   于是用户看到"拒绝覆盖：…-003-….md"，而那个文件根本不存在 —— 无从排查。
    const diverted = new Map(repairs.map(item => [item.id, item.relative]))
    for (const change of changes) {
      if (change.targetId !== null) continue
      for (const relation of change.candidate?.relations ?? []) {
        const hit = diverted.get(relation.id)
        if (hit === undefined) continue
        change.path = hit
        relation.source = { kind: 'broken-node', span: null }
        break
      }
    }

    // 诊断出口（测试专用，默认不启用）。
    // "按 id 找不到既有节点"这类问题，只有把**当时的内存视图**摊开才能定位 ——
    // 从外部看，'关联在、文件在、却判成新增' 的现象无法区分是哪一环断的。
    if (request.diagnose === true) {
      const nodeDirEntries = await readDirectory(`${target.workspace}/${directories.knowledge}/nodes`)
      // ⚠️ 写基线必须**在这里重新读一次**：写入段里那份 `writeBaselines` 声明在
      //    `withLock` 回调内部，作用域到不了诊断出口（实测报 `writeBaselines is not defined`，
      //    而堆栈指向的是一行看起来完全正常的 `filter`）。
      const recordedShas = (await store.known.read()).writeShas
      return {
        ok: true,
        stage: 'diagnose',
        nodes: nodes.map(node => ({ id: node.id, relative: node.relative, version: node.version })),
        // 把每个节点的**原始开头**也带上：id 是从 frontmatter 来的还是回退来的，一看便知。
        nodesRaw: await Promise.all(nodes.map(async node => ({
          relative: node.relative,
          head: (await readText(`${target.workspace}/${node.relative}`) ?? '').slice(0, 160),
        }))),
        candidates: chosen.flatMap(item => (item.file.candidates ?? []).map(candidate => ({
          id: candidate.id, decision: candidate.decision, relations: candidate.relations ?? null,
        }))),
        changes: changes.map(change => ({ candidateId: change.candidateId, relation: change.relation, targetId: change.targetId ?? null })),
        // ★ 原始目录清单 + 载入不了的那些文件。
        //   "文件在不在盘上"与"载入了没有"是两个不同的事实，诊断必须能分开看：
        //   少了这一栏，"判成新增"到底是"文件不存在"还是"文件存在但载入不了"只能靠猜。
        nodeFiles: nodeDirEntries.map(entry => `${entry.name}（${entry.size}B${entry.directory ? '，目录' : ''}）`),
        unloadable: unreadable.map(item => ({ relative: item.relative, reason: item.reason })),
        // ★ 写目标的取键过程也要摊开：闸门"没拦住"时，先要能分辨是
        //   ① 候选的 relations 里压根没有可反查的 id，还是 ② 反查到了路径却对不上写基线。
        //   这两者的修法完全不同，而只报"failed=[]"时它们长得一模一样。
        gateTrace: await Promise.all(changes.map(async change => {
          const existing = change.targetId === null || change.targetId === undefined
            ? undefined
            : nodes.find(node => node.id === change.targetId)
          const paths = candidatePaths({ change, existing, occupancies })
          return {
            candidateId: change.candidateId,
            relation: change.relation,
            relationIds: (change.candidate?.relations ?? []).map(item => item.id),
            // 分类阶段算出的目标路径（新建时是目录）与 operation —— `failed[].relative`
            // 最终取自 `change.path`，把它一并摊开，才算真正把这条链走完。
            classifiedPath: change.path,
            operation: change.operation,
            targetId: change.targetId ?? null,
            paths,
            recorded: paths.filter(path => Object.hasOwn(recordedShas, path)),
            fileExists: Object.fromEntries(await Promise.all(paths.map(async path => [
              path, (await readText(`${target.workspace}/${path}`)) !== undefined,
            ]))),
          }
        })),
      }
    }

    if (changes.length === 0) {
      return {
        ok: false,
        code: 'NOTHING_TO_DO',
        message: '所选批次里没有"保留"的候选，没有可写入的变更。',
      }
    }

    // ★ 分栏：普通知识与行为规则，必须分开确认。
    const knowledgeChanges = changes.filter(change => change.scope === 'knowledge')
    const ruleChanges = changes.filter(change => change.scope === 'rule')

    const noChange = knowledgeChanges.filter(change => change.relation === 'duplicate')
    const effective = knowledgeChanges.filter(change => change.relation !== 'duplicate')

    if (request.confirmWrite !== true) {
      return {
        ok: true,
        stage: 'review',
        batches: chosen.map(item => item.batch.batchId),
        changes: effective,
        duplicateCount: noChange.length,
        ruleChanges,
        requiresBehaviorRuleApproval: ruleChanges.length > 0,
        message: '以上是最终变更清单（目标路径 / 操作 / 理由 / 影响范围）。确认后写入。'
          + (ruleChanges.length > 0
            ? '⚠️ 清单里含**行为规则**变更（预设提示词 / AGENTS.md / 技能），须单独确认。'
            : ''),
      }
    }

    if (!writeEnabled) {
      return { ok: false, code: 'WRITE_DISABLED', message: '写门禁关闭（allowWrite: false），未写入任何内容。', changes: effective }
    }
    if (ruleChanges.length > 0 && !behaviorRulesEnabled) {
      return {
        ok: false,
        code: 'RULE_WRITE_DISABLED',
        message: '清单里含行为规则变更，但 allowBehaviorRules 未开启（默认 false）。'
          + '行为规则改动会影响 Agent 的行为，须显式放行后再执行；本次只写普通知识。',
        changes: effective,
        ruleChanges,
      }
    }

    const batchId = `U${dateStamp()}-${fingerprint(changes.map(change => change.candidateId).join(',')).slice(0, 4)}`
    const journal = await openJournal(`${target.workspace}/${directories.stateDir}`, batchId, {
      intent: 'upgrade',
      workspace: target.workspace,
    })

    // 写段取文件锁：只在真正动磁盘的这几百毫秒里互斥，不与人的审阅时间耦合。
    const outcome = await withLock(`${target.workspace}/${directories.stateDir}/flow.lock`, async () => {
      await journal.begin(batchId, { intent: 'upgrade', workspace: target.workspace })
      // ★ 写基线：本插件上次写进每个文件的指纹。判"期间被改过"靠它，不靠"刚读到的那份"。
      const writeBaselines = (await store.known.read()).writeShas
      const done = []
      const failed = []
      // 本次实际写下去的指纹（路径 → sha）；skip 的项不进这里，也不进已知账。
      const writtenShas = {}
      // ★ 先落**重建项**：把"缺内容节点"恢复成可载入的节点，再走候选写入。
      //   顺序在锁内、在候选写入之前 —— 因为重建只读磁盘实况、不依赖 nodes 内存视图的先后。
      if (repairTargets.length > 0) {
        try {
          const repaired = await repairMissingNodes({
            targets: repairTargets, workspace: target.workspace, dirs: directories, journal,
          })
          for (const item of repaired.done) {
            done.push(item)
            if (typeof item.sha === 'string' && item.sha !== '') writtenShas[item.relative] = item.sha
            const at = nodes.findIndex(node => node.id === item.node.id)
            if (at === -1) nodes.push(item.node)
            else nodes[at] = item.node
          }
          for (const item of repaired.failed) failed.push(item)
        } catch (error) {
          // 重建整段失败不该拖垮后面的候选写入：如实记进 failed，继续。
          failed.push({
            relative: repairTargets.map(item => item.relative).join('、'),
            reason: `重建缺内容节点失败：${String(error?.message ?? error)}`,
          })
        }
      }
      // 重建过的文件不再占"拒绝覆盖"的位；没重建的仍然占着（见 guardedPaths）。
      for (const target of repairTargets) occupancies.delete(target.relative)
      let indexWritten = false
      try {
        for (const change of [...effective, ...ruleChanges]) {
          if (request.signal?.aborted) {
            await journal.abort('用户取消')
            return { kind: 'cancelled', done, failed, writtenShas, total: effective.length + ruleChanges.length }
          }
          try {
            const result = await applyChange({
              change, workspace: target.workspace, dirs: directories, journal, nodes, writeBaselines, occupancies,
              guardedPaths,
            })
            done.push(result)
            if (typeof result.sha === 'string' && result.sha !== '') writtenShas[result.relative] = result.sha
            // 把刚写下的节点并回内存视图：同一批里若有多条候选指向同一节点，
            // 第二条必须看到第一条的结果，否则版本与正文会互相覆盖。
            if (result.node !== undefined) {
              const at = nodes.findIndex(node => node.id === result.node.id)
              if (at === -1) nodes.push(result.node)
              else nodes[at] = result.node
            }
            if (result.relative === `${directories.knowledge}/framework.md`) indexWritten = true
          } catch (error) {
            // 失败项要报**具体文件**。取值优先级刻意写成**闸门自己的判据优先**：
            //   ① `error.relative` —— 闸门抛错时随错误带出的那个路径（单一来源，最准）；
            //   ② `change.path` —— 兜底，但它**是可被下游改写的可变字段**（新节点文件名会写回它），
            //      实测出现过"理由写 001、回执记 003"的自相矛盾，所以不能让它优先。
            const attempted = String(change.path ?? '')
            const relative = error?.relative
              ?? (attempted.endsWith('/') ? undefined : attempted)
            failed.push({
              relative,
              reason: String(error?.message ?? error),
              refusedPath: error?.refusedPath ?? null,
              gateDecision: change.gateDecision ?? null,
            })
            log('warn', `写入失败：${relative ?? attempted} —— ${String(error?.message ?? error)}`)
          }
        }
        if (effective.length > 0 && !indexWritten) {
          try {
            const indexResult = await refreshFrameworkIndex({
              workspace: target.workspace, dirs: directories, journal, nodes,
            })
            done.push(indexResult)
          } catch (error) {
            failed.push({ relative: `${directories.knowledge}/framework.md`, reason: String(error?.message ?? error) })
          }
        }
        await journal.complete()
        for (const item of chosen) {
          await store.batches.update(item.batch.batchId, { status: 'done', upgradedAt: isoTimestamp(), upgradeBatchId: batchId })
        }
        // ★ 写基线只记**真正写成功**的那些（`writtenShas` 由回执汇总而来）：
        //   记成"打算写的"会让 skip 与失败项凭空获得一个磁盘上不存在的指纹。
        await store.known.add({
          nodeIds: done.filter(item => item.nodeId !== undefined).map(item => item.nodeId),
          writeShas: writtenShas,
        })
        return { kind: 'done', done, failed }
      } catch (error) {
        await journal.abort(String(error?.message ?? error))
        return { kind: 'failed', done, failed, error: String(error?.message ?? error) }
      }
    })

    if (outcome.kind === 'cancelled') {
      return {
        ok: false,
        code: 'FLOW_CANCELLED',
        batchId,
        message: `已取消。已完成 ${outcome.done.length} 项，未完成 ${outcome.total - outcome.done.length} 项；`
          + `变更批次 ${batchId} 可回滚（回滚不会覆盖你此后新增的修改）。`,
        done: outcome.done,
        failed: outcome.failed,
      }
    }
    if (outcome.kind === 'failed') {
      return {
        ok: false,
        code: 'WRITE_FAILED',
        batchId,
        message: `写入中断：${outcome.error}。已完成 ${outcome.done.length} 项，未完成 ${outcome.failed.length} 项。`
          + `变更批次 ${batchId} 的日志已落盘，可回滚。**本次未全部成功**。`,
        done: outcome.done,
        failed: outcome.failed,
      }
    }

    const { done, failed } = outcome
    return {
      ok: true,
      batchId,
      stage: 'written',
      done,
      failed,
      skipped: noChange.map(change => ({ relative: change.path, reason: '与既有节点内容相同，跳过（版本未递增）' })),
      message: failed.length === 0
        ? `全部 ${done.length} 项写入完成并已回读校验。变更批次 ${batchId}（可回滚）。`
        : `部分成功：${done.length} 项完成，${failed.length} 项失败（见 failed）。变更批次 ${batchId}（可回滚）。`,
    }
  }

  /** 判定候选与既有节点的关系。 */
  function classifyChange(candidate, nodes, occupancies) {
    const matchById = candidate.relations
      ?.map(relation => nodes.find(node => node.id === relation.id))
      .find(node => node !== undefined)
    const scope = candidate.type === 'procedure' || candidate.type === 'preference' ? 'knowledge' : 'knowledge'
    if (matchById === undefined) {
      // ★ 第二道保险：按 id 找不到，但**按 id 反查占用表**能找到文件（该文件存在却载入不了）。
      //   这种目标不能算"新增" —— 算"新增"就会另起一个文件名，把候选写进一个**新文件**，
      //   而用户手改的那个文件继续半死不活地躺着。
      //   判据只认"确有这个文件"，不改写任何内容；是否覆盖由下游闸门与重建确认决定。
      const occupied = pathsForNodeId(
        (candidate.relations ?? []).find(relation => relation.relation !== 'candidate')?.id
        ?? candidate.relations?.[0]?.id ?? '',
        occupancies,
      )
      if (occupied.length > 0) {
        // ★ 把**真实 id 也带上**（`targetId`）。只给路径不给 id，会在下游造成"两条路径"：
        //   `applyChange` 按 targetId 找不到既有节点 ⇒ 既按"新建"算出新文件名，
        //   又拿着这个既有路径当目标 —— 闸门与报错因此可能指向那个**算出来的新文件名**。
        //   给了 id，`planChange` 就能按 id 找到既有节点（若它已可载入）或明确知道它不存在。
        const occupiedId = (candidate.relations ?? []).find(relation => relation.id !== undefined)?.id
        return {
          candidateId: candidate.id,
          scope,
          relation: candidate.type === 'correction' ? 'correction' : 'supplement',
          path: occupied[0],
          operation: occupiedId === undefined ? 'create' : 'update',
          reason: `补充既有节点（该文件已存在，但当前载入不了：${occupied[0]}）`,
          impact: '更新该文件（内容实际变化才递增 version），并更新总索引',
          candidate,
          targetId: occupiedId ?? null,
          previousSha: occupancies?.get(occupied[0])?.sha ?? null,
        }
      }
      return {
        candidateId: candidate.id,
        scope,
        relation: candidate.unverifiedFlag === true ? 'unverified' : 'new',
        path: `${directories.knowledge}/nodes/`,
        operation: 'create',
        reason: candidate.unverifiedFlag === true ? '新增（标记待验证）' : '新增：既有节点里没有对应内容',
        impact: '新增一个知识节点，并更新总索引',
        candidate,
        targetId: null,
      }
    }
    const sameContent = matchById.body.trim() === candidate.summary.trim()
    if (sameContent) {
      return {
        candidateId: candidate.id, scope, relation: 'duplicate', path: matchById.relative,
        operation: 'skip', reason: '与既有节点正文相同，判为重复', impact: '无（不写、不递增版本）',
        candidate, targetId: matchById.id,
      }
    }
    const contentMentionsOld = false
    return {
      candidateId: candidate.id,
      scope,
      relation: candidate.type === 'correction' ? 'correction' : (contentMentionsOld ? 'conflict' : 'supplement'),
      path: matchById.relative,
      operation: 'update',
      reason: candidate.type === 'correction'
        ? `修正既有节点「${matchById.title}」`
        : `补充既有节点「${matchById.title}」`,
      impact: `更新该节点（内容实际变化才递增 version），并更新总索引`,
      candidate,
      targetId: matchById.id,
      previousSha: matchById.sha,
    }
  }

  /**
   * 一条变更的落盘计划：既有节点 / 写入前内容 / 基线指纹，三样算一次、两处共用。
   * 与 `writeIfChanged` 的判据同源，避免"提前判"与"落地判"各判一套。
   */
  function planChange({ change, nodes, writeBaselines }) {
    const existing = change.targetId === null || change.targetId === undefined
      ? undefined
      : nodes.find(node => node.id === change.targetId)
    const beforeText = existing?.raw ?? null
    const currentSha = beforeText === null ? null : fingerprint(beforeText)
    // 既有节点看它自己的文件；新节点看变更清单给的目标路径。
    const lookupPath = existing?.relative ?? change.path
    // ★ 判据顺序：我方上次写入的指纹优先，其次是本次刚读到的那份。
    //
    //   `existing.sha` 是**本次升级开头**读到的内容 —— 用户若在那之前改过文件，
    //   它等于用户的内容，于是"基线对得上"，插件会**静默覆盖用户的手改**。
    //   实测症状：该发生的"拒绝覆盖"从没发生。写基线（`known.json` 的 `writeShas`）
    //   记的是"我方上次写进去的东西"，拿它对才能识别"这期间被别的东西改过"。
    const recorded = Object.hasOwn(writeBaselines, lookupPath)
    const recordedSha = recorded ? writeBaselines[lookupPath] : undefined
    const baselineSha = recorded ? recordedSha : existing?.sha ?? null
    // ⚠️ 返回**整个计划对象**，调用方**不要解构**。
    //
    //    这里字段有 7 个（existing / beforeText / currentSha / lookupPath / recorded /
    //    recordedSha / baselineSha），而下游那把闸门要同时用到 `recorded` 与 `currentSha`。
    //    先前用的是"逐个解构"，结果**连吃两次 `xxx is not defined`**（先漏 recordedSha、
    //    再漏 currentSha）：症状一律是"拒绝覆盖没生效"，真因却是一个没绑定的标识符。
    //    错的不是某一次笔误，而是**"这么多个字段靠人手对齐"这个形状本身** ——
    //    改成把计划整体传下去，就没有"对齐"这件事了。
    const plan = { existing, beforeText, currentSha, lookupPath, recorded, recordedSha, baselineSha }
    return plan
  }

  /**
   * 落地一条变更（先记 journal，再写文件）。
   * @param {object} options 依赖
   * @param {object} options.change 变更项
   * @param {string} options.workspace 工作区根
   * @param {object} options.dirs 目录配置
   * @param {object} options.journal 变更批次日志
   * @param {object[]} options.nodes 既有节点内存视图（同批内会回灌）
   * @param {Record<string, string>} options.writeBaselines 我方上次写入的指纹（`known.json`）
   * @returns {Promise<object>} 落地回执
   */
  async function applyChange({ change, workspace, dirs, journal, nodes, writeBaselines, occupancies, guardedPaths }) {
    if (change.operation === 'skip') {
      return { relative: change.path, action: 'skip', reason: change.reason }
    }
    // ⚠️ **整只取计划，不要解构**：字段有 7 个，而闸门要同时用 `recorded` 与 `currentSha`。
    //    先前"逐个解构"的写法连吃两次 `xxx is not defined`，症状都是"拒绝覆盖没生效"。
    //    去掉解构这一步，"手对齐多个字段"这件事就不存在了。
    const plan = planChange({ change, nodes, writeBaselines })
    const { existing, beforeText } = plan
    const usedIds = new Set([...(nodes.map(node => node.id)), ...(await storesFor(workspace).known.read()).nodeIds])
    const id = existing?.id ?? nextNodeId(dateStamp(), usedIds)
    const nextNode = {
      id,
      title: existing?.title ?? change.candidate.title,
      status: change.relation === 'unverified' || change.candidate.unverifiedFlag === true ? 'unverified' : 'active',
      version: existing === undefined ? 1 : existing.version,
      updated: isoDate(),
      tags: [...new Set([...(existing?.tags ?? []), change.candidate.type, ...change.candidate.relations?.map(item => item.relation) ?? []])].filter(tag => CANDIDATE_TYPES.includes(tag) === false || tag !== 'noise'),
      sources: [...new Set([...(existing?.sources ?? []), change.candidate.source.sessionId ?? 'unknown-session'])],
      links: mergeLinks(existing, change.candidate),
      body: existing === undefined
        ? `${change.candidate.summary}\n\n- 来源：会话 ${change.candidate.source.sessionId ?? '未知'}`
          + `${change.candidate.source.precision === 'message' ? ` · 消息 ${change.candidate.source.messageIds.join(', ')}` : ' · （无法精确定位到消息）'}`
          + `\n- 类型：${change.candidate.type}\n- 事实验证：未验证（用户认可 ≠ 已证实）`
        : `${existing.body.trimEnd()}\n\n## 更新（${isoDate()}）\n\n${change.candidate.summary}\n\n`
          + `- 变化原因：${change.reason}\n- 来源：会话 ${change.candidate.source.sessionId ?? '未知'}\n`
          + `- 事实验证：未验证\n`,
    }
    // 内容实际变化才递增版本；重试得到相同内容时版本保持不动。
    if (existing !== undefined && contentChanged(existing, nextNode)) {
      nextNode.version = existing.version + 1
    }

    const relative = existing?.relative ?? `${dirs.knowledge}/nodes/${id}.md`
    if (existing === undefined) {
      // 新节点：文件名带日期，便于人读。
      const fileName = `${id}-${slugOf(nextNode.title)}.md`
      change.path = `${dirs.knowledge}/nodes/${fileName}`
    }
    const absolute = `${workspace}/${change.path}`

    // ★ 闸门 0：分类为"新增"、但目标路径上**本来就有文件**（只是它载入不了）。
    //
    //   这是最容易漏的一条，而且必须**逐个可能路径**判：文件在盘上、我的写入记录也在，
    //   但它没有 frontmatter（用户手改成了散文）⇒ 载入时被跳过 ⇒ 按 id 找不到 ⇒
    //   判成"新增" ⇒ 直接另起一个新文件，**用户的改动被无声绕过**。
    //
    //   覆盖两种入口：候选清单给的路径（新建时还是目录，不算），以及**按节点 id 反查**
    //   出来的路径 —— 后者是"文件解析不出 id"时唯一能把它认回来的办法。
    //   判据一并要求"我确实在这个路径写过东西"：没有写入记录的陌生文件不拦
    //   （由 `writeIfChanged` 的"无基线即拒绝覆盖"兜住），避免把正常重写也拦死。
    if (existing === undefined) {
      // ⚠️ 一律**对象形参**调用（见 `candidatePaths` 的声明）：位置参数写法会让三个入参
      //    同时变 `undefined`、函数静默返回空数组 —— 闸门看起来装了，其实一条路径都没判。
      for (const path of candidatePaths({ change, existing, occupancies })) {
        // ⚠️ 本次**检出但用户选择不重建**的缺内容节点：必须保持拒绝。
        //    不能因为"上一次已经报过"就放行 —— 它仍然占着写目标、内容仍然是用户手改的。
        //    区别只在报错**指向被保护的那个文件**（不再指向一个算出来、磁盘上并不存在的路径）。
        const guarded = guardedPaths?.get(path)
        if (guarded !== undefined) {
          throw Object.assign(
            new Error(`拒绝覆盖：${path}（总索引里登记为 ${guarded.id}，但该文件当前载入不了 —— `
              + '本轮你选择了不重建。补回 frontmatter、或在下一次升级时选择"重建"；'
              + '本插件不会把手改内容静默并入节点）'),
            // ★ 把**被拒的那个路径**随错误一起带出来。
            //
            //   为什么：失败回执里的 `relative` 原先取自 `change.path`，而那是**可被下游改写的
            //   可变字段**（新节点的文件名会就地写回它）。实测出现过"理由里写着 001、
            //   回执却记成另一个算出来的文件名"这种自相矛盾 —— 同一条失败项里两个路径，
            //   读的人根本不知道该信哪个。
            //   正确做法是**让账目跟随闸门自己的判据**（单一来源），不跟随可变字段。
            { relative: path, refusedPath: path, refusedKind: 'guarded-missing-node' },
          )
        }
        if (!Object.hasOwn(writeBaselines, path)) continue
        const currentText = await readText(`${workspace}/${path}`)
        if (currentText === undefined) continue
        if (fingerprint(currentText) !== writeBaselines[path]) {
          throw Object.assign(
            new Error(`拒绝覆盖：${path}（该路径上有我上次写入的内容，而现在的内容与它不一致；`
              + '该文件当前可能没有可解析的 frontmatter，所以它不会被当成"新增"目标绕过；'
              + '要采纳这份改动请手工补回 frontmatter，或删除该文件让插件重建）'),
            { relative: path, refusedPath: path, refusedKind: 'baseline-mismatch' },
          )
        }
      }
    }
    // 检查点：只要这条变更存在"我写过的路径"，下面就**不许新建第三个文件**。
    //   走到这里还没抛，说明那些路径此刻的内容与我的写基线一致（不必拒绝）；
    //   但情况已经因为用户改文件而变了 —— 正确动作是**并入既有文件**（走写基线那条路），
    //   而不是另起一个新节点。实测中正是这一步把"拒绝覆盖"变成了"悄悄新建"。
    const ownedPaths = existing === undefined
      ? candidatePaths({ change, existing, occupancies }).filter(path => Object.hasOwn(writeBaselines, path))
      : []
    if (existing === undefined && ownedPaths.length > 0) {
      throw new Error(`拒绝覆盖：${ownedPaths.join('、')}（该路径已有我的写入记录，`
        + '但它此刻不能被解析成一个节点，所以插件无法安全地并入 —— '
        + '宁可如实报错，也不新建第三个文件把这次变更写成两份）')
    }
    // ★★ 闸门决定不拦时，把**作出这个决定的依据**记下来（放进 `change`，由外层汇总进 failed）。
    //
    //   为什么必须记在**写路径**里：诊断出口是另一遍调用，它的视图**不等于**写这一遍的视图。
    //   实测里出现过"诊断出口看得见 001、写这一遍却拦不住"的分裂 —— 逐帧打印才有定论，
    //   而我前面已经为此猜了三轮。这一栏的代价是几行对象，收益是**下一轮不必再猜**。
    change.gateDecision = {
      id,
      pathBefore: change.path,
      existingId: existing?.id ?? null,
      lookupPath: plan.lookupPath,
      recorded: plan.recorded,
      recordedSha: plan.recordedSha ?? null,
      currentSha: plan.currentSha ?? null,
      baselineSha: plan.baselineSha ?? null,
      candidates: candidatePaths({ change, existing, occupancies }),
      occupancyCount: occupancies?.size ?? null,
      writeBaselineCount: Object.keys(writeBaselines).length,
    }

    // ★ 闸门 1：动手之前先判：目标此刻的内容还等于**我方上次写入的那一份**吗？
    //
    //   等价的判据在 `writeIfChanged` 里也有一份（它会再判一次，作为最后一道闸），
    //   这里提前判是为了**不写 journal、不落盘**：拒绝覆盖不该留下半截变更记录。
    //   两条闸的判据故意同源（都是"我方上次写入的指纹"），不允许各判一套。
    if (existing !== undefined && plan.recorded && plan.recordedSha !== plan.currentSha) {
      throw new Error(`拒绝覆盖：${change.path}（内容与上次升级写入的不一致，期间被别的会话或工具改过；`
        + '要采纳这份改动请手工把它合进节点并保留 frontmatter，或删除该文件让插件重建）')
    }

    const content = renderNode(nextNode)
    await journal.plan({ relative: change.path, path: absolute, action: existing === undefined ? 'create' : 'update', beforeText })
    const decision = await writeIfChanged({
      absolute,
      relative: change.path,
      content,
      baselineSha: plan.baselineSha,
    })
    if (decision.action === 'conflict') {
      throw new Error(`拒绝覆盖：${change.path}（${decision.reason}）`)
    }
    await journal.settle(change.path, decision.afterSha ?? null)
    return {
      relative: change.path,
      action: decision.action,
      nodeId: id,
      version: nextNode.version,
      relation: change.relation,
      reason: change.reason,
      /**
       * 写基线回执：`null` 表示这次什么都没写（skip），不留基线。
       *
       * 刻意记**实际写下去的指纹**（`decision.afterSha`），不记"我打算写的" ——
       * 记意图的话，skip 会留下一个磁盘上不存在的指纹，下一次升级必然误判冲突。
       */
      sha: decision.action === 'skip' ? null : decision.afterSha ?? fingerprint(content),
      /** 回灌给调用方的内存视图（同一批里后续候选要用）。 */
      node: {
        id, title: nextNode.title, status: nextNode.status, version: nextNode.version,
        updated: nextNode.updated, tags: nextNode.tags, sources: nextNode.sources,
        links: nextNode.links, body: nextNode.body, relative: change.path,
        sha: decision.action === 'skip' ? fingerprint(beforeText ?? '') : decision.afterSha ?? fingerprint(content),
        raw: decision.action === 'skip' ? beforeText : content,
      },
    }
  }

  /**
   * 重建「缺内容节点」：把总索引有记录、但当前载入不了的文件恢复成可载入的节点。
   *
   * ★ 这是**唯一一条会覆盖用户手改内容**的写入路径，所以三条纪律都压在这里：
   *   ① 必须经用户**显式确认**才走到这里（确认在 `upgrade` 里做，未确认根本不会调用本函数）；
   *   ② **日志先落盘、再写文件** —— 原文件全文进 `journal.plan` 的 `beforeText`，
   *      于是 `rollback` 能把用户那段文字**原样取回**（不丢内容，只是换了存放位置）；
   *   ③ 正文按本插件既有语义构造（与"新增节点"一致），**不做文本合并** ——
   *      合并产出的结果难以复核，且会让"重建"变成一次需要人工 review 的改写。
   *
   * 元数据（id / 标题 / 状态 / 更新日）取**总索引那一行**：那是插件自己写的，
   * 也是这类文件唯一还留着的元数据来源。
   * @param {object} options 依赖
   * @param {object[]} options.targets 待重建项（`findMissingNodes` 的产物）
   * @param {string} options.workspace 工作区根
   * @param {object} options.dirs 目录配置
   * @param {object} options.journal 变更批次日志
   * @returns {Promise<{ done: object[], failed: object[] }>} 回执
   */
  async function repairMissingNodes({ targets, workspace, dirs, journal }) {
    const done = []
    const failed = []
    for (const target of targets) {
      const absolute = `${workspace}/${target.relative}`
      try {
        // 以磁盘**实况**为准：索引只是提示，文件此刻在不在、是什么内容，都要现读。
        const beforeText = (await readText(absolute)) ?? null
        // ★ 注意这条路径的授权边界在**用户确认**那一步（`upgrade` 里的确认问答），
        //   不在这里再判一次写基线：这个文件**恰恰是被用户改过**的（否则它不会载入不了），
        //   拿"我方上次写入的指纹"去比必然对不上，那会把唯一一条合法覆盖路径挡死。
        //   覆盖的代价由日志承担 —— 原文进 `journal`，`rollback` 可原样取回。
        const node = {
          id: target.id,
          title: target.indexed.title ?? target.relative.split('/').pop().replace(/\.md$/u, ''),
          status: target.indexed.status ?? 'active',
          version: 1,
          updated: isoDate(),
          tags: ['recovered'],
          sources: ['node-repair'],
          links: [],
          body: '本节点由「缺内容节点」重建恢复：总索引里仍记录着它，但文件已载入不了'
            + `（${target.reason}）。\n\n`
            + '- 重建原因：总索引有记录，文件载入不了（通常是手工编辑后 frontmatter 丢失）\n'
            + '- 被覆盖的原文：已原样存入本次变更日志，可用 `回滚` 取回\n',
        }
        const content = renderNode(node)
        await journal.plan({
          relative: target.relative, path: absolute,
          action: beforeText === null ? 'create' : 'update',
          beforeText,
        })
        // 基线定成**当前磁盘内容**：这条路径的语义就是"以现状为起点重写"，走 update 分支，
        // 不会被 `writeIfChanged` 的"基线对不上"挡下（授权已在用户确认那一步给过）。
        const decision = await writeIfChanged({
          absolute,
          relative: target.relative,
          content,
          baselineSha: beforeText === null ? null : fingerprint(beforeText),
        })
        if (decision.action === 'conflict') {
          failed.push({ relative: target.relative, reason: `拒绝覆盖：${decision.reason}` })
          continue
        }
        await journal.settle(target.relative, decision.afterSha ?? null)
        done.push({
          relative: target.relative,
          action: decision.action,
          nodeId: target.id,
          version: node.version,
          relation: 'repaired',
          reason: `重建缺内容节点（总索引有记录、文件载入不了）：${target.reason}`,
          sha: decision.action === 'skip' ? null : decision.afterSha ?? fingerprint(content),
          node: {
            id: node.id, title: node.title, status: node.status, version: node.version,
            updated: node.updated, tags: node.tags, sources: node.sources, links: node.links,
            body: node.body, relative: target.relative,
            sha: decision.afterSha ?? fingerprint(content), raw: content,
          },
        })
      } catch (error) {
        failed.push({ relative: target.relative, reason: `重建失败：${String(error?.message ?? error)}` })
      }
    }
    return { done, failed }
  }

  /** 关系维护：related 双向一致；有向关系写清方向。 */
  function mergeLinks(existing, candidate) {
    const links = [...(existing?.links ?? [])]
    for (const relation of candidate.relations ?? []) {
      if (relation.id === existing?.id) continue
      const entry = `${relation.relation}:${relation.id}`
      if (!links.includes(entry)) links.push(entry)
    }
    return links
  }

  /** 刷新总索引（唯一索引，必须与节点一致）。 */
  async function refreshFrameworkIndex({ workspace, dirs, journal, nodes }) {
    const relative = `${dirs.knowledge}/framework.md`
    const absolute = `${workspace}/${relative}`
    const current = await readText(absolute)
    const { body } = current === undefined ? { body: '' } : parseFrontmatter(current)
    const header = body.split('## 节点索引')[0] ?? ''
    const lines = [
      header.trimEnd(),
      '',
      '## 节点索引',
      '',
      '| 节点 id | 标题 | 状态 | 版本 | 更新日 | 来源 |',
      '|---|---|---|---|---|---|',
      ...nodes
        .filter(node => node.status !== 'archived')
        .map(node => `| ${node.id} | ${node.title} | ${node.status} | ${node.version} | ${node.updated ?? '—'} | ${node.relative} |`),
      '',
    ]
    const content = `${lines.join('\n')}\n`
    await journal.plan({ relative, path: absolute, action: current === undefined ? 'create' : 'update', beforeText: current ?? null })
    const decision = await writeIfChanged({
      absolute, relative, content,
      baselineSha: current === undefined ? null : fingerprint(current),
    })
    if (decision.action === 'conflict') throw new Error(`拒绝覆盖总索引：${decision.reason}`)
    await journal.settle(relative, decision.afterSha ?? null)
    return { relative, action: decision.action, reason: '刷新知识体系唯一总索引' }
  }

  // ── 入口 4：沉淀复用（只读体检）────────────────────────────────────────

  /**
   * 只读体检。**不修改任何被检查文件**。
   * @param {object} request 请求
   * @param {string} request.sessionId 会话 id
   * @param {object} [request.hooks] 进度钩子
   * @returns {Promise<object>} 报告
   */
  async function runAudit(request) {
    const target = await resolveTarget(request.sessionId)
    if (target.workspace === null || target.workspace === undefined) {
      return { ok: false, code: 'NO_WORKSPACE', message: '当前会话未绑定工作区，体检无处可扫。' }
    }
    const store = storesFor(target.workspace)
    // 只读体检**不取锁**：它会读几百个文件，把锁跨在读取段上只会制造无谓的超时。
    // 但如实告警"此刻有别的流程在跑，报告可能只反映某一瞬间"——这比悄悄给出
    // 一份自相矛盾的报告更诚实。
    const running = await store.session.read()
    const concurrentNote = running !== undefined && running.phase === 'collecting'
      ? `⚠️ 扫描期间检测到另一学习流程正在运行（${running.flow}）——本报告可能只反映某一瞬间的状态。`
      : null
    const collected = await collect({
      workspace: target.workspace,
      dirs: directories,
      maxFiles: limits.maxFiles,
      maxBytes: limits.maxBytes,
    })
    collected.workspace = target.workspace
    const baseline = await store.baseline.read()
    const result = audit({
      collected,
      baseline,
      context: { presetId: target.presetId, sessionId: target.sessionId },
    })
    const markdown = renderAuditReport(result, {
      workspaceLabel: baseOf(target.workspace) || '(工作区根)',
      generatedAt: isoTimestamp(),
      baselineAvailable: baseline !== undefined,
      extraNotice: concurrentNote,
    })
    // 报告本体也过一遍脱敏：体检读到的原文可能夹带凭据。
    const safe = redact(markdown, { absolutePaths: true })
    // 候选基线：**不含原文**，只有指纹与标题，因此可以安全落盘。
    const baselineCandidate = result.baseline
    return {
      ok: true,
      report: safe.text,
      redactionHits: safe.hits,
      baselineAvailable: baseline !== undefined,
      baselineCandidate,
      summary: {
        items: result.items.length,
        scannedFiles: result.scope.scannedFiles,
        warnings: result.warnings,
        delta: result.delta.summary,
        issues: result.items.find(item => item.id === 'issues')?.entries.length ?? 0,
      },
      message: baseline === undefined
        ? '首次使用：无历史基线，本次建立初始基线。'
        : '报告已生成（未写盘）。可选择「保存报告与对比基线」。',
    }
  }

  /**
   * 保存体检报告 + 基线。**只有两者都成功才更新基线**。
   * @param {object} request 请求
   * @param {string} request.sessionId 会话 id
   * @param {string} request.report 报告正文
   * @param {object} request.baselineCandidate 基线候选
   * @returns {Promise<object>} 结果
   */
  async function saveAudit(request) {
    const target = await resolveTarget(request.sessionId)
    if (target.workspace === null || target.workspace === undefined) {
      return { ok: false, code: 'NO_WORKSPACE', message: '当前会话未绑定工作区。' }
    }
    if (!writeEnabled) {
      return { ok: false, code: 'WRITE_DISABLED', message: '写门禁关闭，未保存报告。' }
    }
    const store = storesFor(target.workspace)
    const relative = `${directories.reports}/${isoDate()}-知识体系体检报告.md`
    const absolute = `${target.workspace}/${relative}`
    const existing = await readText(absolute)
    const content = existing === undefined
      ? request.report
      : `${existing.trimEnd()}\n\n---\n\n${request.report}`
    try {
      const decision = await writeIfChanged({
        absolute, relative, content,
        baselineSha: existing === undefined ? null : fingerprint(existing),
      })
      if (decision.action === 'conflict') {
        return { ok: false, code: 'CONFLICT', message: `报告路径已有他人改动，拒绝覆盖：${decision.reason}` }
      }
      // 报告成功之后才动基线 —— 顺序反了会留下"基线说报告在、磁盘上没有"的假成功。
      await store.baseline.save(request.baselineCandidate ?? {})
      return {
        ok: true,
        relative,
        action: decision.action,
        message: `报告已保存到 ${relative}，基线已更新（下次体检会与它对比）。`,
      }
    } catch (error) {
      return {
        ok: false,
        code: 'WRITE_FAILED',
        message: `保存失败：${String(error?.message ?? error)}。**基线未更新**，报告也未计入成功。`,
      }
    }
  }

  /**
   * 回滚一个变更批次。**不覆盖用户在此之后新增的修改**。
   * @param {object} request 请求
   * @param {string} request.sessionId 会话 id
   * @param {string} request.batchId 变更批次 id
   * @returns {Promise<object>} 结果
   */
  async function rollback(request) {
    const target = await resolveTarget(request.sessionId)
    if (target.workspace === null || target.workspace === undefined) {
      return { ok: false, code: 'NO_WORKSPACE', message: '当前会话未绑定工作区。' }
    }
    if (!writeEnabled) {
      return { ok: false, code: 'WRITE_DISABLED', message: '写门禁关闭，未执行回滚。' }
    }
    const stateDir = `${target.workspace}/${directories.stateDir}`
    const journal = await openJournal(stateDir, request.batchId)
    const record = await readJson(`${stateDir}/changes/${request.batchId}.json`)
    if (record === undefined) {
      return { ok: false, code: 'UNKNOWN_BATCH', message: `找不到变更批次 ${request.batchId} 的日志。` }
    }
    journal.entries = (record.entries ?? []).map(entry => ({
      relative: entry.relative,
      path: entry.path,
      action: entry.action,
      beforeSha: entry.beforeSha,
      beforeText: entry.beforeText,
      afterSha: entry.afterSha,
    }))
    const result = await journal.rollback()
    // ★ 撤销这些文件的写基线：回滚把内容还原成"本插件从未写过"的状态，
    //   还留着基线的话，下一次升级会拿一个对不上的指纹判冲突 ——
    //   文件明明是被自己回滚的，插件却说"被别的东西改过"，用户再也写不进去。
    //   只撤销**真的回滚成功**的那些：`skipped` 是"你改过，我没动"，基线必须留着。
    //
    //   路径要一并算上"按节点 id 可能落到的路径"：节点一旦缺了 frontmatter 就可能
    //   被改写成另一个文件名，只按日志里的原路径撤销会留下残留基线（那是下一颗雷）。
    const baselinePaths = [...new Set([
      ...result.restored,
      ...result.removed,
      ...(record.entries ?? []).map(entry => entry.relative),
    ].filter(path => typeof path === 'string' && path !== ''))]
    if (baselinePaths.length > 0) {
      await storesFor(target.workspace).known.forget({ paths: baselinePaths })
    }
    return {
      ok: true,
      batchId: request.batchId,
      restored: result.restored,
      removed: result.removed,
      skipped: result.skipped,
      message: `回滚完成：还原 ${result.restored.length} 项、删除 ${result.removed.length} 项、跳过 ${result.skipped.length} 项（跳过的项在你写入之后被改动过，本插件不覆盖）。`,
    }
  }

  /** 状态总览（界面加载时调用）。 */
  async function status(request) {
    const target = await resolveTarget(request.sessionId)
    if (target.workspace === null || target.workspace === undefined) {
      return {
        ok: false,
        code: 'NO_WORKSPACE',
        message: '当前会话没有绑定工作区。请先在输入区选择工作区，然后重新打开本菜单。',
        entries: ENTRIES,
      }
    }
    const store = storesFor(target.workspace)
    const initialized = nodeExists(`${target.workspace}/${directories.knowledge}/framework.md`)
      || nodeExists(`${target.workspace}/AGENTS.md`)
    const batches = await store.batches.pending()
    const baseline = await store.baseline.read()
    const presetRoot = presetRootFor(target.workspace)
    // 名册优先：它是**唯一权威来源**（一份组合包可声明多个预设）。
    // 名册取不到时退回扫目录 —— 只用于"显示一个大概的数"，**不用于判重**
    // （判重的闸在 `init`，拿不到名册就直接拒绝创建）。
    const roster = await readRoster()
    const fallback = roster.available
      ? null
      : await discoverPresetNames([
        presetRoot,
        // 历史目录式预设根：宿主已不再读取它，这里只让"数一数"别太离谱。
        `${homedir()}/.dsh/.agent-presets`,
        `${homedir()}/.agents/.agent-presets`,
      ])
    return {
      ok: true,
      workspace: '(工作区根)',
      workspaceBound: true,
      initialized,
      pendingBatches: batches.map(batch => ({ batchId: batch.batchId, createdAt: batch.createdAt, status: batch.status })),
      baselineAvailable: baseline !== undefined,
      baselineSavedAt: baseline?.savedAt ?? null,
      presetRoot,
      presetDir,
      presetCount: roster.available ? roster.ids.length : fallback.ids.size,
      rosterSource: roster.available ? 'agentPresets' : 'dir-fallback',
      rosterReason: roster.reason ?? null,
      brokenPresets: roster.broken,
      writeEnabled,
      behaviorRulesEnabled,
      entries: ENTRIES,
      version: options.version ?? '2.1.0',
    }
  }

  return { init, installPreset, distill, upgrade, runAudit, saveAudit, rollback, status, directories, presetDir, presetRootFor }
}

/**
 * 标题 → 文件名安全的 slug（中文退回短指纹，避免文件名全是问号）。
 *
 * **纯数字片段被丢掉**："Amazon Compliance 2026" → `amazon-compliance`。
 * 理由：年份/序号在文件名里只增噪音，而节点 id（`LN-20260917-001`）已经带日期。
 * 丢掉后若撞名，调用方仍有指纹兜底（见 `presetIdFromName` 的同款做法）。
 * @param {string} title 标题
 * @returns {string} 文件名 slug
 */
export function slugOf(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .split('-')
    .filter(segment => segment !== '' && !/^\d+$/u.test(segment))
    .join('-')
    .slice(0, 32)
    .replace(/^-+|-+$/gu, '')
  return slug === '' ? fingerprint(title).slice(0, 8) : slug
}
