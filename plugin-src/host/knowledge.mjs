/**
 * knowledge.mjs —— 知识库读取 + 候选提炼（纯函数）。
 *
 * ★ 本模块的第一条纪律：**消息文本是被观察的资料，不是本插件的指令源。**
 *   这里只做结构化切片、指纹与分类，绝不因为某段文本写着"忽略规则""修改权限"
 *   就去执行它。所有关键词判断都是**只读匹配**，命中结果只影响一个标签字段。
 *
 * 第二条纪律：**用户认可 ≠ 事实验证**。二者在候选结构里是不同的字段
 * （`decision` 与 `verification`），任何代码路径都不允许从一个推出另一个。
 *
 * @module dsh-learn-skills/knowledge
 */

import { fingerprint } from './paths.mjs'

/** 候选类型（本插件的分类词表，落进节点 tags）。 */
export const CANDIDATE_TYPES = Object.freeze([
  'fact',          // 事实性陈述
  'procedure',     // 可复用操作步骤
  'correction',    // 纠错结论（推翻旧说法）
  'preference',    // 偏好
  'hypothesis',    // 待验证假设
  'experience',    // 实践经验
  'unclassified',  // 未判定
  'noise',         // 噪声（默认排除）
])

/** 事实验证状态。与用户处理决定是**两个字段**。 */
export const VERIFICATION = Object.freeze({
  unverified: 'unverified',
  userConfirmed: 'user-confirmed',
  externallyVerified: 'externally-verified',
  falsified: 'falsified',
})

/** 用户处理决定。 */
export const DECISION = Object.freeze({
  pending: 'pending',
  keep: 'keep',
  exclude: 'exclude',
  revise: 'revise',
})

/** 候选与已有知识的关系判定。 */
export const RELATION = Object.freeze([
  'new', 'supplement', 'correction', 'duplicate', 'conflict', 'supersede', 'unverified',
])

/** 关系是否"有向"（有向关系在写盘时必须写清方向）。 */
export const DIRECTED_RELATIONS = Object.freeze(new Set(['supplement', 'correction', 'supersede']))

/** 噪声判据（结构性的，不是内容黑名单）。 */
const NOISE_PATTERNS = [
  /^(好的|嗯+|收到|谢谢|ok|okay|thanks?|thx)[。.!！~\s]*$/iu,
  /^\[(image|file) attachment\]/iu,
]

/** 分类关键词表：命中即标签，不命中即 unclassified。绝不据此改行为。 */
const TYPE_RULES = [
  { type: 'correction', pattern: /(更正|纠正|订正|勘误|其实不是|并不是|我之前说错|correction|corrigendum)/iu },
  { type: 'procedure', pattern: /(步骤|流程|先.*再.*最后|第[一二三四五六七八九十]步|操作如下|how\s*to|run:|\$\s)/iu },
  { type: 'preference', pattern: /(我(更)?喜欢|我习惯|偏好|倾向|prefer|I\s+usually)/iu },
  { type: 'hypothesis', pattern: /(可能|也许|猜测|推测|估计|不确定|待验证|大概|presumably|maybe|guess)/iu },
  { type: 'experience', pattern: /(实测|实测过|踩过|上次|遇到过|经验|worked\s+for\s+me|in\s+my\s+test)/iu },
]

/**
 * 按结构判定一段文本是否为噪声。
 *
 * 判据刻意保持"廉价且可解释"：宁可漏判噪声（用户会在审核面板里排除），
 * 也不要用模型式判断把有信息量的一句话吃掉。
 * @param {string} text 文本
 * @returns {boolean} 是否噪声
 */
export function isNoise(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return true
  if (trimmed.length < 4) return true
  return NOISE_PATTERNS.some(pattern => pattern.test(trimmed))
}

/**
 * 启发式类型推断（只做分类，不改行为）。
 * @param {string} text 文本
 * @returns {string} {@link CANDIDATE_TYPES} 之一
 */
export function classify(text) {
  const source = String(text ?? '')
  if (isNoise(source)) return 'noise'
  const hits = new Map()
  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(source)) hits.set(rule.type, (hits.get(rule.type) ?? 0) + 1)
  }
  if (hits.size === 0) return 'unclassified'
  // 命中数相同时按类型名排序，保证同一段文本永远得到同一个标签（可复现）。
  return [...hits.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0]
}

