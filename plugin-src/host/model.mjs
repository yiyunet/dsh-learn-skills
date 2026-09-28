/**
 * model.mjs —— 「由模型生成后续提问」的唯一实现点。
 *
 * 为什么单独成文件：这是本插件里**唯一一处会跨网络、耗不确定时间**的动作。
 * 把它独立出来，是为了让三件事都成为可测的纯函数，而不是散在流程里的偶发分支：
 *   ① 提示词装配（`buildMessages`）；
 *   ② 模型输出的**严格解析与校验**（`parseQuestionSpec` / `validateQuestionSpec`）；
 *   ③ 三参数自由文本的解析（`parseThreePart`）。
 * 只有 `generateQuestion` 一个函数碰 I/O。
 *
 * ── 三条设计纪律 ────────────────────────────────────────────────────────────
 *
 * ① **不进 `inject`**。`llm` / `agentDefaultModel` 一律 `ctx.get()` 可选获取。
 *    本插件自己的部署纪律写得很清楚（`index.mjs` 的 inject 注释 + `verify-package.mjs`
 *    ⑥ 的黑名单）：把可选能力写进 inject，会让插件在**缺该能力**的部署里**整体
 *    inactive** —— 而它本可以降级工作。模型是增强项，不是本插件的存在前提。
 *
 * ② **模型永远可以失败，且失败必须可降级**。超时、限流、无凭据、输出不是合
 *    法 JSON —— 每一种都归一成 `{ ok: false, reason }`，由调用方回退到硬编码池。
 *    「宁可不带，不带错」：这里绝不为了凑出结果而猜测或修补模型输出。
 *
 * ③ **一次性调用，不进会话历史**。宿主 `GenerateOptions.system` 的注释明写
 *    "System prompt text for one-shot callers"（`llm/src/types.ts:499-503`），
 *    这正是本条路径的官方姿势；因此**不带 `sessionId`**，也不套
 *    `markAgentLoopRequest`（那会给请求打上 agent-loop 身份，语义不对）。
 *
 * @module dsh-learn-skills/model
 */

/** 单次提问生成的时间上限。超时即降级，不让用户干等。 */
export const QUESTION_TIMEOUT_MS = 20000

/**
 * 模型路由诊断出口。
 *
 * ★ 只为**一次性定案**"真机上有没有 agentDefaultModel 服务"而存在 —— 此前三处
 *   推理（服务名、ctx 传递、装载顺序）都只能靠读源码猜。
 * ★ 测试环境**不写盘**：`node --test` 会注入 `NODE_TEST_CONTEXT`，不挡的话
 *   一次 `npm test` 就灌 200+ 条假记录，把诊断面淹掉（实测踩过）。
 * @param {object} ctx 宿主上下文
 * @param {string} line 记录内容
 */
function diagnoseRoute(ctx, line) {
  try {
    // 宿主日志出口：真机上能看到，且不落盘、不污染测试。
    ctx?.logger?.info?.(`[learn-skills][model] ${line}`)
  } catch {
    // 诊断失败不改行为
  }
  if (typeof process !== 'undefined' && process.env?.NODE_TEST_CONTEXT !== undefined) return
  void (async () => {
    try {
      const [{ appendFileSync, mkdirSync }, { homedir }] = await Promise.all([
        import('node:fs'),
        import('node:os'),
      ])
      const dir = `${homedir()}/.dsh`
      mkdirSync(dir, { recursive: true })
      appendFileSync(`${dir}/learn-skills-boot.log`, `[${new Date().toISOString()}] [route] ${line}\n`, 'utf8')
    } catch {
      // 同上
    }
  })()
}

/** 输出 token 上限：够一段 JSON（含可能的思考片段），防止模型跑长篇。 */
// ★ 2026-09-28 由 900 提到 1600：真机日志显示第 3/5/6/7 题全部「输出里找不到合法
//   JSON 对象」——首因嫌疑是**输出被截断**（900 在带 reasoning 的模型上偏紧）。
//   完整 JSON 约 300~500 token，留一倍余量给思考片段与围栏。
export const QUESTION_MAX_TOKENS = 1600

/**
 * 语义增强的批大小（方案 B-1）。
 *
 * ★ 为什么必须批量：提炼一次最多 60 条候选，逐条调用＝60 次；按 8 条/批＝最多 8 次。
 *   这是成本控制的命门，不是可选优化。
 */
export const SEMANTIC_BATCH_SIZE = 8

/** 语义增强单次调用的时间上限（比提问宽：一次要判 8 条 + 关系）。 */
export const SEMANTIC_TIMEOUT_MS = 45000

/** 语义增强的输出 token 上限（批量结果，需比单题宽）。 */
export const SEMANTIC_MAX_TOKENS = 2000

/**
 * 语义增强允许的关系判定。
 *
 * 比基线轨宽 —— 基线轨（词面重合）只会给 `candidate`；模型可以判到
 * `supplement` / `correction` / `conflict` 这类**有向语义关系**，这正是 B-1 的价值所在。
 */
export const SEMANTIC_RELATIONS = Object.freeze([
  'new', 'supplement', 'correction', 'duplicate', 'conflict', 'supersede', 'unverified',
])

/** 每轮生成的候选数上限（含用户自己的自由输入在内看，仍保持"少而准"）。 */
export const MAX_OPTIONS = 6

/** 每轮生成的候选数下限 —— 少于它视为不合格输出，降级处理。 */
export const MIN_OPTIONS = 3

/**
 * 可作为提问维度的话题池。
 *
 * 刻意**比六要素更宽**：模型要问的是"为了产出最优预设，下一步最缺什么信息"，
 * 而缺的未必是既有字段。宽池能让模型问出「最卡的一次是怎么卡的」这类题，
 * 再把它映射回 `baseline` / `goal` 等正式字段。
 *
 * ★ 2026-09 扩充（方案 B）：补入两个**能改变助手行为**的维度 ——
 *   · `trust`：**什么算可信依据**（用户认什么叫"这条成立"）。
 *     为什么必须有：预设正文里写着"结论附来源、无依据标推测"，却从没问过他
 *     认什么依据 —— 这是原先的一个黑洞。
 *   · `judge`：**取舍口径**（"更稳/更快/更省"他会怎么选）。
 *     为什么必须有：职责写的是"回答怎么学最稳最快最省"，但"稳/快/省"的排序
 *     是他的偏好，不是插件的 —— 不问就只能由插件替他假设。
 */
