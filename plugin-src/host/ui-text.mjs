/**
 * ui-text.mjs —— 面向界面的文案（纯函数：零依赖、零 I/O、可单测）。
 *
 * 为什么单独成模块：同一段文案要在**两侧**用 —— 宿主侧（`flows` 拼 userQuestions
 * 的选项目录与结果 message）与客户端侧（`impl` 渲染面板）。两处手写必然漂移，
 * 而漂移的后果是「界面上说的」与「实际发生的」不一致 —— 本模块就是为了让
 * 「批次怎么显示」只有一处实现。
 *
 * ⚠️ 为什么放在 `host/` 而不是另建共享目录：`lib/` 是**扁平**产物（构建把 host/
 * 逐文件复制过去），所以宿主侧只能 `./x.mjs`；客户端半侧由 esbuild 打包，可以把
 * `../host/ui-text.mjs` 内联进去。放在 host/ 是两侧都能用的唯一位置。
 *
 * ── 本模块要解决的两个真实故障（都来自同一份误报）────────────────────────
 *   ① **空批次照样报「完整历史」**：范围为空时界面显示 `?–?`，读起来像"读完了、
 *      只是没东西"，实则"一条消息都没读到"。⇒ `rangeText()` 在空范围时只输出
 *      「未读到会话消息」，`distillOverview()` 同时把消息数与事件读数摊开。
 *   ② **界面只有批次号**：升级时要用户在 `批次 001 / 002 / 003` 之间选，却不说
 *      每批里是什么。⇒ `batchChoice()` 给出「时间 + 待裁决条数 + 前三条标题」。
 */

/**
 * 去掉会原样露在界面上的 Markdown 强调标记。
 *
 * 界面是**纯文本**渲染（不是 markdown 渲染器）—— `**没有**` 只会连着星号一起显示。
 * 文案在源码里保留星号便于阅读，展示前统一剥掉；这是"显示层的事"，不该让每处
 * 文案各记一遍规矩。
 * @param {unknown} value 任意文本
 * @returns {string} 可直接显示的文本
 */
export function plainText(value) {
  return String(value ?? '').replace(/\*\*/gu, '')
}

/**
 * `2026-10-17T13:46:50` → `10-17 13:46`（界面只留到分钟）。
 * @param {unknown} createdAt 时间戳
 * @returns {string} 短时间；认不出时原样截断
 */