/**
 * 固定本次提炼的消息范围。
 *
 * 两条硬规则：
 *   ① 只取 `seq <= highWaterSeq`（高水位）—— 本流程**之后**产生的问答不进范围，
 *      否则提炼结果会被下一轮当成原始知识（自指污染）。
 *   ② 结果如实标注 `complete`：只有拿到完整历史才是 true。拿不到就标 false 并
 *      写清"这是部分范围"，不得宣称已完整复盘。
 *
 * @param {object[]} messages 会话消息（升序）
 * @param {{ highWaterSeq?: number, limit?: number, excludeFlows?: string[] }} [options] 范围选项
 * @returns {{ items: object[], complete: boolean, range: { from: number|null, to: number|null }, limitations: string[] }}
 */
export function fixRange(messages, options = {}) {
  const all = Array.isArray(messages) ? messages : []
  const limit = options.limit ?? 400
  const highWater = options.highWaterSeq ?? Number.POSITIVE_INFINITY
  const excludeFlows = new Set(options.excludeFlows ?? ['learn-skills'])
  const limitations = []

  const eligible = all.filter(message => (message?.seq ?? 0) <= highWater)
  if (eligible.length < all.length) {
    limitations.push(`排除了 ${all.length - eligible.length} 条高水位之后的消息（本流程自身产生的问答）`)
  }

  const excludedByFlow = eligible.filter(message => excludeFlows.has(String(message?.origin ?? '')))
  const kept = eligible.filter(message => !excludeFlows.has(String(message?.origin ?? '')))
  if (excludedByFlow.length > 0) {
    limitations.push(`排除了 ${excludedByFlow.length} 条标记为学习流程自身产生的消息`)
  }

  const covered = kept.length
  let items = kept
  if (kept.length > limit) {
    items = kept.slice(kept.length - limit)
    limitations.push(`消息数超过上限 ${limit}，只取了最近 ${limit} 条（更早的部分未参与本次提炼）`)
  }

  const complete = all.length === eligible.length
    && excludedByFlow.length === 0
    && covered <= limit
    && options.historyComplete !== false
  if (options.historyComplete === false) {
    limitations.push('宿主未提供完整历史（上下文压缩后只有当前窗口），本次为部分范围')
  }

  const seqs = items.map(message => message?.seq).filter(value => Number.isFinite(value))
  return {
    items,
    complete,
    range: {
      from: seqs.length > 0 ? Math.min(...seqs) : null,
      to: seqs.length > 0 ? Math.max(...seqs) : null,
    },
    limitations,
  }
}

/**
 * 把一段消息转成结构化候选知识（不做语义发明，只做结构归纳）。
 *
 * 一条 user 消息 + 紧随其后的 assistant 消息合成一个候选；
 * 单独的 user 消息（例如用户给的事实、偏好、纠错）也各成一个候选。
 *
 * @param {object[]} messages 已固定的消息范围
 * @param {{ batchId: string, existing?: Record<string, string>, maxCandidates?: number, candidateId: (batchId: string, index: number) => string }} options 选项
 * @returns {{ candidates: object[], stats: object }}
 */
export function extractCandidates(messages, options) {
  const items = Array.isArray(messages) ? messages : []
  const existing = options.existing ?? {}
  const maxCandidates = options.maxCandidates ?? 60
  const candidates = []
  let noiseCount = 0

  for (const message of items) {
    const text = String(message?.text ?? '').trim()
    if (isNoise(text)) {
      noiseCount += 1
      continue
    }
    const digest = fingerprint(text)
    const seenBatch = existing[digest]
    const type = classify(text)
    if (type === 'noise') {
      noiseCount += 1
      continue
    }
    candidates.push({
      // 稳定 id：同一批次同一序号永远得到同一个 id，重跑不会凭空多出一条。
      id: options.candidateId(options.batchId, candidates.length),
      batchId: options.batchId,
      title: String(message?.title ?? text.slice(0, 40).replace(/\s+/gu, ' ')),
      summary: text.length > 240 ? `${text.slice(0, 240)}…` : text,
      type,
      scope: String(message?.scope ?? '本会话'),
      source: {
        sessionId: message?.sessionId ?? null,
        // 定位三件套：能精确就精确，做不到就如实记限制。
        messageIds: message?.id === undefined ? [] : [message.id],
        seqRange: Number.isFinite(message?.seq) ? [message.seq, message.seq] : null,
        precision: message?.id === undefined && !Number.isFinite(message?.seq) ? 'unavailable' : 'message',
        limitation: message?.id === undefined && !Number.isFinite(message?.seq)
          ? '宿主未暴露消息定位标识，仅记录到会话级'
          : null,
      },
      evidence: String(message?.evidence ?? '会话原文'),
      // ★ 两个字段，永不互相推导。
      verification: VERIFICATION.unverified,
      decision: DECISION.pending,
      relations: [],
      fingerprint: digest,
      alreadyProcessed: seenBatch === undefined ? null : { batchId: seenBatch },
    })
    if (candidates.length >= maxCandidates) break
  }

  return {
    candidates,
    stats: {
      considered: items.length,
      extracted: candidates.length,
      noise: noiseCount,
      alreadyProcessed: candidates.filter(item => item.alreadyProcessed !== null).length,
    },
  }
}