export const TOPIC_POOL = Object.freeze([
  'interests', 'goal', 'baseline', 'style', 'priority', 'constraint', 'scene', 'trust', 'judge',
])

/**
 * 提前收尾的最小轮数 —— 模型最早可以在这一轮之后喊停。
 *
 * 为什么要下限：没有它，模型可能在"职业/面向/期望"刚填完就判"信息已足够"，
 * 于是"AI 编排"退化成"三题流水线"，比固定七题还差。
 */
export const MIN_ROUNDS = 4

/** 轮数上限（与 `TOTAL_ROUNDS` 同口径；这里写死是为了让模型提示词可独立测）。 */
export const MAX_ROUNDS = 7

/** 正式画像字段（其余话题在归一化时并入这些字段）。 */
export const PROFILE_FIELDS = Object.freeze(['vocation', 'audience', 'expectation'])

/** 模型输出里不得出现的保留选项名（由导航层统一追加，避免重复项）。 */
const RESERVED_LABELS = Object.freeze(['暂不填写', '暂不透露', '← 返回修改前面的回答', '✕ 取消本次设置', '其他，请输入'])

/**
 * 话题 → 中文标签（画像说人话用）。
 *
 * 为什么要它：早先给模型的"已知信息"直接写内部键名（`- vocation：…`），
 * 等于把结构化数据倒给模型、指望它自己翻译。改成中文标签＋分组后，
 * 模型看到的就是一段**人话版画像**，推断质量立刻不同。
 */
export const TOPIC_LABELS_ZH = Object.freeze({
  name: '助手名字',
  vocation: '职业/身份',
  audience: '面向什么（人群或事情）',
  expectation: '期望达到什么',
  interests: '关注方向',
  goal: '学习目标与典型任务',
  baseline: '当前基础与主要困难',
  style: '学习方式与输出偏好',
  priority: '最想先解决的一件事',
  constraint: '限制条件',
  scene: '典型场景',
  trust: '什么算可信依据',
  judge: '取舍口径（更稳/更快/更省怎么选）',
})

/** 正式画像字段的展示顺序（未被 TOPIC_LABELS_ZH 覆盖的键回退成原键名）。 */
const PROFILE_ORDER = Object.freeze([
  'vocation', 'audience', 'expectation', 'interests', 'goal', 'baseline', 'style',
  'priority', 'constraint', 'scene', 'trust', 'judge',
])

/**
 * 把已采集的答案渲染成**给模型看的画像草稿**（纯函数）。
 *
 * 与 `buildMessages` 分开是因为它要被单测直接钉住 —— "画像必须是中文标签、
 * 必须剔除空值/未填项"这两条一旦回归，问题质量会静默下滑，只能靠测试守。
 * @param {object} answers 已采集答案（含 `unknown_*` 标记）
 * @returns {string[]} 每行一条的中文画像
 */
export function renderKnownProfile(answers) {
  const source = answers ?? {}
  const keys = [
    ...PROFILE_ORDER.filter(key => key in source),
    ...Object.keys(source).filter(key => !PROFILE_ORDER.includes(key)),
  ]
  const lines = []
  for (const key of keys) {
    // `unknown_*` 是归一化留下的标记位，不是画像内容 —— 单独成段，不混进画像。
    if (key.startsWith('unknown_')) continue
    const value = source[key]
    if (value === null || value === undefined || value === '') continue
    const text = Array.isArray(value) ? value.join('、') : String(value)
    if (text.trim() === '') continue
    lines.push(`- ${TOPIC_LABELS_ZH[key] ?? key}：${text}`)
  }
  return lines
}

/**
 * 问答历史 → 给模型看的对话回顾（纯函数）。
 *
 * ★ 这是方案 B 的核心修复点：早先的请求里**只有一条结构化 user 消息**，
 *   模型看不到自己上一轮问了什么、用户是怎么答的 —— 于是每一轮都是一次
 *   "无状态冷启动"，出题自然没有"接着上文"的连续性（真机体感：题目像模板）。
 * @param {{ round: number, header?: string, question?: string, raw?: string, source?: string }[]} history 历史轮次
 * @returns {string[]} 每行一轮的回顾
 */
export function renderHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return []
  const lines = []
  for (const entry of history) {
    if (entry === undefined || entry === null) continue
    const round = entry.round ?? '?'
    const header = entry.header ?? ''
    const question = entry.question ?? ''
    const raw = entry.raw === undefined || entry.raw === '' ? '（未作答/跳过）' : String(entry.raw)
    const source = entry.source === 'fallback' ? '（系统兜底题）' : ''
    lines.push(`第 ${round} 轮${header === '' ? '' : ` · ${header}`}${source}`)
    if (question !== '') lines.push(`  问：${question}`)
    lines.push(`  答：${raw}`)
  }
  return lines
}

/**
 * 读取模型路由。
 *
 * 来源是宿主服务 `agentDefaultModel.currentSelection()` —— 即**本机 profile 里
 * 会话正在用的那个默认模型**（本机实测：`deepseek-official` / `deepseek-flash`，
 * 见 `~/.dsh/profiles/web/cordis.patch.yml:53-58`），因此插件**不需要新增任何
 * 配置项**，也不会与用户在界面里切换的模型打架。
 *
 * 拿不到就如实报缺，**不猜一个模型名**：猜错会变成"每次提问都失败"，比降级更糟。
 *
 * @param {object} ctx 宿主上下文
 * @returns {{ ok: true, provider: string, model: string, reasoningEffort?: string }
 *   | { ok: false, reason: string }} 路由或缺失原因
 */
