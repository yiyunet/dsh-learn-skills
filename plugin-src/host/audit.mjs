/**
 * audit.mjs —— 「沉淀复用」的引擎：**只读体检 + 变化对比**。
 *
 * 本模块的能力边界写在最前面，因为它就是本入口的全部职责：
 *   ✅ 读工作区里与本体系相关的文件，产出报告；
 *   ✅ 对比上次成功保存的基线，指出变化；
 *   ❌ 不修改被检查的文件；
 *   ❌ 不执行文件里的任何指令（文件内容只作被观察对象）；
 *   ❌ 不修复问题、不生成技能、不自动重写知识。
 *
 * 两条判据上的自我约束（都对应"看起来专业、其实是猜"的常见错法）：
 *   ① **不用修改时间判过期**。判定"可能过期"必须有版本、时间或替代依据，
 *      并且要写明是哪一条依据。文件旧不等于失效。
 *   ② **不把修改归因于本插件**。没有操作记录（`.dsh/` 下的日志）就不写归因。
 *
 * @module dsh-learn-skills/audit
 */

import { fingerprint, isoTimestamp, toRelative } from './paths.mjs'
import { readDirectory, readText } from './fsx.mjs'
import { parseFrontmatter, findMissingNodes } from './knowledge.mjs'
import { REDACTION_NOTICE, redact } from './redact.mjs'

/** 体检项判定档位。四档，缺一不可 —— 混档是"装作读到了"的根源。 */
export const CONFIDENCE = Object.freeze({
  observed: 'observed',       // 文件里确认读到
  inferred: 'inferred',       // 由多处证据推断
  missing: 'missing',         // 体系里就没有这类内容
  inaccessible: 'inaccessible', // 读不到（权限、超出上限、宿主不暴露）
})

/** 18 个体检项的定义。顺序即报告顺序（与需求逐条对应）。 */
export const AUDIT_ITEMS = Object.freeze([
  { id: 'role', title: '角色定位' },
  { id: 'goals', title: '目标与职责边界' },
  { id: 'prompt', title: '可读取的系统提示词与预设配置' },
  { id: 'precedence', title: '指令优先级及实际加载依据' },
  { id: 'workflow', title: '工作流程' },
  { id: 'skills', title: '技能与工具' },
  { id: 'knowledge', title: '知识库索引与核心规则' },
  { id: 'memory', title: '长期记忆' },
  { id: 'preferences', title: '用户偏好' },
  { id: 'tasks', title: '任务状态' },
  { id: 'collaboration', title: '协作关系' },
  { id: 'scheduling', title: '调度与审查机制' },
  { id: 'permissions', title: '权限与安全约束' },
  { id: 'io', title: '输入输出规范' },
  { id: 'cases', title: '典型任务案例' },
  { id: 'issues', title: '已知问题与改进建议' },
  { id: 'delta', title: '相比上次体检的变化' },
  { id: 'reuse', title: '可复用知识及建议的调用方式' },
])

/** 可能"过期"的判据关键词：命中才允许进入 issues。 */
const STALENESS_EVIDENCE = [
  { kind: 'version', pattern: /v(\d+)\s*[<≤到至]/iu, note: '文件内自带版本比较' },
  { kind: 'superseded', pattern: /(已废弃|已弃用|已替代|被 .{1,20} 取代|superseded|deprecated)/iu, note: '文件自述被替代' },
  { kind: 'date-expired', pattern: /(复审日|到期日|有效期)[^\n]{0,30}?(\d{4}-\d{2}-\d{2})/u, note: '自带复审/到期日' },
]

/**
 * 收集扫描范围内的文件。
 *
 * 只扫**已知的、与本体系相关**的目录，不做全仓遍历：体检读的是"体系"，
 * 不是"这个仓库"。超出上限的部分如实记进 `limitations`，不假装扫全了。
 *
 * @param {object} options
 * @param {string} options.workspace 工作区根（绝对）
 * @param {{ index: string, inbox: string, knowledge: string, data: string, task: string, reports: string, skillsDir: string, stateDir: string }} options.dirs 目录名
 * @param {number} [options.maxFiles] 文件数上限
 * @param {number} [options.maxBytes] 单文件字节上限
 * @returns {Promise<{ manifest: object[], limitations: string[], unreadable: object[] }>} 收集结果
 */