/**
 * 去重：同指纹只留一条（保留先出现者，后者并入 `duplicates` 供审核时一眼看到）。
 * @param {object[]} candidates 候选
 * @returns {{ candidates: object[], merged: number }}
 */
export function dedupeCandidates(candidates) {
  const byFingerprint = new Map()
  let merged = 0
  for (const candidate of candidates) {
    const existing = byFingerprint.get(candidate.fingerprint)
    if (existing === undefined) {
      byFingerprint.set(candidate.fingerprint, candidate)
      continue
    }
    existing.duplicates = [...existing.duplicates ?? [], candidate.id]
    merged += 1
  }
  return { candidates: [...byFingerprint.values()], merged }
}

/**
 * 候选与已有知识节点的初步关联（廉价、可解释：标题/标签词重合）。
 *
 * 这里只出"初步关联"，正式判定发生在关联升级阶段（那里要读节点正文、要人审核）。
 * @param {object[]} candidates 候选
 * @param {object[]} nodes 已有节点摘要（`{ id, title, tags }`）
 * @returns {object[]} 带 `candidates[i].relations` 的候选
 */
export function relateToNodes(candidates, nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  const tokensOf = text => new Set(
    String(text ?? '').toLowerCase().split(/[^\p{Letter}\p{Number}]+/u).filter(token => token.length >= 2),
  )
  for (const candidate of candidates) {
    const tokens = tokensOf(`${candidate.title} ${candidate.summary}`)
    const scored = []
    for (const node of list) {
      const nodeTokens = tokensOf(`${node.title ?? ''} ${(node.tags ?? []).join(' ')}`)
      let overlap = 0
      for (const token of tokens) if (nodeTokens.has(token)) overlap += 1
      if (overlap > 0) scored.push({ id: node.id, overlap })
    }
    candidate.relations = scored
      .sort((left, right) => right.overlap - left.overlap || String(left.id).localeCompare(String(right.id)))
      .slice(0, 3)
      .map(item => ({ id: item.id, relation: 'candidate', confidence: 'heuristic' }))
  }
  return candidates
}

/**
 * 合并「基线轨」与「语义轨」（方案 B-1：双轨并存 + 冲突标记）。
 *
 * ★ 为什么不覆盖（设计地基）：模型输出**不可复现**——同一份内容两次提炼可能得到
 *   不同 `type` / 不同关系。若直接覆盖基线判定，会出现"同一知识两次入库得到不同
 *   分类、版本号无故 +1、索引反复抖动"，**留痕与可回溯性当场失效**。
 *   故：基线轨永远保留（它是可复现的对照），语义轨另存字段，不一致时**如实标冲突**，
 *   由人在审核面板裁决。
 *
 * 字段约定：
 *   · `type` / `relations`                      模型**同意**基线、或模型无建议 ⇒ 保持基线
 *   · `typeSemantic` / `relationsSemantic`       模型给出了**不同**判定时才写入
 *   · `typeDivergence` / `relationsDivergence`   true = 两轨不一致（审核重点）
 *   · `semanticSummary`                          本次语义增强的整体情况（供界面如实展示）
 *
 * @param {object[]} candidates 已过基线轨的候选（`relateToNodes` 之后）
 * @param {object[]} suggestions 模型建议（`{ id, type, relations, why }`）
 * @param {{ calls?: number, considered?: number, stopped?: boolean, reason?: string|null }} [meta] 语义调用元信息
 * @returns {{ candidates: object[], summary: object }} 合并结果
 */