export function readModelRoute(ctx) {
  let service
  try {
    // ⚠️ `ctx.get()` 在服务缺席时**可能抛**（cordis 版本差异）—— 与 `rpc.mjs` 的
    //    `resolveConnection` 同一处理：两种取法都试，异常一律按"还没就绪"看。
    service = (typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined) ?? ctx?.agentDefaultModel
  } catch (error) {
    diagnoseRoute(ctx, `ctx.get('agentDefaultModel') 抛错：${String(error?.message ?? error)}`)
    return { ok: false, reason: `读取默认模型服务时抛错：${String(error?.message ?? error)}` }
  }
  if (service === undefined || service === null || typeof service.currentSelection !== 'function') {
    // ★ 这条留痕是为了**一次性定案**：真机上到底有没有这个服务。此前只能猜"服务名对不对"，
    //   现在把实际探测结果（has ctx.get / 两个取法各得到什么）写进日志。
    diagnoseRoute(ctx, `探测 agentDefaultModel：hasCtxGet=${typeof ctx?.get === 'function'}`
      + ` get结果=${service === undefined ? 'undefined' : typeof service}`
      + ` 属性结果=${typeof ctx?.agentDefaultModel}`
      + ` currentSelection=${typeof service?.currentSelection}`)
    return { ok: false, reason: '宿主未提供 agentDefaultModel（当前组合没有默认模型服务）' }
  }
  let selection
  try {
    selection = service.currentSelection()
  } catch (error) {
    return { ok: false, reason: `读取默认模型失败：${String(error?.message ?? error)}` }
  }
  const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : ''
  const model = typeof selection?.model === 'string' ? selection.model.trim() : ''
  if (provider === '' || model === '') {
    return { ok: false, reason: '默认模型未配置（provider / model 为空）' }
  }
  const reasoningEffort = typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort !== ''
    ? selection.reasoningEffort
    : undefined
  return { ok: true, provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
}

/**
 * 取模型调用入口。
 *
 * 形状校验刻意保守：只认同时具备 `stream` 的对象。宿主版本漂移时拿到的可能是
 * 别的东西，那种情况下**降级比抛错好**（降级还会再问用户，抛错会中断整个流程）。
 * @param {object} ctx 宿主上下文
 * @returns {{ stream: (options: object) => AsyncIterable<object> }|null} llm 服务或 null
 */
export function readLlm(ctx) {
  const service = (typeof ctx?.get === 'function' ? ctx.get('llm') : undefined) ?? ctx?.llm
  if (service === undefined || service === null || typeof service.stream !== 'function') return null
  return service
}

/**
 * 装配一次性调用的消息（方案 B 重写）。
 *
 * ★ 第一性原理（本函数的判据来源）：最终生效的预设 = 它注入给助手的那段正文。
 *   因此**一条信息的价值 = 它能在多大程度上消除"助手该怎么表现"的歧义**，
 *   而"填满字段"本身没有任何价值。旧版恰恰把目标写成了后者，于是模型即使被调用，
 *   也只能问出"任何人都能答"的泛题 —— 真机体感就是"问题没有目的性"。
 *
 * 为此这里给模型四样旧版没有的东西：
 *   ① `history` —— 上一轮问了什么、用户怎么答的（旧版是**无状态冷启动**）；
 *   ② `profileDraft` —— 中文标签的画像草稿（旧版直接倒英文键名）；
 *   ③ `bodyDraft` —— **预设正文的当前草稿**，让模型看见"我这题会改哪一句"；
 *   ④ `doneAllowed` —— 允许它判定"信息已足够"并提前收尾。
 * @param {object} options 入参
 * @param {object} [options.answers] 已采集的答案（值可为 null）
 * @param {string[]} [options.unknown] 已明确"未填写"的字段（旧入参，保留兼容）
 * @param {string[]} [options.unknownLabels] 已明确"未填写"的中文标签（优先）
 * @param {number} [options.round] 当前是第几轮（1 起）
 * @param {number} [options.total] 总轮数
 * @param {string[]} [options.usedTopics] 已经问过的话题
 * @param {object[]} [options.history] 问答历史（`renderHistory` 的入参形状）
 * @param {boolean} [options.doneAllowed] 本轮是否允许判定"已足够"提前收尾
 * @param {string} [options.bodyDraft] 预设正文当前草稿（模型据此判断填空题在哪）
 * @returns {{ system: string, messages: object[] }} 请求体
 */
export function buildMessages(options = {}) {
  const {
    answers, round = 0, total = MAX_ROUNDS, usedTopics,
    history, doneAllowed = false, bodyDraft,
  } = options
  const system = [
    '你在帮一个学习助手做「初始预设」访谈。',
    '',
    '## 你的目标（唯一目标，先看它）',
    '预设最终生效的形式，是它**注入给助手的正文**（见下方"预设正文草稿"）。',
    '所以一条信息的价值只有一个判据：**它能在多大程度上消除「助手该怎么表现」的歧义。**',
    '填满字段没有价值；能让助手更懂"该对他怎么说、该给他什么、该收在哪"才有价值。',
    '',
    '## 出题前先自答三句（不写出来，但必须想清楚）',
    '1. 这一题会改到正文里的**哪一句**？说不出来，就换一个维度。',
    '2. 用户会怎么答？如果他答什么**都不改变**助手的表现，这题就是废题。',
    '3. 现在最缺、最能让画像从"泛"变"准"的是哪一个维度？',
    '',
    '## 什么算好题 / 什么算废题',
    '- 好题：他的答案只能对应少数几种助手行为；换个用户答，答案会明显不同。',
    '- 废题：任何人都能答、答案不改变任何东西（「你想学好吗」「你希望更高效吗」之类）。',
    `- 候选必须互相有区分（${MIN_OPTIONS}~${MAX_OPTIONS} 个），紧扣下方"画像草稿"与"问答历史"；`,
    '  每个候选的 description 用一句话说明"他选这个意味着助手该怎么做"。',
    // ★ 2026-09-28：给出的题**支持多选**（他可选一个、多个或自己写）。
    //   这一条会改变候选的写法：应当给**可叠加**的选项，而不是互斥的单选。
    '- 这一题**支持多选**：请给"可以同时成立"的候选（例如同时卡在几处、偏好叠加），',
    '  不要给互斥选项；如果某一维度本质上只能选一个，就把题面写成问"最要紧的那个"。',
    '- 不要重复问"问答历史"里已经问过、并且已有答案的维度。',
    '',
    '## 输出要求（必须严格遵守）',
    '只输出一个 JSON 对象，不要解释、不要 markdown 代码围栏。',
    '出一道题时：',
    '{"topic":"维度标识","question":"题面","detail":"补充说明（可空）","options":[{"label":"候选","description":"为什么可能是这个"}]}',
    ...doneAllowed
      ? [
          doneAllowed
            ? '判定信息已足够、不必再问时：{"done":true,"reason":"为什么已经足够（一句话）"}'
            : '',
        ].filter(line => line !== '')
      : [],
    '',
    `- topic 必须从这些里选一个：${TOPIC_POOL.join(' / ')}`,
    '- 每项 description 用一句话说明"为什么这可能是他要的"。',
    `- 不要使用这些保留词作为选项：${RESERVED_LABELS.join('、')}（导航项由程序追加）。`,
    '- 不索要姓名、单位、联系方式等与学习无关的个人信息。',
    '- 全部用中文。',
    '',
    `这是第 ${round} / ${total} 轮提问，你**只能出一题**。`,
    doneAllowed
      ? '⚠️ 如果你已经能写出一段"对这位用户足够具体"的预设正文，就用 {"done":true} 收尾 —— '
        + '继续问没有增量的题，比早一点收尾更糟。'
      : `（第 ${MIN_ROUNDS} 轮起才允许提前收尾；现在请出题。）`,
    total - round > 0
      ? `后面还剩 ${total - round} 轮，所以这一题要挑"最缺、最能拉开区分度"的那个维度。`
      : '这是最后一轮，请挑最能补齐画像的那个维度。',
  ].join('\n')

  const known = renderKnownProfile(answers)
  const unknownLabels = Array.isArray(options.unknownLabels) && options.unknownLabels.length > 0
    ? options.unknownLabels
    : (Array.isArray(options.unknown) ? options.unknown.map(key => TOPIC_LABELS_ZH[key] ?? key) : [])

  const lines = [
    '## 画像草稿（已知信息）',
    ...(known.length > 0 ? known : ['（还没有任何已知信息 —— 这一题要负责开口）']),
  ]

  const historyLines = renderHistory(history)
  if (historyLines.length > 0) {
    lines.push(
      '',
      '## 问答历史（你已经问过什么、他是怎么答的 —— 接着上文往下问）',
      ...historyLines,
    )
  }

  if (unknownLabels.length > 0) {
    lines.push('', `用户**明确表示不填**的项：${unknownLabels.join('、')}（不要再追问这些）`)
  }
  if (Array.isArray(usedTopics) && usedTopics.length > 0) {
    // ⚠️ 调用方约定：`usedTopics` **由编排层翻译**（`preset.mjs` 的 `modelQuestion`
    //    会先映射成中文标签再传进来）。这里拿什么写什么，**不自己翻译** ——
    //    因为收进来的既可能是内部键名、也可能是已翻译的标签，函数无法可靠区分，
    //    硬加一层判断只会制造"翻译两遍"或"漏翻译"的新故障。
    lines.push('', `已经问过的话题：${usedTopics.join('、')}（不要重复问同一个维度）`)
  }
  if (typeof bodyDraft === 'string' && bodyDraft.trim() !== '') {
    lines.push(
      '',
      '## 预设正文草稿（你每一题都可能改到这里的一句话）',
      '```markdown',
      bodyDraft.trim(),
      '```',
      '找出这份草稿里"最空、最像套话"的那一句 —— 那就是这一题该补的地方。',
    )
  }
  lines.push('', '请输出那一题。')

  return {
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }],
  }
}