export async function collect(options) {
  const { workspace, dirs } = options
  const maxFiles = options.maxFiles ?? 400
  const maxBytes = options.maxBytes ?? 200000
  const manifest = []
  const limitations = []
  const unreadable = []

  /** 固定顺序：先规则，再体系，最后技能。报告引用时路径稳定。 */
  const roots = [
    { kind: 'root-rule', relative: 'AGENTS.md', file: true },
    { kind: 'index', relative: dirs.index, file: false },
    { kind: 'inbox', relative: dirs.inbox, file: false },
    { kind: 'framework', relative: `${dirs.knowledge}/framework.md`, file: true },
    { kind: 'nodes', relative: `${dirs.knowledge}/nodes`, file: false },
    { kind: 'data', relative: dirs.data, file: false },
    { kind: 'task', relative: dirs.task, file: false },
    { kind: 'reports', relative: dirs.reports, file: false },
    { kind: 'skills', relative: dirs.skillsDir, file: false },
  ]

  for (const root of roots) {
    const absolute = `${workspace}/${root.relative}`
    if (root.file) {
      const text = await readText(absolute)
      if (text === undefined) continue
      manifest.push(await entryOf({ absolute, relative: root.relative, kind: root.kind, text, maxBytes }))
      continue
    }
    const entries = await readDirectory(absolute)
    if (entries.length === 0) continue
    for (const entry of entries) {
      if (manifest.length >= maxFiles) {
        limitations.push(`文件数达上限 ${maxFiles}，${root.relative} 之后的条目未全部读取`)
        break
      }
      if (entry.directory) {
        // 目录级 AGENTS.md 与 SKILL.md 才是有意义的规则/技能载体。
        for (const candidate of ['AGENTS.md', 'SKILL.md', 'README.md']) {
          const childAbsolute = `${absolute}/${entry.name}/${candidate}`
          const text = await readText(childAbsolute)
          if (text === undefined) continue
          manifest.push(await entryOf({
            absolute: childAbsolute,
            relative: toRelative(workspace, childAbsolute),
            kind: root.kind,
            text,
            maxBytes,
          }))
        }
        continue
      }
      if (!/\.(md|ya?ml|json|txt)$/iu.test(entry.name)) continue
      const text = await readText(`${absolute}/${entry.name}`)
      if (text === undefined) {
        unreadable.push({ relative: toRelative(workspace, `${absolute}/${entry.name}`), reason: '读取失败' })
        continue
      }
      manifest.push(await entryOf({
        absolute: `${absolute}/${entry.name}`,
        relative: toRelative(workspace, `${absolute}/${entry.name}`),
        kind: root.kind,
        text,
        maxBytes,
      }))
    }
  }

  return { manifest, limitations, unreadable }
}

/** 单个文件 → 清单条目（带脱敏、指纹、上限标注）。 */
async function entryOf(input) {
  const truncated = input.text.length > input.maxBytes
  const { text, hits } = redact(truncated ? input.text.slice(0, input.maxBytes) : input.text, { maxBytes: input.maxBytes })
  return {
    relative: input.relative,
    kind: input.kind,
    bytes: Buffer.byteLength(input.text, 'utf8'),
    sha: fingerprint(input.text),
    truncated,
    redactionHits: hits,
    text,
    frontmatter: parseFrontmatter(input.text).data,
  }
}

/**
 * 体检主函数：产出 18 项结论 + 变化对比。
 *
 * @param {object} options
 * @param {object} options.collected {@link collect} 的结果
 * @param {object|undefined} options.baseline 上次成功保存的基线（undefined = 首次）
 * @param {{ presetId?: string|null, sessionId?: string|null, model?: string|null }} options.context 会话上下文
 * @returns {{ items: object[], delta: object, baseline: object, warnings: object[], scope: object }}
 */