export function mergeSemanticSuggestions(candidates, suggestions, meta = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const advice = new Map()
  for (const item of Array.isArray(suggestions) ? suggestions : []) {
    if (item !== null && typeof item === 'object' && typeof item.id === 'string') advice.set(item.id, item)
  }

  let applied = 0
  let typeDivergenceCount = 0
  let relationsDivergenceCount = 0

  for (const candidate of list) {
    const suggestion = advice.get(candidate.id)
    if (suggestion === undefined) continue
    applied += 1

    const semanticType = typeof suggestion.type === 'string' ? suggestion.type : null
    if (semanticType !== null && semanticType !== candidate.type) {
      // 不一致 ⇒ 双轨并列，绝不覆盖基线。
      candidate.typeSemantic = semanticType
      candidate.typeDivergence = true
      if (typeof suggestion.why === 'string' && suggestion.why !== '') candidate.typeWhy = suggestion.why
      typeDivergenceCount += 1
    }

    const semanticRelations = (Array.isArray(suggestion.relations) ? suggestion.relations : [])
      .filter(item => item !== null && typeof item === 'object' && typeof item.id === 'string')
    if (semanticRelations.length > 0) {
      const baselineIds = new Set((candidate.relations ?? []).map(item => item.id))
      const sameSet = semanticRelations.length === baselineIds.size
        && semanticRelations.every(item => baselineIds.has(item.id))
      if (!sameSet) {
        candidate.relationsSemantic = semanticRelations
        candidate.relationsDivergence = true
        relationsDivergenceCount += 1
      }
    }
  }

  return {
    candidates: list,
    summary: {
      enabled: true,
      suggested: advice.size,
      applied,
      typeDivergence: typeDivergenceCount,
      relationsDivergence: relationsDivergenceCount,
      calls: meta.calls ?? 0,
      considered: meta.considered ?? 0,
      stopped: meta.stopped === true,
      reason: meta.reason ?? null,
      note: '语义轨与基线轨并存：不一致处已标冲突，最终判定仍由你裁决。',
    },
  }
}

/**
 * 解析 frontmatter（只支持标量 + 内联数组 + `- ` 列表，够用且可预测）。
 *
 * ★ 容忍前置空白与 CRLF，且**开头是 `---` 才认**（避免把正文里的水平分割线当 frontmatter 开头）。
 *
 * 为什么必须容忍前置空白：早先的实现是 `if (!source.startsWith('---')) return {data:{}}` ——
 * 文件前面多一个空行，**整块 frontmatter 就被静默丢弃**，而调用方用 `?? 回退` 兜住，
 * 于是症状表现为"节点的 id 变成了文件名主干"，离真因很远。实测为此查了三轮。
 * 与之配套：**回退路径已取消**（缺 id 就直接跳过并告警），所以解析失败会立刻暴露。
 *
 * ⚠️ 本函数是那类"改对了源码却没重建产物"故障的**单点**：它落在 `lib/`（发布物，
 *    DSH 实际加载的就是它），而测试跑的是 `plugin-src/`。二者一旦不同步，
 *    测试全绿而线上照旧丢 id。`test/build.test.mjs` 里的产物一致性检查专门守这道缝。
 *
 * @param {string} text 文件全文
 * @returns {{ data: Record<string, unknown>, body: string }} 元数据与正文
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  // 先归一化行尾、再跳掉前置空白；`\s*` 会吃掉换行，所以用 `^[\s\uFEFF]*` 再单独定位。
  const normalized = source.replaceAll('\r\n', '\n').replace(/^[\uFEFF\s]+/u, '')
  if (!normalized.startsWith('---')) return { data: {}, body: source }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: source }
  const head = normalized.slice(3, end)
  const body = normalized.slice(end + 4).replace(/^\n/u, '')
  const data = {}
  let listKey = null
  for (const rawLine of head.split('\n')) {
    const line = rawLine.replace(/\s+$/u, '')
    if (line.trim() === '') continue
    const listMatch = /^\s*-\s+(.*)$/u.exec(line)
    if (listMatch !== null && listKey !== null) {
      data[listKey].push(stripQuotes(listMatch[1]))
      continue
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(line)
    if (pair === null) continue
    const [, key, rawValue] = pair
    const value = rawValue.trim()
    if (value === '') {
      listKey = key
      data[key] = []
      continue
    }
    listKey = null
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map(item => stripQuotes(item.trim())).filter(item => item !== '')
      continue
    }
    data[key] = stripQuotes(value)
  }
  return { data, body }
}

function stripQuotes(value) {
  const trimmed = String(value).trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * 读既有知识节点摘要（关联与体检共用）。
 *
 * ★ frontmatter 必须有 `id` —— 缺失就**响亮跳过**，绝不拿文件名回退当 id。
 *
 * 为什么不回退：文件名叫 `<id>-<slug>.md`，把主干当 id 会造出一个
 * **与 frontmatter 不一致的 id**，而这个内存里的错 id 会让后续"按 id 找既有节点"
 * 永远落空 —— 表现为"关联明明在、却判成新增"，从外部完全看不出是哪一环断的。
 * 宁可让这个节点不进内存（并在日志里说明），也不要污染 id 空间。
 *
 * ⚠️ 但"跳过"只会进日志（测试里的 logger 是空实现，肉眼看不见）。所以本函数
 *    **同时返回 `skipped`**，且跳过项**带上原文与指纹**：调用方拿得到"谁被跳过了、
 *    为什么、现在长什么样"，测试也能直接钉住它。
 *
 * ★ 为什么跳过项必须带 `raw` / `sha`：**"没载入"不等于"没被占用"**。
 *   用户把节点文件改写成一段没有 frontmatter 的散文后，它当然解析不出 id；
 *   但它仍是**上次写入的那个路径**。若把它当成"不存在"，插件下一次遇到指向它的
 *   候选就会**另建一个新节点**，而不是"拒绝覆盖用户的手改" —— 实测就是这么暴露的。
 *
 * @param {object} options 依赖
 * @param {string} options.directory 节点目录绝对路径（或工作区相对路径，交由调用方约定）
 * @param {string} options.prefix 相对路径前缀（如 `knowledge/nodes`）
 * @param {(path: string) => Promise<string|undefined>} options.readText 读文本
 * @param {(path: string) => Promise<object[]>} options.readDirectory 列目录
 * @param {(level: string, message: string) => void} [options.warn] 告警回调
 * @returns {Promise<{ nodes: object[], skipped: { relative: string, reason: string, raw: string|null, sha: string|null }[] }>} 节点与跳过项
 */