/**
 * 从模型输出里抠出 JSON 对象。
 *
 * 容忍两种常见污染：markdown 代码围栏、JSON 前后的客套话。
 * 但**不容忍结构不对** —— 抠不出来就是抠不出来，交给调用方降级。
 * @param {string} text 模型输出原文
 * @returns {object|null} 解析出的对象，或 null
 */
export function extractJsonObject(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const unfenced = raw.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()
  const candidates = [unfenced]
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // 换下一个候选；全都失败则返回 null。
    }
  }
  return null
}

/**
 * 严格校验一题模型输出。
 *
 * 为什么严格：模型输出是**不可信输入**。它会被拼进题面与选项直接展示给用户，
 * 所以长度、保留词、话题合法性、候选数量与去重都要在这里挡住。
 * 这里**不做任何"修补"**（例如替它补 topic、替它删掉重复项）——修补等于替模型
 * 做决定，出了偏差还查不出来。宁可判不合格、走硬编码兜底。
 * @param {unknown} parsed 已解析的对象
 * @returns {{ ok: true, spec: { topic: string, question: string, detail: string, options: { label: string, description: string }[] } }
 *   | { ok: false, reason: string }} 结果
 */
export function validateQuestionSpec(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '输出不是 JSON 对象' }
  }
  // ★ 提前收尾（方案 B）：模型判定"画像已足够"时输出 `{"done":true,"reason":"…"}`。
  //   为什么必须由模型来判：只有它同时看得见"画像草稿"和"预设正文草稿"，
  //   才知道哪一句还是套话、还值不值得再问一轮。
  //   护栏在调用方（`MIN_ROUNDS` 之前一律不认 done），不在这里 —— 这里只负责形状。
  if (parsed.done === true) {
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 200) : ''
    return { ok: true, done: true, reason }
  }
  const topic = typeof parsed.topic === 'string' ? parsed.topic.trim() : ''
  if (!TOPIC_POOL.includes(topic)) {
    return { ok: false, reason: `topic「${topic}」不在允许范围内` }
  }
  const question = typeof parsed.question === 'string' ? parsed.question.trim() : ''
  if (question === '') return { ok: false, reason: 'question 为空' }
  if (question.length > 200) return { ok: false, reason: `question 过长（${question.length} 字符）` }
  const detail = typeof parsed.detail === 'string' ? parsed.detail.trim().slice(0, 400) : ''

  if (!Array.isArray(parsed.options)) return { ok: false, reason: 'options 不是数组' }
  const options = []
  const seen = new Set()
  for (const item of parsed.options) {
    const label = typeof item?.label === 'string' ? item.label.trim() : ''
    if (label === '') continue
    if (label.length > 40) continue
    if (RESERVED_LABELS.includes(label)) continue
    if (seen.has(label)) continue
    seen.add(label)
    const description = typeof item?.description === 'string' ? item.description.trim().slice(0, 120) : ''
    options.push({ label, ...description === '' ? {} : { description } })
  }
  if (options.length < MIN_OPTIONS) {
    return { ok: false, reason: `有效候选只有 ${options.length} 个（少于 ${MIN_OPTIONS}）` }
  }
  return {
    ok: true,
    spec: {
      topic,
      question,
      detail,
      options: options.slice(0, MAX_OPTIONS),
    },
  }
}