export function audit(options) {
  const { collected, baseline, context = {} } = options
  const files = collected.manifest
  const byKind = kind => files.filter(file => file.kind === kind)
  const read = (relative) => files.find(file => file.relative === relative)

  const agentRules = read('AGENTS.md')
  const framework = byKind('framework')[0]
  const nodes = byKind('nodes').filter(file => /\/nodes\/[^/]+\.md$/iu.test(file.relative))
  const skills = byKind('skills').filter(file => file.relative.endsWith('SKILL.md'))

  const items = []
  const warnings = []

  const push = (id, confidence, entries, note) => {
    items.push({
      id,
      title: AUDIT_ITEMS.find(item => item.id === id)?.title ?? id,
      confidence,
      note: note ?? null,
      entries: entries.filter(entry => entry !== undefined && entry !== null),
    })
  }

  const cite = (file, extra) => (file === undefined
    ? null
    : { source: file.relative, sha: file.sha, bytes: file.bytes, ...extra })

  // ① 角色定位
  push('role', agentRules === undefined ? CONFIDENCE.missing : CONFIDENCE.observed, [
    cite(agentRules, agentRules === undefined ? undefined : { excerpt: excerptOf(agentRules.text, /^#\s+.+$/mu) }),
  ], agentRules === undefined ? '工作区根 AGENTS.md 不存在，角色定位无法从工作区确认' : null)

  // ② 目标与职责边界
  const boundary = agentRules === undefined ? undefined : excerptOf(agentRules.text, /(职责|边界|目标)[^\n]*\n(?:[-*\d].*\n){0,6}/u)
  push('goals', agentRules === undefined ? CONFIDENCE.missing : CONFIDENCE.observed, [cite(agentRules, boundary === undefined ? undefined : { excerpt: boundary })])

  // ③ 可读取的系统提示词与预设配置
  //    ★ 这条必须区分"文件写了什么"与"宿主实际加载了什么"：本插件不读宿主运行时状态，
  //      所以如实标注为 inaccessible，而不是拿工作区文件冒充系统提示词。
  push('prompt', CONFIDENCE.inaccessible, [
    context.presetId === null || context.presetId === undefined
      ? null
      : { source: '(会话投影)', note: `当前会话预设 id：${context.presetId}（来自宿主投影）` },
  ], '插件的宿主半侧读不到 system prompt 的实际组装结果；本项仅记录会话预设 id，不推断提示词内容')

  // ④ 指令优先级及实际加载依据
  const subAgents = files.filter(file => /\/AGENTS\.md$/iu.test(file.relative) && file.relative !== 'AGENTS.md')
  push('precedence', subAgents.length === 0 ? CONFIDENCE.observed : CONFIDENCE.inferred, [
    {
      source: '(宿主契约)',
      note: '宿主按 skill-filesystem 的 rank 顺序合并技能根；AGENTS.md 由 agent-instructions 加载（工作区根优先）',
    },
    ...subAgents.map(file => cite(file, { note: '子目录级 AGENTS.md —— 是否被加载取决于宿主实现，本插件不假设' })),
  ], subAgents.length === 0 ? null : '存在子目录级 AGENTS.md，其加载行为未在本工作区实测')

  // ⑤ 工作流程
  const workflow = framework === undefined
    ? undefined
    : excerptOf(framework.text, /(工作流程|流水线|六步|流程)[\s\S]{0,600}/u)
  push('workflow', workflow === undefined ? CONFIDENCE.missing : CONFIDENCE.observed, [
    cite(framework, workflow === undefined ? undefined : { excerpt: workflow }),
  ])

  // ⑥ 技能与工具
  push('skills', skills.length === 0 ? CONFIDENCE.missing : CONFIDENCE.observed,
    skills.map(file => cite(file, { note: '工作区技能（.dsh/skills）' })),
    '仅列工作区技能；本机用户级技能与随包技能不在扫描范围内')

  // ⑦ 知识库索引与核心规则
  const nodeIndex = nodes.map(file => ({
    id: file.frontmatter.id ?? null,
    title: file.frontmatter.title ?? null,
    status: file.frontmatter.status ?? null,
    version: file.frontmatter.version ?? null,
    updated: file.frontmatter.updated ?? null,
    source: file.relative,
    sha: file.sha,
  }))
  // ★ 缺内容节点：**总索引有记录、文件却载入不了**。
  //
  //   体检的全部价值就是"把体系里的问题指出来"，所以这里**不能沉默**：
  //   先前这条是漏的 —— `nodes` 按文件名后缀计数，一个 frontmatter 被手工改坏的文件
  //   被当成正常节点计入数量，而它其实在关联与升级里都取不到。
  //   判据与升级侧**共用同一处实现**（`findMissingNodes`），不允许各判一套。
  //
  //   只报**路径与原因**，不读正文 —— 脱敏面因此不受影响。
  const missingNodes = findMissingNodes({
    frameworkText: framework?.text ?? '',
    nodes: nodes
      .filter(file => typeof file.frontmatter.id === 'string' && file.frontmatter.id !== '')
      .map(file => ({ id: file.frontmatter.id })),
    skipped: nodes
      .filter(file => typeof file.frontmatter.id !== 'string' || file.frontmatter.id === '')
      .map(file => ({ relative: file.relative, reason: '缺少 frontmatter id', raw: file.text, sha: file.sha })),
  })
  push('knowledge', framework === undefined && nodes.length === 0 ? CONFIDENCE.missing : CONFIDENCE.observed, [
    cite(framework, { note: '唯一总索引' }),
    ...nodeIndex.slice(0, 200).map(node => ({ source: node.source, sha: node.sha, note: `节点 ${node.id ?? '(无 id)'} · v${node.version ?? '?'} · ${node.updated ?? '无日期'}` })),
    // 异常节点：指到具体文件，供人直接去补 frontmatter 或删掉让插件重建。
    ...missingNodes.map(item => ({
      source: item.relative,
      note: `⚠️ 异常节点：总索引登记为 ${item.id}，但该文件当前载入不了（${item.reason}）`
        + ' —— 它不会出现在关联与升级里；在「关联升级」时会给出重建选项',
    })),
    // ★ 另一半覆盖面：**从来没进过总索引**的坏文件（frontmatter 从未达标过）。
    //   `missingNodes` 靠"索引里有记录"才能认出来，这一条覆盖它抓不到的情形 ——
    //   两条合起来，才没有"载入不了却没人提"的文件。
    ...nodes
      .filter(file => typeof file.frontmatter.id !== 'string' || file.frontmatter.id === '')
      .map(file => ({
        source: file.relative,
        note: '⚠️ 异常节点：该文件载入不了（缺少 frontmatter id），且总索引里也没有它的记录'
          + ' —— 它不会出现在关联与升级里；补回 frontmatter 后可被重新纳入',
      })),
  ])
  const unloadableNodes = nodes.filter(file => typeof file.frontmatter.id !== 'string' || file.frontmatter.id === '')
  if (missingNodes.length > 0 || unloadableNodes.length > 0) {
    warnings.push({
      code: 'MISSING_NODE_CONTENT',
      detail: `${missingNodes.length + unloadableNodes.length} 个节点文件载入不了：`
        + `${[...missingNodes.map(item => item.relative), ...unloadableNodes.map(file => file.relative)].join('、')}`
        + '（这些节点对关联与升级不可见：前者总索引里有记录、可在「关联升级」时重建；'
        + '后者请补回 frontmatter）',
    })
  }

  // ⑧ 长期记忆
  push('memory', CONFIDENCE.inaccessible, [], '宿主长期记忆/跨会话记忆的存储位置与内容本插件不读取，也不推断')

  // ⑨ 用户偏好
  const preferenceFiles = nodes.filter(file => /(偏好|preference)/iu.test(`${file.frontmatter.title ?? ''} ${(file.frontmatter.tags ?? []).join(' ')}`))
  push('preferences', preferenceFiles.length === 0 ? CONFIDENCE.missing : CONFIDENCE.observed,
    preferenceFiles.map(file => cite(file)))

  // ⑩ 任务状态
  const tasks = byKind('task')
  push('tasks', tasks.length === 0 ? CONFIDENCE.missing : CONFIDENCE.observed,
    tasks.map(file => ({ source: file.relative, sha: file.sha, note: '任务文件（内容未逐条解析）' })))

  // ⑪ 协作关系
  const collaboration = agentRules === undefined
    ? undefined
    : excerptOf(agentRules.text, /(协作|分工|上报|RACI)[\s\S]{0,300}/u)
  push('collaboration', collaboration === undefined ? CONFIDENCE.missing : CONFIDENCE.observed, [
    cite(agentRules, collaboration === undefined ? undefined : { excerpt: collaboration }),
  ])

  // ⑫ 调度与审查机制
  const schedule = files.filter(file => /(调度|schedule|审查|review|巡检|monitor)/iu.test(file.relative))
  push('scheduling', schedule.length === 0 ? CONFIDENCE.missing : CONFIDENCE.inferred,
    schedule.map(file => cite(file, { note: '按文件名推断可能承载调度/审查规则' })),
    schedule.length === 0 ? null : '本项为按路径名推断，未逐条校验其是否为真实调度机制')

  // ⑬ 权限与安全约束
  const permission = files.filter(file => /(权限|permission|安全|security|脱敏|redact|凭据|credential)/iu.test(file.relative))
  push('permissions', permission.length === 0 ? CONFIDENCE.missing : CONFIDENCE.observed,
    permission.map(file => cite(file)))

  // ⑭ 输入输出规范
  const io = framework === undefined
    ? undefined
    : excerptOf(framework.text, /(命名|格式|输出|契约|frontmatter)[\s\S]{0,500}/u)
  push('io', io === undefined ? CONFIDENCE.missing : CONFIDENCE.observed, [
    cite(framework, io === undefined ? undefined : { excerpt: io }),
  ])

  // ⑮ 典型任务案例
  const reports = byKind('reports')
  push('cases', reports.length === 0 ? CONFIDENCE.missing : CONFIDENCE.observed,
    reports.slice(0, 50).map(file => ({ source: file.relative, sha: file.sha })))

  // ⑯ 已知问题与改进建议
  const issues = []
  const conflict = detectRuleConflicts({ agentRules, framework, nodes })
  issues.push(...conflict)
  const duplicates = detectDuplicateRules({ agentRules, framework, files })
  issues.push(...duplicates)
  const dangling = detectDanglingReferences(files)
  issues.push(...dangling)
  const stale = detectStaleByEvidence(nodes)
  issues.push(...stale)
  if (collected.limitations.length > 0) {
    issues.push({
      kind: 'scan-limit',
      severity: 'info',
      detail: collected.limitations.join('；'),
    })
  }
  if (collected.unreadable.length > 0) {
    issues.push({
      kind: 'unreadable',
      severity: 'warn',
      detail: `${collected.unreadable.length} 个文件读取失败：${collected.unreadable.map(item => item.relative).join('、')}`,
    })
  }
  push('issues', issues.length === 0 ? CONFIDENCE.observed : CONFIDENCE.inferred, issues,
    issues.length === 0 ? '未发现规则冲突、重复维护、失效引用或可判定的过期内容' : null)

  // ⑰ 相比上次体检的变化
  const delta = compareWithBaseline(files, baseline)
  push('delta', baseline === undefined ? CONFIDENCE.missing : CONFIDENCE.observed, [
    baseline === undefined
      ? { note: '无历史基线，本次建立初始基线' }
      : { note: `上次基线保存于 ${baseline.savedAt ?? '未知时间'}` },
    ...delta.entries.slice(0, 100),
  ], baseline === undefined ? '首次使用：本次为初始基线，无法比较' : null)

  // ⑱ 可复用知识及建议的调用方式
  const reusable = nodes
    .filter(file => (file.frontmatter.status ?? 'active') === 'active')
    .slice(0, 60)
    .map(file => ({
      source: file.relative,
      note: `可复用：${file.frontmatter.title ?? file.relative} —— 由任务需要时按路径读取，或在本插件「收集提炼」中作为关联对象`,
    }))
  push('reuse', reusable.length === 0 ? CONFIDENCE.missing : CONFIDENCE.observed, reusable,
    reusable.length === 0 ? null : '本项只引用已有知识的调用位置，不新建技能、不改规则（新建/修改须走独立审核流程）')

  // 警告：把"我不确定"的地方明写出来，而不是留给读者猜。
  if (byKind('framework').length === 0) warnings.push({ code: 'NO_FRAMEWORK', detail: '未找到 knowledge/framework.md —— 知识库总索引缺失' })
  if (nodes.length === 0) warnings.push({ code: 'NO_NODES', detail: '未找到知识节点（knowledge/nodes/*.md）' })
  if (agentRules === undefined) warnings.push({ code: 'NO_AGENTS', detail: '工作区根 AGENTS.md 缺失' })

  const baselineNext = {
    workspace: toRelative(collected.workspace ?? '', collected.workspace ?? ''),
    files: files.map(file => ({ relative: file.relative, sha: file.sha, bytes: file.bytes })),
    nodes: nodeIndex.map(node => ({
      id: node.id, title: node.title, version: node.version, updated: node.updated, source: node.source,
    })),
    skills: skills.map(file => file.relative),
    issues: issues.map(item => `${item.kind}:${String(item.detail ?? '').slice(0, 160)}`),
    context: { presetId: context.presetId ?? null },
    savedAt: isoTimestamp(),
  }

  return {
    items,
    delta,
    baseline: baselineNext,
    warnings,
    scope: {
      scannedFiles: files.length,
      scannedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      limitations: collected.limitations,
      unreadable: collected.unreadable,
    },
  }
}

/** 取一段原文（用于报告"保留影响行为的关键原文"）。 */
function excerptOf(text, pattern) {
  const match = pattern.exec(String(text ?? ''))
  if (match === null) return undefined
  const value = match[0].trim()
  return value.length > 700 ? `${value.slice(0, 700)}…` : value
}

/** 规则冲突：同一条规则在 AGENTS.md 与 framework.md 里出现且表述不同。 */
function detectRuleConflicts({ agentRules, framework }) {
  if (agentRules === undefined || framework === undefined) return []
  const norm = value => String(value ?? '').replace(/\s+/gu, '')
  const lines = value => norm(value).split(/[。；\n]/u).filter(line => line.length >= 8)
  const agentLines = new Set(lines(agentRules.text))
  const frameworkLines = new Set(lines(framework.text))
  const out = []
  // 冲突判据保守：只在"同一个主语句 + 明确的否定差异"时才报，避免把同义改写当冲突。
  for (const line of agentLines) {
    for (const other of frameworkLines) {
      if (line === other) continue
      const shared = longestCommonPrefix(line, other)
      if (shared.length < 12) continue
      const hasNegation = /不|禁止|勿|never|not/iu.test(line.slice(shared.length))
        !== /不|禁止|勿|never|not/iu.test(other.slice(shared.length))
      if (hasNegation) {
        out.push({
          kind: 'rule-conflict',
          severity: 'warn',
          detail: `AGENTS.md 与 knowledge/framework.md 可能对同一件事的规定相反：「${line.slice(0, 60)}」vs「${other.slice(0, 60)}」`,
          evidence: '两处公共前缀 ≥12 字符且否定词不同（保守判据，可能误报）',
        })
      }
    }
  }
  return out.slice(0, 10)
}

/** 重复维护：同一条规则在多个文件里各写一遍。 */
function detectDuplicateRules({ agentRules, framework, files }) {
  if (agentRules === undefined) return []
  const norm = value => String(value ?? '').replace(/\s+/gu, '').split(/[。；\n]/u).filter(line => line.length >= 16)
  const agentLines = new Set(norm(agentRules.text))
  const out = []
  for (const file of files) {
    if (file.relative === 'AGENTS.md') continue
    for (const line of norm(file.text)) {
      if (agentLines.has(line)) {
        out.push({
          kind: 'duplicate-rule',
          severity: 'info',
          detail: `同一句话同时出现在 AGENTS.md 与 ${file.relative}：「${line.slice(0, 60)}」`,
          evidence: '整行去空白后完全相同',
        })
      }
    }
  }
  return out.slice(0, 10)
}

/** 失效引用：正文里写到的相对路径在本工作区不存在。 */
function detectDanglingReferences(files) {
  const known = new Set(files.map(file => file.relative))
  const out = []
  for (const file of files) {
    const matches = String(file.text).matchAll(/`([A-Za-z0-9_./-]+\.(?:md|mjs|js|json|yml|yaml))`/gu)
    for (const match of matches) {
      const target = match[1]
      if (target.includes('node_modules')) continue
      if (known.has(target)) continue
      // 只报"看起来像工作区相对路径"的引用，不报 node_modules / 外部 URL / 通用示例。
      if (!/^(?:[A-Za-z0-9_-]+\/|[a-z0-9_-]+\.(?:md|mjs|js|json|yml|yaml)$)/u.test(target)) continue
      if (/^(package\.json|README\.md|LICENSE|CHANGELOG\.md)$/u.test(target)) continue
      out.push({
        kind: 'dangling-reference',
        severity: 'info',
        detail: `${file.relative} 引用了 ${target}，扫描范围内未找到该文件（可能在工作区之外，也可能是失效引用）`,
        evidence: '文件清单比对；未找到 ≠ 一定失效',
      })
    }
  }
  return out.slice(0, 20)
}

/** 过期判定：**必须有版本/时间/替代依据**，"文件旧"不算依据。 */
function detectStaleByEvidence(nodes) {
  const out = []
  for (const file of nodes) {
    const text = `${file.frontmatter.title ?? ''}\n${file.text}`
    for (const rule of STALENESS_EVIDENCE) {
      const match = rule.pattern.exec(text)
      if (match === null) continue
      out.push({
        kind: 'possibly-stale',
        severity: 'info',
        detail: `${file.relative} 可能已过期：命中判据「${rule.note}」（${match[0].slice(0, 40)}）`,
        evidence: rule.note,
      })
      break
    }
  }
  return out.slice(0, 20)
}

/** 与基线比较：按**内容指纹**，绝不按修改时间。 */
export function compareWithBaseline(files, baseline) {
  if (baseline === undefined || baseline === null) {
    return { available: false, entries: [], summary: { added: 0, updated: 0, removed: 0, unchanged: 0 } }
  }
  const previous = new Map((baseline.files ?? []).map(file => [file.relative, file.sha]))
  const current = new Map(files.map(file => [file.relative, file.sha]))
  const entries = []
  let added = 0
  let updated = 0
  let removed = 0
  let unchanged = 0
  for (const [relative, sha] of current) {
    const before = previous.get(relative)
    if (before === undefined) {
      added += 1
      entries.push({ source: relative, note: '新增' })
    } else if (before !== sha) {
      updated += 1
      entries.push({ source: relative, note: '内容变化（按内容指纹判定，非修改时间）' })
    } else {
      unchanged += 1
    }
  }
  for (const [relative] of previous) {
    if (!current.has(relative)) {
      removed += 1
      entries.push({ source: relative, note: '已不存在（可能在别处归档或删除）' })
    }
  }
  return { available: true, entries, summary: { added, updated, removed, unchanged } }
}

/**
 * 渲染人类可读的体检报告（markdown）。
 * @param {object} result {@link audit} 的输出
 * @param {{ workspaceLabel?: string, generatedAt?: string, baselineAvailable?: boolean, extraNotice?: string|null }} meta 元信息
 * @returns {string} markdown
 */
export function renderAuditReport(result, meta = {}) {
  const lines = []
  lines.push('# 知识体系体检报告')
  lines.push('')
  lines.push(`- 生成时间：${meta.generatedAt ?? isoTimestamp()}`)
  lines.push(`- 工作区：${meta.workspaceLabel ?? '(未绑定)'}`)
  lines.push(`- 扫描文件：${result.scope.scannedFiles} 个 / ${result.scope.scannedBytes} 字节`)
  lines.push(`- 基线：${result.delta.available ? '有（见 ⑰ 变化对比）' : '无（本次建立初始基线）'}`)
  lines.push('- 本报告为**只读**产物：未修改任何被检查文件，未执行其中任何指令。')
  lines.push(`- ${REDACTION_NOTICE}`)
  if (meta.extraNotice !== undefined && meta.extraNotice !== null && meta.extraNotice !== '') {
    lines.push(`- ${meta.extraNotice}`)
  }
  lines.push('')
  if (result.scope.limitations.length > 0) {
    lines.push('## 扫描范围与限制')
    lines.push('')
    for (const limitation of result.scope.limitations) lines.push(`- ${limitation}`)
    lines.push('')
  }
  if (result.scope.unreadable.length > 0) {
    lines.push('## 未读取或读取失败')
    lines.push('')
    for (const item of result.scope.unreadable) lines.push(`- ${item.relative}：${item.reason}`)
    lines.push('')
  }
  if (result.warnings.length > 0) {
    lines.push('## 需要先解决的结构问题')
    lines.push('')
    for (const warning of result.warnings) lines.push(`- [${warning.code}] ${warning.detail}`)
    lines.push('')
  }
  lines.push('## 体检结论（18 项）')
  lines.push('')
  lines.push('> 四档判定：`已确认（文件里读到）` / `推断` / `缺失` / `无法访问`。'
    + '「宿主实际加载了什么」不从文件推断，无法访问的项如实标注。')
  lines.push('')
  result.items.forEach((item, index) => {
    lines.push(`### ${index + 1}. ${item.title}`)
    lines.push('')
    lines.push(`- 判定：\`${confidenceLabel(item.confidence)}\``)
    if (item.note !== null) lines.push(`- 说明：${item.note}`)
    if (item.entries.length === 0) {
      lines.push('- （无条目）')
    } else {
      for (const entry of item.entries) {
        if (entry.source !== undefined) {
          const suffix = entry.note === undefined ? '' : ` —— ${entry.note}`
          lines.push(`- 来源：\`${entry.source}\`${suffix}`)
          if (entry.excerpt !== undefined) {
            lines.push('  ```text')
            for (const line of String(entry.excerpt).split('\n')) lines.push(`  ${line}`)
            lines.push('  ```')
          }
        } else if (entry.kind !== undefined) {
          lines.push(`- [${entry.severity ?? 'info'}] ${entry.detail}${entry.evidence === undefined ? '' : `（依据：${entry.evidence}）`}`)
        } else if (entry.note !== undefined) {
          lines.push(`- ${entry.note}`)
        }
      }
    }
    lines.push('')
  })
  lines.push('---')
  lines.push('')
  lines.push('本报告不构成对规则本身的裁决；新建技能或修改行为规则须转入独立审核流程。')
  return lines.join('\n')
}

/** 判定档位 → 中文标签。 */
export function confidenceLabel(confidence) {
  switch (confidence) {
    case CONFIDENCE.observed: return '已确认（文件里读到）'
    case CONFIDENCE.inferred: return '推断'
    case CONFIDENCE.missing: return '缺失'
    case CONFIDENCE.inaccessible: return '无法访问'
    default: return String(confidence)
  }
}

/** 最长公共前缀长度（规则冲突判据用）。 */
function longestCommonPrefix(left, right) {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left[index] === right[index]) index += 1
  return left.slice(0, index)
}