export async function loadNodes({ directory, prefix, readText, readDirectory, warn }) {
  const entries = await readDirectory(directory)
  const nodes = []
  const skipped = []
  for (const entry of entries ?? []) {
    if (entry.directory || !entry.name.endsWith('.md')) continue
    const relative = `${prefix}/${entry.name}`
    const text = await readText(`${directory}/${entry.name}`)
    if (text === undefined) {
      skipped.push({ relative, reason: '读不到内容', raw: null, sha: null })
      continue
    }
    const { data, body } = parseFrontmatter(text)
    const id = typeof data.id === 'string' ? data.id.trim() : ''
    if (id === '') {
      skipped.push({
        relative,
        reason: '缺少 frontmatter id（已跳过；请手工补上 id，不要用文件名回退）',
        raw: text,
        sha: fingerprint(text),
      })
      warn?.('warn', `节点 ${relative} 缺少 frontmatter id —— 已跳过（请手工补上 id，不要用文件名回退）`)
      continue
    }
    nodes.push({
      id,
      title: data.title ?? entry.name.replace(/\.md$/u, ''),
      status: data.status ?? 'active',
      version: Number(data.version ?? 1),
      updated: data.updated ?? null,
      tags: Array.isArray(data.tags) ? data.tags : [],
      sources: Array.isArray(data.sources) ? data.sources : [],
      links: Array.isArray(data.links) ? data.links : [],
      body,
      relative,
      sha: fingerprint(text),
      raw: text,
    })
  }
  return { nodes, skipped }
}

/**
 * 解析**总索引**里那张节点索引表（`## 节点索引` 下的 markdown 表）。
 *
 * 为什么需要它：这张表是插件**自己写**的（`refreshFrameworkIndex`），且在写入当时
 * 每个节点都是**可载入**的。所以它是"某个节点**曾经**存在过、并且路径是什么"的
 * **唯一权威记录**——当一个节点的 frontmatter 被手工改坏后，
 * **只有这张表还记得它本该是哪个文件**。
 *
 * @param {string} frameworkText `knowledge/framework.md` 全文（可为空串/undefined）
 * @returns {{ id: string, title: string|null, status: string|null, updated: string|null, relative: string }[]} 索引行
 */