/**
 * 把模型输出原文变成一题（解析 + 校验的合体，纯函数）。
 * @param {string} text 模型输出原文
 * @returns {{ ok: true, spec: object }|{ ok: false, reason: string }} 结果
 */
export function parseQuestionSpec(text) {
  const parsed = extractJsonObject(text)
  if (parsed === null) return { ok: false, reason: '输出里找不到合法 JSON 对象' }
  return validateQuestionSpec(parsed)
}

/**
 * 解析「职业 / 面向对象 / 期望」三段式自由文本。
 *
 * 分隔符容忍 `|`、`｜`、`/`、换行、`；`、`;`、`、`（用户在中文输入法下很容易打出全角符号）。
 * 只填一段时**只当职业**，其余保持未知 —— 这是本插件"未填写＝未知、不编造画像"
 * 那条纪律在解析层的体现：不把一段话硬拆成三段。
 *
 * @param {string|null|undefined} raw 原始输入
 * @returns {{ vocation: string|null, audience: string|null, expectation: string|null,
 *   parts: number }} 解析结果（空段为 null）
 */
export function parseThreePart(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { vocation: null, audience: null, expectation: null, parts: 0 }
  const segments = text
    .split(/[|｜/／\n;；]+/u)
    .map(item => item.trim())
    .filter(item => item !== '')
  const [first = null, second = null, third = null] = segments
  return {
    vocation: first,
    audience: second,
    expectation: third,
    parts: Math.min(segments.length, 3),
  }
}

/**
 * 汇总一次流：拼出文本、判断终止原因。
 *
 * 只认 `text-delta`（正文）与 `finish`（终止）。`reasoning-delta` 刻意**丢弃** ——
 * 推理过程不是答案，拼进去会污染 JSON 解析。
 * @param {AsyncIterable<object>} stream 宿主返回的块流
 * @returns {Promise<{ text: string, finish: object|null }>} 汇总结果
 */
export async function collectStream(stream) {
  const parts = []
  let finish = null
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      parts.push(chunk.text)
      continue
    }
    if (chunk.type === 'finish') finish = chunk.reason ?? null
  }
  return { text: parts.join(''), finish }
}

/**
 * 把一次模型调用的所有失败归一成一句话。
 * @param {object|null} finish 终止原因
 * @returns {string|null} 失败描述；正常结束返回 null
 */
export function describeFinish(finish) {
  if (finish === null || finish === undefined) return null
  if (finish.kind === 'error') {
    return `模型调用失败：${String(finish.failure?.code ?? finish.failure?.message ?? '未知错误')}`
  }
  if (finish.kind === 'aborted') return '模型调用被中止'
  return null
}

/**
 * 生成下一轮的提问（**唯一碰 I/O 的函数**）。
 *
 * 契约：**永不抛错**。任何异常都归一成 `{ ok: false, reason }`，让调用方回退到
 * 硬编码池 —— 提问流程的确定性不能被一次网络抖动带走。
 *
 * @param {object} options 入参
 * @param {object} options.ctx 宿主上下文
 * @param {object} options.answers 已采集答案
 * @param {string[]} [options.unknown] 已明确未填的字段
 * @param {number} options.round 当前轮次（1 起）
 * @param {number} options.total 总轮数
 * @param {string[]} [options.usedTopics] 已问过的话题
 * @param {AbortSignal} [options.signal] 用户取消信号
 * @param {number} [options.timeoutMs] 超时上限
 * @returns {Promise<{ ok: true, spec: object, source: 'model' }|{ ok: false, reason: string }>} 结果
 */