export function shortTime(createdAt) {
  const text = String(createdAt ?? '')
  // ⚠️ 分隔符写成 `[T]` 而不是裸 T：`static-check` 的「未定义符号」那条是**粗粒度**
  //    扫描 —— 它连正则字面量与注释里的字样都当代码看，于是「裸 T 紧跟一个左圆括号」
  //    会被误报成一个叫 T 的符号（写在这行注释里同样会命中）。字符类写法语义完全相同。
  const match = /^(\d{4})-(\d{2})-(\d{2})[T](\d{2}):(\d{2})/u.exec(text)
  if (match === null) return text.slice(0, 16)
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`
}

/**
 * 消息范围 → 人话。
 *
 * 空范围**不许**退化成 `?–?`：那个写法在界面上与"读完了但序号算不出"无法区分，
 * 而真实含义是"一条消息都没读到"。这两件事的处置完全不同。
 * @param {{ from?: number|null, to?: number|null }|undefined} range 范围
 * @returns {string} 范围描述
 */
export function rangeText(range) {
  const from = range?.from
  const to = range?.to
  if (Number.isFinite(from) && Number.isFinite(to)) return `seq ${from}–${to}`
  return '未读到会话消息'
}

/**
 * 事件类型分布 → `user/message×18、assistant/message×19`。
 * @param {object|null} readStats 会话读统计
 * @returns {string} 描述；无数据时为空串
 */
export function eventTypesText(readStats) {
  const types = Array.isArray(readStats?.eventTypes) ? readStats.eventTypes : []
  if (types.length === 0) return ''
  return types.map(item => `${item?.type ?? '?'}×${item?.count ?? 0}`).join('、')
}

/**
 * 提炼结果的**总览行**（界面直接逐行渲染，不在客户端拼字符串）。
 *
 * 三行各管一件事，缺哪一行就会重新出现"不知道该看什么"：
 *   ① 这批是什么（批次号 / 时间 / 候选与裁决数）；
 *   ② 读与提炼的明细（消息、噪声、重复、已处理）—— 回答"收集了什么"；
 *   ③ 会话事件读数 —— 读不到消息时，它是唯一能定位原因的数字。
 * @param {object} payload 提炼结果（`{ batchId, createdAt, range, stats, readStats, candidates, kept, excluded }`）
 * @returns {string[]} 行数组
 */
export function distillOverview(payload) {
  const stats = payload?.stats ?? {}
  const read = payload?.readStats ?? null
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : []
  const lines = [
    `批次 ${payload?.batchId ?? '—'} · ${shortTime(payload?.createdAt)}｜`
      + `消息 ${Number.isFinite(stats.considered) ? stats.considered : '?'} 条（${rangeText(payload?.range)}）｜`
      + `候选 ${candidates.length} 条（保留 ${payload?.kept ?? 0} / 排除 ${payload?.excluded ?? 0}）`,
  ]
  const detail = [
    `噪声 ${stats.noise ?? 0}`,
    `同批重复合并 ${stats.merged ?? 0}`,
    `与旧批次重复 ${stats.alreadyProcessed ?? 0}`,
  ]
  if (read !== null) {
    detail.push(`会话事件 ${read?.eventsRead ?? '?'} 条`, `建出消息 ${read?.messagesBuilt ?? '?'} 条`)
  }
  lines.push(`明细：${detail.join('｜')}`)
  const types = eventTypesText(read)
  if (types !== '') lines.push(`事件类型：${types}`)
  return lines
}

/**
 * 0 条候选时的**结论句**：必须说清"为什么是空的"。
 *
 * 这是本次修复的核心之一：先前只给一张空表，用户无法区分
 * 「没读到消息」「全是噪声」「全是重复」—— 三者的下一步动作完全不同。
 * @param {object} payload 提炼结果
 * @returns {string|null} 结论句；有候选时返回 null
 */
export function distillEmptyReason(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : []
  if (candidates.length > 0) return null
  const stats = payload?.stats ?? {}
  const read = payload?.readStats ?? null
  if (read !== null && (read?.messagesBuilt ?? 0) === 0) {
    return `未读到本会话的消息（会话事件 ${read?.eventsRead ?? '?'} 条）—— 请确认会话里已有对话；`
      + '若确认有，请把这行读数发我：它说明宿主没有把历史暴露给插件。'
  }
  const considered = Number(stats.considered ?? 0)
  if (considered > 0 && Number(stats.noise ?? 0) >= considered) {
    return `读到的 ${considered} 条消息全部被判为噪声（寒暄 / 过短 / 无信息量），因此没有候选。`
  }
  if (Number(stats.alreadyProcessed ?? 0) > 0) {
    return `候选全部与旧批次重复（已处理 ${stats.alreadyProcessed} 条），因此本批没有可裁决项。`
  }
  return '本批没有产出候选（原因未明：请看下方「范围限制」与明细行）。'
}

/** 机器注入的典型开头：这些"候选"不是人说的话，不该代表一个批次。 */
function looksInjected(candidate) {
  const text = String(candidate?.title ?? candidate?.summary ?? '').trimStart()
  return /^<system-reminder>/u.test(text)
    || /^Current runtime context/u.test(text)
    || /^Additional instructions from/u.test(text)
}

/** 裁决结果计数（`DECISION.keep === 'keep'`，与 knowledge.mjs 同一约定）。 */
function decisionCounts(candidates) {
  let keep = 0
  let exclude = 0
  for (const candidate of candidates) {
    if (candidate?.decision === 'keep') keep += 1
    else if (candidate?.decision === 'exclude') exclude += 1
  }
  return { keep, exclude }
}

/**
 * 升级时的批次选项：**说清里面是什么**，而不是只给一个批次号。
 *
 * label 必须仍以「批次 <id>」开头 —— 选中后宿主靠它反解出批次 id（`startsWith`），
 * 所以格式与反解是同一处约定，改这里必须同时看 `upgrade()`。
 *
 * 三条判据（按"用户能不能在 3 秒内决定"倒推）：
 * 1. **能区分**：同一次会话反复提炼会产出内容雷同的批次，摘要必然一模一样 ⇒
 *    把"与谁重复"直接写在 label 上（`options.duplicateOf`），别让人比对两段噪声。
 * 2. **能判断值不值得**：已裁决的批次要给出**结果**（保留几 / 排除几），
 *    否则"已裁决"三个字不回答"还要不要再处理它"。
 * 3. **不被噪声代表**：预览跳过机器注入（`<system-reminder>` / `Current runtime context` …），
 *    并如实报出"另有 N 条像是机器上下文"——那是旧版本收集的痕迹。
 *
 * @param {{ batchId: string, createdAt?: string }} batch 批次元数据
 * @param {object} file 批次文件内容（含 `candidates` 与可选 `reviewedAt`）
 * @param {{ duplicateOf?: string }} [options] `duplicateOf` = 内容相同的更早批次 id
 * @returns {{ label: string, description: string }} 选项
 */
export function batchChoice(batch, file, options = {}) {
  const candidates = Array.isArray(file?.candidates) ? file.candidates : []
  const reviewed = file?.reviewedAt !== undefined && file?.reviewedAt !== null
  const state = reviewed ? `已裁决 ${candidates.length} 条` : `待裁决 ${candidates.length} 条`
  const verdict = reviewed ? decisionCounts(candidates) : null
  const verdictText = verdict === null || verdict.keep + verdict.exclude === 0
    ? ''
    : `（保留 ${verdict.keep} / 排除 ${verdict.exclude}）`
  const dupText = typeof options.duplicateOf === 'string' ? `｜与 ${options.duplicateOf} 内容相同` : ''
  const label = `批次 ${batch?.batchId ?? '—'} · ${shortTime(batch?.createdAt)}｜${state}${verdictText}${dupText}`
  if (candidates.length === 0) {
    return {
      label,
      description: '该批次没有候选（未读到会话消息）—— 建议重新提炼，而不是选它',
    }
  }
  const readable = candidates.filter(candidate => !looksInjected(candidate))
  const injected = candidates.length - readable.length
  const pool = readable.length > 0 ? readable : candidates
  const preview = pool.slice(0, 3)
    .map((candidate, index) => {
      const title = String(candidate?.title ?? candidate?.summary ?? '').replace(/\s+/gu, ' ').slice(0, 24)
      return `${index + 1}) ${title}`
    })
    .join(' ')
  const more = pool.length > 3 ? ` …共 ${candidates.length} 条` : ''
  const warn = injected === 0
    ? ''
    : injected === candidates.length
      ? '（整批像是机器上下文，不是你说的话 —— 建议清理这一批，重新提炼）'
      : `（另有 ${injected} 条像是机器上下文，不建议采用）`
  return { label, description: `${preview}${more}${warn}` }
}