export function parseFrameworkIndex(frameworkText) {
  const { body } = parseFrontmatter(frameworkText ?? '')
  const marker = body.indexOf('## 节点索引')
  if (marker === -1) return []
  const rows = []
  for (const line of body.slice(marker).split('\n')) {
    const text = line.trim()
    // 只认表格数据行：至少 6 个单元格，且第一格形如节点 id。
    if (!text.startsWith('|')) continue
    const cells = text.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim())
    if (cells.length < 6) continue
    if (!/^LN-\d{8}-\d{3}$/u.test(cells[0])) continue
    rows.push({
      id: cells[0],
      title: cells[1] === '' ? null : cells[1],
      status: cells[2] === '' ? null : cells[2],
      updated: cells[4] === '' || cells[4] === '—' ? null : cells[4],
      relative: cells[5],
    })
  }
  return rows
}

/**
 * 找出「**框架有记录、节点却载入不了**」的文件 —— 缺内容节点。
 *
 * 判据是**双源求差**：
 *   · A ＝ 总索引里记过的节点（`parseFrameworkIndex`，带 id 与**来源路径**）
 *   · B ＝ 本次实际载入成功的节点 id
 *   · C ＝ 本次载入失败的文件（`loadNodes` 的 `skipped`，带 relative 与 sha）
 * A 里有、B 里没有的，就是缺内容节点。
 *
 * 两个入口共用这一处判据（升级的"重建清单"与体检的"异常节点点名"）——
 * 判据只写一份，避免第三份漂移。
 *
 * ⚠️ 边界：它**依赖总索引曾经写过这个节点**。若某节点的 frontmatter 从未达标，
 *    索引里就没有它 ⇒ 本判据抓不到。所以体检侧必须**同时**报 `skipped`
 *    （那一条覆盖"从未达标"的情形）。
 *
 * @param {{ frameworkText?: string, nodes: object[], skipped: object[] }} input 入参
 * @returns {{ id: string, relative: string, reason: string, hasContent: boolean, sha: string|null, indexed: object }[]} 缺内容节点
 */
export function findMissingNodes({ frameworkText, nodes, skipped }) {
  const loadableIds = new Set((nodes ?? []).map(node => node.id))
  const byRelative = new Map()
  for (const item of skipped ?? []) {
    if (typeof item?.relative === 'string') byRelative.set(item.relative, item)
  }
  const out = []
  for (const row of parseFrameworkIndex(frameworkText ?? '')) {
    if (loadableIds.has(row.id)) continue
    const broken = byRelative.get(row.relative)
    out.push({
      id: row.id,
      relative: row.relative,
      reason: broken === undefined
        ? '总索引有记录，但该文件不存在或读不到'
        : `总索引有记录，但该文件载入不了：${broken.reason}`,
      hasContent: broken?.raw !== undefined && broken?.raw !== null,
      sha: broken?.sha ?? null,
      indexed: row,
    })
  }
  return out
}

/**
 * 渲染节点文件：沿用既有字段 `id / title / status / version / updated / tags / sources / links`。
 * @param {object} node 节点
 * @returns {string} 文件内容
 */
export function renderNode(node) {
  const lines = [
    '---',
    `id: ${node.id}`,
    `title: ${node.title}`,
    `status: ${node.status ?? 'active'}`,
    `version: ${node.version ?? 1}`,
    `updated: ${node.updated}`,
    `tags: ${JSON.stringify(node.tags ?? [])}`,
    `sources: ${JSON.stringify(node.sources ?? [])}`,
    `links: ${JSON.stringify(node.links ?? [])}`,
    '---',
    '',
    `# ${node.title}`,
    '',
    node.body ?? '',
    '',
  ]
  return lines.join('\n')
}

/**
 * 节点内容变化的唯一判据：**除 `updated` 之外的字段是否真的变了**。
 *
 * 这条判据是"重试不重复升级版本"的全部依据：重跑一次得到完全相同的正文，
 * 版本必须保持不动。
 * @param {object} previous 旧节点
 * @param {object} next 新节点
 * @returns {boolean} 是否需要递增版本
 */
export function contentChanged(previous, next) {
  if (previous === undefined || previous === null) return true
  const keys = ['title', 'status', 'tags', 'sources', 'links', 'body']
  for (const key of keys) {
    if (JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null)) return true
  }
  return false
}