export async function generateQuestion(options) {
  const { ctx, answers, unknown, round, total, usedTopics, signal } = options
  const timeoutMs = options.timeoutMs ?? QUESTION_TIMEOUT_MS

  const route = readModelRoute(ctx)
  if (!route.ok) return { ok: false, reason: route.reason }
  const llm = readLlm(ctx)
  if (llm === null) return { ok: false, reason: '宿主未提供 llm 服务' }

  const { system, messages } = buildMessages({
    answers,
    unknown,
    round,
    total,
    usedTopics,
    // 方案 B 的三样新上下文与收尾开关：一律从 options 透传，缺省即旧行为。
    unknownLabels: options.unknownLabels,
    history: options.history,
    bodyDraft: options.bodyDraft,
    doneAllowed: options.doneAllowed === true,
  })

  // 超时与用户取消是两个独立来源，合成一个信号：
  // 任一触发都要让流停下来，否则超时之后模型还在烧 token。
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const onAbort = () => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) { clearTimeout(timer); return { ok: false, reason: '用户已取消' } }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const request = {
      provider: route.provider,
      model: route.model,
      system,
      messages,
      maxTokens: QUESTION_MAX_TOKENS,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
      signal: controller.signal,
    }
    const { text, finish } = await collectStream(llm.stream(request))
    const failure = describeFinish(finish)
    if (failure !== null) return { ok: false, reason: failure }
    const spec = parseQuestionSpec(text)
    if (!spec.ok) {
      return {
        ok: false,
        reason: `模型输出不合格：${spec.reason}`,
        // ★ 把原始输出片段带回上层：**没有它就无法判定**这次失败是
        //   「被截断」「模型话太多」「围栏格式怪」还是「真空输出」——
        //   2026-09-28 真机第 3/5/6/7 题连续失败时，正因为缺这个只能猜。
        rawText: text,
      }
    }
    // ★ 提前收尾要如实上报给编排层 —— 由它决定认不认（`MIN_ROUNDS` 护栏在那边）。
    if (spec.done === true) return { ok: true, done: true, reason: spec.reason ?? '', source: 'model' }
    return { ok: true, spec: spec.spec, source: 'model' }
  } catch (error) {
    return {
      ok: false,
      reason: timedOut
        ? `模型调用超时（${timeoutMs} ms）`
        : `模型调用异常：${String(error?.message ?? error)}`,
    }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

// ── 语义增强（方案 B-1：双轨并存 + 冲突标记）──────────────────────────────────

/** 语义轨允许的候选类型。与 `knowledge.mjs` 的 `CANDIDATE_TYPES` 同口径（那是权威表）。 */
const SEMANTIC_TYPES = Object.freeze([
  'fact', 'procedure', 'correction', 'preference', 'hypothesis', 'experience', 'unclassified',
])

/** 提示词里每条候选摘要的截断长度（控制请求体积）。 */
const SEMANTIC_SUMMARY_CHARS = 160

/** 提示词里带给模型的已有节点数上限（控制请求体积；多余节点不参与判定）。 */
const SEMANTIC_NODE_LIMIT = 40

/**
 * 装配「语义增强」的请求体（纯函数）。
 *
 * ★ 方案 B-1 的定位（必须写进提示词，否则模型会以为自己是裁决者）：
 *   模型是**提议者**，基线轨（正则/词面算法）是**可复现的对照**。两者不一致时
 *   由人在审核面板裁决 —— 模型不得假设自己的判定会直接入库。
 *
 * ★ 只判"类型 + 与已有节点的关系"，**不判**"该不该入库"：
 *   后者会碰「用户认可 ≠ 事实验证」这条硬纪律（`decision` 与 `verification` 永不互推）。
 *
 * @param {object} options 入参
 * @param {object[]} options.candidates 候选（用 `id` / `title` / `summary`）
 * @param {object[]} [options.nodes] 已有节点摘要（`{ id, title, tags }`）
 * @returns {{ system: string, messages: object[] }} 请求体
 */
export function buildSemanticMessages({ candidates, nodes }) {
  const list = Array.isArray(candidates) ? candidates : []
  const nodeList = (Array.isArray(nodes) ? nodes : []).slice(0, SEMANTIC_NODE_LIMIT)

  const system = [
    '你在帮一个「学习知识库」做**语义判定**。你只做两件事：',
    '① 判定每条候选属于什么类型；② 判定它与"已有节点"是什么关系。',
    '',
    '## 你的角色（务必理解）',
    '你给出的是**建议**，不是裁决。系统另有一条由关键词规则算出的"基线判定"，',
    '两条会**并存展示**给人审核 —— 不一致的地方会被人重点看。所以：',
    '- 不确定就选更保守的那个（`unclassified` / `new`），**不要为了显得聪明而硬判**；',
    '- 你的 `why` 要写"**依据哪几个字得出的**"，而不是"感觉像"——它要能被人当场核验。',
    '- 你不判断"这条该不该入库"——那是人的决定。',
    '',
    '## 类型（只能选一个）',
    '- fact：事实性陈述（可独立成立的论断）',
    '- procedure：可复用的操作步骤',
    '- correction：纠错结论（推翻或修正旧说法）',
    '- preference：偏好（他喜欢/习惯怎么做）',
    '- hypothesis：待验证假设（推测、不确定）',
    '- experience：实践经验（实测过、踩过坑）',
    '- unclassified：判不出来（**宁可这个，不要硬塞**）',
    '',
    '## 关系（只能从这七个里选）',
    `- ${SEMANTIC_RELATIONS.join(' / ')}`,
    '  · new＝与任何已有节点都无关　· duplicate＝与某个已有节点几乎同义',
    '  · supplement＝补充某个已有节点（同主题、增内容）　· correction＝修正某个已有节点',
    '  · conflict＝与某个已有节点矛盾（**这条最要紧，必须给 why**）',
    '  · supersede＝取代某个已有节点　· unverified＝关系存在但尚无法确认',
    '  · 每条的 relations 可为空数组（即 new），最多给 3 个。',
    '',
    '## 输出要求（严格遵守）',
    '只输出一个 JSON 数组，不要解释、不要 markdown 代码围栏。每项形如：',
    '{"id":"候选 id","type":"类型","relations":[{"id":"已有节点 id","relation":"关系","why":"依据"}],"why":"类型判定依据"}',
    '**必须覆盖给定的每一条候选**（没有关系的就给空 relations 且 type 照给）——漏掉的条目会被判为无效。',
  ].join('\n')

  const candidateLines = list.map(candidate => {
    const title = String(candidate?.title ?? '').slice(0, 60)
    const summary = String(candidate?.summary ?? '').replace(/\s+/gu, ' ').slice(0, SEMANTIC_SUMMARY_CHARS)
    return `- id=${candidate?.id ?? '?'} ｜ 标题：${title}\n  内容：${summary}`
  })
  const nodeLines = nodeList.length === 0
    ? ['（知识库里还没有节点 —— 所有候选都只能判 `new`）']
    : nodeList.map(node => `- id=${node?.id ?? '?'} ｜ ${String(node?.title ?? '').slice(0, 60)}`
      + `${Array.isArray(node?.tags) && node.tags.length > 0 ? ` ｜ 标签：${node.tags.join('、')}` : ''}`)

  const lines = [
    `## 待判定候选（共 ${list.length} 条，必须逐条给出判定）`,
    ...candidateLines,
    '',
    '## 已有节点（关系只能指向这里的 id）',
    ...nodeLines,
    '',
    '请输出那个 JSON 数组。',
  ]

  return {
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }],
  }
}

/**
 * 从模型输出里抠出 JSON **数组**（语义增强专用）。
 *
 * ★ 为什么不能复用 `extractJsonObject`：那个函数**只接受对象**
 *   （`Array.isArray(parsed)` 一律判否），而语义增强的提示词要求模型输出数组 ——
 *   复用它会**永远解析失败**，且失败得很安静（全部候选静默走基线轨）。
 * @param {string} text 模型输出原文
 * @returns {unknown[]|null} 解析出的数组，或 null
 */
export function extractJsonArray(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const unfenced = raw.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()
  const candidates = [unfenced]
  const first = unfenced.indexOf('[')
  const last = unfenced.lastIndexOf(']')
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // 换下一个候选；全都失败则返回 null。
    }
  }
  return null
}

/**
 * 严格校验「语义增强」输出（纯函数）。
 *
 * 与 `validateQuestionSpec` 同一纪律：**模型输出是不可信输入，一律严格校验，绝不修补**。
 * 不合格的**单条**被丢弃（不影响其它条），整体不合格则返回空建议 + 原因。
 *
 * @param {string} text 模型输出原文
 * @param {Set<string>|string[]} candidateIds 合法候选 id 集合
 * @returns {{ ok: boolean, suggestions: object[], reason?: string }} 结果
 */
export function validateSemanticSuggestions(text, candidateIds) {
  const allowed = candidateIds instanceof Set ? candidateIds : new Set(Array.isArray(candidateIds) ? candidateIds : [])
  // 先按数组解析（提示词要求的形状），再容忍 `{ suggestions: [...] }` 这种自作主张的包装。
  const asArray = extractJsonArray(text)
  const parsed = extractJsonObject(text)
  const raw = asArray ?? (parsed !== null && Array.isArray(parsed.suggestions) ? parsed.suggestions : null)
  if (raw === null) return { ok: false, suggestions: [], reason: '输出里找不到合法 JSON 数组（也不含 suggestions 数组）' }

  const suggestions = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    // 只认**我们问过的那批候选** —— 模型凭空编一个 id 一律丢弃。
    if (id === '' || !allowed.has(id)) continue
    const type = typeof item.type === 'string' && SEMANTIC_TYPES.includes(item.type.trim())
      ? item.type.trim()
      : null
    const relations = []
    if (Array.isArray(item.relations)) {
      for (const relation of item.relations) {
        if (relation === null || typeof relation !== 'object') continue
        const target = typeof relation.id === 'string' ? relation.id.trim() : ''
        const kind = typeof relation.relation === 'string' ? relation.relation.trim() : ''
        if (target === '' || !SEMANTIC_RELATIONS.includes(kind)) continue
        const why = typeof relation.why === 'string' ? relation.why.trim().slice(0, 200) : ''
        relations.push({ id: target, relation: kind, confidence: 'model', ...why === '' ? {} : { why } })
        if (relations.length >= 3) break
      }
    }
    const why = typeof item.why === 'string' ? item.why.trim().slice(0, 200) : ''
    // 类型与关系全空的条目没有信息量，丢掉。
    if (type === null && relations.length === 0) continue
    suggestions.push({ id, type, relations, ...why === '' ? {} : { why } })
  }
  return { ok: true, suggestions }
}

/**
 * 批量生成"语义增强"建议（**第二处碰 I/O 的函数**，纪律与 `generateQuestion` 一致）。
 *
 * 契约：**永不抛错**。任何失败都归一成 `{ ok: false, reason }`，由调用方回退基线轨 ——
 * 语义增强是"锦上添花"，绝不能因为它把整条提炼流程带走。
 *
 * 三条硬约束：
 *   ① **批量**：按 `batchSize` 分组，一次调用判一批（60 条 → 最多 8 次调用）；
 *   ② **总预算**：`budgetMs` 用尽即停止继续调用，剩余候选走基线轨（并如实标注 `stopped`）；
 *   ③ **单条尽力**：某批输出不合格只丢那一批，不影响其它批。
 *
 * @param {object} options 入参
 * @param {object} options.ctx 宿主上下文
 * @param {object[]} options.candidates 候选
 * @param {object[]} [options.nodes] 已有节点摘要
 * @param {number} [options.batchSize] 批大小
 * @param {number} [options.budgetMs] 总预算毫秒（0 = 不限）
 * @param {number} [options.timeoutMs] 单次调用超时
 * @param {AbortSignal} [options.signal] 取消信号
 * @returns {Promise<{ ok: boolean, suggestions: object[], calls: number, considered: number, stopped: boolean, reason?: string }>} 结果
 */
export async function generateSemanticSuggestions(options = {}) {
  const { ctx, candidates, nodes, signal } = options
  const list = Array.isArray(candidates) ? candidates : []
  const batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0
    ? options.batchSize
    : SEMANTIC_BATCH_SIZE
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : 0
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : SEMANTIC_TIMEOUT_MS

  if (list.length === 0) return { ok: true, suggestions: [], calls: 0, considered: 0, stopped: false }
  if (ctx === undefined || ctx === null) {
    return { ok: false, suggestions: [], calls: 0, considered: 0, stopped: false, reason: '未提供宿主上下文' }
  }
  // 复用提问通道的同一套路由解析：拿不到就如实报缺，绝不猜一个模型名。
  const route = readModelRoute(ctx)
  if (!route.ok) return { ok: false, suggestions: [], calls: 0, considered: 0, stopped: false, reason: route.reason }
  const llm = readLlm(ctx)
  if (llm === null) {
    return { ok: false, suggestions: [], calls: 0, considered: 0, stopped: false, reason: '宿主未提供 llm 服务' }
  }

  const startedAt = Date.now()
  const suggestions = []
  let calls = 0
  let considered = 0
  let stopped = false
  let firstReason = null

  for (let start = 0; start < list.length; start += batchSize) {
    if (signal?.aborted === true) {
      stopped = true
      firstReason = firstReason ?? '用户已取消'
      break
    }
    if (budgetMs > 0 && Date.now() - startedAt > budgetMs) {
      stopped = true
      firstReason = firstReason ?? `语义增强超出总预算（${budgetMs} ms）`
      break
    }
    const batch = list.slice(start, start + batchSize)
    // 超时与取消合成一个信号：任一触发都要让流停下来，否则超时后模型还在烧 token。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    try {
      const { system, messages } = buildSemanticMessages({ candidates: batch, nodes })
      const request = {
        provider: route.provider,
        model: route.model,
        system,
        messages,
        maxTokens: SEMANTIC_MAX_TOKENS,
        ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
        signal: controller.signal,
      }
      calls += 1
      considered += batch.length
      const { text, finish } = await collectStream(llm.stream(request))
      const failure = describeFinish(finish)
      if (failure !== null) {
        firstReason = firstReason ?? failure
        // 整批流失败（多为网络/服务问题）⇒ 后续批次大概率同样失败，停止继续烧预算。
        stopped = true
        break
      }
      const checked = validateSemanticSuggestions(text, new Set(batch.map(item => item.id)))
      if (!checked.ok) {
        firstReason = firstReason ?? checked.reason ?? '输出不合格'
        continue
      }
      suggestions.push(...checked.suggestions)
    } catch (error) {
      firstReason = firstReason ?? `语义增强异常：${String(error?.message ?? error)}`
      stopped = true
      break
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  return {
    ok: suggestions.length > 0,
    suggestions,
    calls,
    considered,
    stopped,
    ...firstReason === null ? {} : { reason: firstReason },
  }
}

// ── 主题地图（2026-09-28：补上"初始预设只搭空架子"那一环）────────────────────

/**
 * 装配「主题地图」的请求体（纯函数）。
 *
 * ★ 为什么故意**不要 JSON**：真机日志显示「出题」那条 JSON 通道有 4/7 的解析
 *   失败率（被截断/话太多）。主题地图是结构化列表，**markdown 天然更稳**，
 *   明知 JSON 会翻车还去用它是自己找麻烦。
 *
 * ★ 边界（写死在提示词里）：本函数只生成**主题地图**（方向 / 该方向的建议主题 /
 *   起手问题）。它**不生成知识节点** —— 节点必须来自用户自己的会话，
 *   否则会破「用户认可 ≠ 已事实验证」这条硬纪律。
 *
 * @param {{ answers?: object, history?: object[] }} options 入参
 * @returns {{ system: string, messages: object[] }} 请求体
 */
export function buildThemeMapMessages({ answers, history } = {}) {
  const system = [
    '你在帮一位用户把「初始预设访谈」的结果，整理成一份**基础知识框架**。',
    '',
    '## 边界（必须先看，越界即废）',
    '- 你产出的是**主题地图**：该往哪几个方向学、每个方向下先碰哪些主题、起手要回答什么问题。',
    '- **不要编造"知识"**：不要输出"某某结论是 X"这类事实性断言 —— 你并不知道他的实际情况。',
    '- 你只在**他给的信息**范围内推导；信息不足就少写，不要为凑数编。',
    '',
    '## 输出格式（严格遵守，用 markdown，**不要** JSON）',
    '### 方向名',
    '- 建议主题：<一个具体主题>｜起手问题：<一个可回答的问题>',
    '- 建议主题：<…>｜起手问题：<…>',
    '',
    '要求：',
    '- 方向名**直接用他提到的关注方向**（下面会列出），别自创新的分类；',
    '- 每个方向给 **1~3 个**条目，总共不超过 10 个条目；',
    '- 「起手问题」必须是**他明天就能动手查/试**的问题，不是"什么是 X"这种教科书问句；',
    '- 只输出 `###` 与 `- ` 两种结构，不要前言后语、不要代码围栏、不要额外标题。',
    '- 全部用中文。',
  ].join('\n')

  const source = answers ?? {}
  const labelOf = key => TOPIC_LABELS_ZH[key] ?? key
  const lines = []
  const known = renderKnownProfile(source)
  lines.push('## 他的访谈答案', ...(known.length > 0 ? known : ['（没有可用答案）']))

  const directions = Array.isArray(source.interests)
    ? source.interests
    : String(source.interests ?? '').split(/[,，、;；]/u).map(item => item.trim()).filter(item => item !== '')
  lines.push(
    '',
    `## 他提到的关注方向（方向名直接用这些，共 ${directions.length} 个）`,
    ...(directions.length > 0 ? directions.map(item => `- ${item}`) : ['（他还没填关注方向 —— 那就用你从职业/面向推导出的 2~3 个方向）']),
  )

  const historyLines = renderHistory(Array.isArray(history) ? history.slice(0, 10) : [])
  if (historyLines.length > 0) {
    lines.push('', '## 访谈过程（他的原话 —— 从这里找他的真实语境）', ...historyLines)
  }
  lines.push('', '请按上面的格式输出主题地图。')

  return {
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }],
  }
}

/**
 * 生成主题地图（第三处碰 I/O 的函数；纪律同前：**永不抛错**）。
 *
 * @param {object} options 入参
 * @param {object} options.ctx 宿主上下文
 * @param {object} [options.answers] 访谈答案
 * @param {object[]} [options.history] 问答历史
 * @param {AbortSignal} [options.signal] 取消信号
 * @param {number} [options.timeoutMs] 超时上限
 * @returns {Promise<{ ok: boolean, text: string, reason?: string }>} 结果
 */
export async function generateThemeMap(options = {}) {
  const { ctx, answers, history, signal } = options
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : SEMANTIC_TIMEOUT_MS
  if (ctx === undefined || ctx === null) return { ok: false, text: '', reason: '未提供宿主上下文' }
  const route = readModelRoute(ctx)
  if (!route.ok) return { ok: false, text: '', reason: route.reason }
  const llm = readLlm(ctx)
  if (llm === null) return { ok: false, text: '', reason: '宿主未提供 llm 服务' }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const onAbort = () => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) { clearTimeout(timer); return { ok: false, text: '', reason: '用户已取消' } }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const { system, messages } = buildThemeMapMessages({ answers, history })
    const request = {
      provider: route.provider,
      model: route.model,
      system,
      messages,
      maxTokens: SEMANTIC_MAX_TOKENS,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
      signal: controller.signal,
    }
    const { text, finish } = await collectStream(llm.stream(request))
    const failure = describeFinish(finish)
    if (failure !== null) return { ok: false, text: '', reason: failure }
    const trimmed = String(text ?? '').trim()
    if (trimmed === '') return { ok: false, text: '', reason: '模型返回空输出' }
    return { ok: true, text: trimmed }
  } catch (error) {
    return {
      ok: false,
      text: '',
      reason: timedOut
        ? `主题地图生成超时（${timeoutMs} ms）`
        : `主题地图生成异常：${String(error?.message ?? error)}`,
    }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
