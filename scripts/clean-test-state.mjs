#!/usr/bin/env node
/**
 * clean-test-state.mjs —— 把本插件留下的东西清掉，用于反复测试。
 *
 * ── ⚠️ 先看"影响面"，再看命令 ─────────────────────────────────────────────
 *   `--yes` **不加筛选**时：删除**该预设根下所有带本插件生成标记的预设** ＋ 工作区状态。
 *   只想删**一个**预设 ⇒ 用 `--only <预设 id>`。**注意本工具只删目录，不摘 profile 依赖**：
 *   删之前请先 `dsh plugin --profile <profile> remove @local/dsh-learn-preset-<预设 id>`
 *   （顺序反了 ⇒ 宿主启动提示跳过该 bundle、相关会话被拒绝恢复），删完再清
 *   `<工作区>/.dsh/learn-skills/known.json` 的占用。完整步骤见 `docs/删除预设.md`。
 *   不确定会删什么 ⇒ **先不加 `--yes` 跑一遍**（默认就是干跑，只列清单）。
 *
 * ── 本插件留痕的判定（判据都在文件里，不看目录名）────────────────────────
 *   ① 预设本体：`<workspace>/.dsh/preset-bundles/<id>/`（2.1.0 起；旧版在
 *      `<dshHome>/preset-bundles/`），且 `cordis.patch.yml` 含生成标记
 *      「由 @yiyunet/dsh-learn-skills 生成」⇒ 手工预设（如 `alpha`）永不被误删
 *   ② 工作区状态：`<workspace>/.dsh/learn-skills/`（会话断点／批次账／体检基线／
 *      变更日志／known 记录）
 *
 * ── 刻意**不删**的东西 ────────────────────────────────────────────────────
 *   工作区骨架（`AGENTS.md`／`knowledge/`／`inbox/`／`index/`／`data/`／`task/`／
 *   `reports/`／`.dsh/skills/`）：那里面可能已有你自己的内容，而插件没有留下
 *   "哪些目录是它建的"的可靠记录 ⇒ 宁可不删，只在末尾列出候选路径供你判断。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 *   node scripts/clean-test-state.mjs                        # 干跑：只列出会删什么（默认）
 *   node scripts/clean-test-state.mjs --only learn-1a2b3c     # 干跑：只针对某一个预设
 *   node scripts/clean-test-state.mjs --only learn-1a2b3c --yes   # 只删这一个（不动工作区状态）
 *   node scripts/clean-test-state.mjs --only a,b --with-state --yes
 *   node scripts/clean-test-state.mjs --yes                   # 删「所有本插件生成的预设 ＋ 工作区状态」
 *   node scripts/clean-test-state.mjs --state-only --yes       # 只清工作区状态（保留预设）
 *   node scripts/clean-test-state.mjs --workspace D:/ws --yes    # 预设根默认随工作区走
 *   node scripts/clean-test-state.mjs --preset-root D:/old --scan # 显式指定（如旧版宿主级落点）
 *
 * ⚠️ 删完要**重启 DSH 宿主**（预设名册一进程只挂载一次），再**新建会话**。
 */

import { lstat, readFile, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 生成标记：预设的 patch 里出现它，才算本插件的生成物。
 * 新式 bundle 看 `cordis.patch.yml`，旧式目录回退看 `agent.cordis.yml`。
 */
export const GENERATED_MARKER = '@yiyunet/dsh-learn-skills'

/**
 * 默认预设根：**随工作区走**（2.1.0 起与 `plugin-src/host/flows.mjs` 的
 * `config.presetDir` 同口径 —— `<工作区>/.dsh/preset-bundles`）。
 *
 * ⚠️ 2.0.0 及更早的宿主级落点 `<dshHome>/preset-bundles` **不再被默认扫描**：
 *   那里现在住着的是部署方自己的组合包（如 `dsh-migrated-presets`），
 *   不属于本插件，**不该被本工具当成自己的产物**。要处理旧落点请显式传 `--preset-root`。
 * @param {string} [workspace] 工作区根（默认当前目录）
 * @returns {string} 绝对路径
 */
export function defaultPresetRoot(workspace) {
  return join(resolve(workspace ?? process.cwd()), '.dsh', 'preset-bundles')
}

/**
 * 从 bundle patch 取显示名。
 *
 * patch 里有**两个** `name:`（Loader 行的包名、config 里的显示名），故先按
 * `id: <presetId>` 定位声明块，再取块内第一个非包名的 `name:`。
 * @param {string} patch patch 文本
 * @param {string} presetId 预设 id（目录名）
 * @returns {string} 显示名；取不到时回退为预设 id
 */
function presetDisplayName(patch, presetId) {
  const lines = patch.split(/\r?\n/u)
  const anchor = lines.findIndex(line => new RegExp(`^\\s*id:\\s*${presetId}\\s*$`, 'u').test(line))
  const scope = anchor >= 0 ? lines.slice(anchor + 1) : lines
  for (const line of scope) {
    const match = /^\s*name:\s*(.+)$/u.exec(line)
    if (match === null) continue
    const value = match[1].trim().replace(/^["']|["']$/gu, '')
    if (value === '@deepseek-ai/dsh-agent-preset') continue
    return value
  }
  return presetId
}

/**
 * 读一个预设目录的"生成标记源"与显示名（新式 bundle 与旧式目录都认）。
 * @param {string} path 预设目录
 * @param {string} id 预设 id（目录名）
 * @returns {Promise<{ manifest: string, name: string }>} 标记源与显示名
 */
async function readPresetMeta(path, id) {
  const patch = await readFile(join(path, 'cordis.patch.yml'), 'utf8').catch(() => '')
  if (patch !== '') return { manifest: patch, name: presetDisplayName(patch, id) }
  const legacy = await readFile(join(path, 'preset.yml'), 'utf8').catch(() => '')
  return {
    manifest: await readFile(join(path, 'agent.cordis.yml'), 'utf8').catch(() => ''),
    name: /^name:\s*(.+)$/mu.exec(legacy)?.[1]?.trim() ?? id,
  }
}

/** 工作区状态目录（与 `directories.stateDir` 默认值一致）。 */
const STATE_DIR = join('.dsh', 'learn-skills')

/**
 * 列出本插件的产物（**只读**，不删任何东西），并标出"本次会删哪些"。
 *
 * 影响面规则：
 *   · 给了 `only` ⇒ **只**选中列出的预设 id（工作区状态除非 `withState` 否则不动）；
 *   · 没给 `only` ⇒ 选中**所有**本插件生成的预设 ＋ 工作区状态（`withState !== false`）。
 * @param {{ presetRoot?: string, workspace?: string, only?: string[], withState?: boolean, stateOnly?: boolean }} [options] 目标与筛选
 * @returns {Promise<object>} 清理计划
 */
export async function planCleanup(options = {}) {
  const workspace = resolve(options.workspace ?? process.cwd())
  const presetRoot = options.presetRoot === undefined ? defaultPresetRoot(workspace) : resolve(options.presetRoot)
  const statePath = join(workspace, STATE_DIR)
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only.map(String)) : undefined
  const stateOnly = options.stateOnly === true
  // 影响面：只删指定 id 时，**默认不动**工作区状态（那属于"重置插件记忆"，是另一件事）。
  const stateSelected = stateOnly || (only === undefined ? options.withState !== false : options.withState === true)
  const notes = []
  const wanted = []

  // ⚠️ 必须**总是**扫目录：给了 `only` 也得先扫出候选，再按 id 筛选。
  //    此前写成 `only === undefined || stateOnly ? … : []`，于是 `--only`
  //    一个预设都选不中（`presets` 恒为空，`applyCleanup` 什么也不删）——
  //    与本节 JSDoc「给了 only ⇒ 只选中列出的预设 id」直接矛盾。
  const entries = await readdir(presetRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(presetRoot, entry.name)
    const info = await lstat(path).catch(() => undefined)
    if (info === undefined) continue
    if (!info.isDirectory() && !info.isSymbolicLink()) continue

    const { manifest, name } = await readPresetMeta(path, entry.name)
    const symlink = info.isSymbolicLink()
    const generated = !symlink && manifest.includes(GENERATED_MARKER)
    const selected = stateOnly ? false : (only === undefined ? generated : generated && only.has(entry.name))
    if (symlink) notes.push(`${entry.name}：是符号链接 —— 跳过（不跟随，也不删目标）`)
    if (only !== undefined && only.has(entry.name) && !generated) {
      notes.push(`${entry.name}：你点名要删，但它没有本插件的生成标记（不是本插件生成的）—— 不会删。`)
    }
    wanted.push({ id: entry.name, name, path, symlink, generated, selected })
  }

  const stateExists = await lstat(statePath).then(() => true).catch(() => false)
  return {
    presetRoot,
    workspace,
    presets: wanted,
    state: { path: statePath, exists: stateExists, selected: stateSelected },
    notes,
    scope: only === undefined ? 'all-generated' : 'only-listed',
    requested: only === undefined ? undefined : [...only],
  }
}

/**
 * 执行清理计划（只删计划里 `selected` 的那些）。
 * @param {object} plan `planCleanup()` 的返回值
 * @returns {Promise<{ removed: string[], skipped: string[] }>} 结果
 */
export async function applyCleanup(plan) {
  const removed = []
  const skipped = []

  for (const preset of plan.presets) {
    if (preset.selected !== true) {
      skipped.push(preset.generated
        ? `预设「${preset.name}」（${preset.id}）—— 是插件生成的，但本次没选中`
        : `预设「${preset.name}」（${preset.id}）—— 没有本插件的生成标记，视为你自己的预设`)
      continue
    }
    // 二次保险：预设根自己绝不整删（防路径拼错）。
    if (preset.path === plan.presetRoot || !preset.path.startsWith(plan.presetRoot + sep)) {
      skipped.push(`预设「${preset.name}」—— 路径不在预设根之内，拒绝删除：${preset.path}`)
      continue
    }
    await rm(preset.path, { recursive: true, force: true })
    removed.push(`预设「${preset.name}」（${preset.id}）`)
  }

  if (plan.state.selected === true && plan.state.exists) {
    await rm(plan.state.path, { recursive: true, force: true })
    removed.push(`工作区状态 ${plan.state.path}`)
  }
  return { removed, skipped }
}

/** 预设 bundle 的两件套（官方 SKILL 原文："exactly two files"）。缺任何一件 ⇒ 这个 id 占着目录，却装不进 roster。 */
const PRESET_FILES = ['package.json', 'cordis.patch.yml']

/** 默认的工作区登记表（宿主 `ctx.workspaceRegistry` 的持久化落点）。 */
export const DEFAULT_WORKSPACE_REGISTRY = join(homedir(), '.dsh', 'storages', 'workspace.json')

/**
 * 只读体检：把 `.dsh` 里的**残留**逐类指出来（**不删任何东西**）。
 *
 * 三类残留各有判据，都能机器识别：
 *   ① **预设侧**：bundle 两件套缺件（残缺 ⇒ 目录占着 id 却装不起来）、
 *      本插件生成但显示名重复（反复测试的典型产物）；
 *   ② **登记侧**：`workspace.json` 里 `tables.workspaces[*].path` **已不存在**（孤儿登记 ——
 *      删了目录却没走 GUI 删除，就会留下它）；
 *   ③ **引用侧**：工作区 `known.json` 里记着、预设根却已没有的 id（**死引用** ——
 *      会让下次同名生成拿到 `-2` 后缀）。
 * @param {{ presetRoot?: string, workspace?: string, workspaceRegistryPath?: string }} [options] 目标
 * @returns {Promise<object>} 体检报告
 */
export async function scanResidue(options = {}) {
  const workspace = resolve(options.workspace ?? process.cwd())
  const presetRoot = options.presetRoot === undefined ? defaultPresetRoot(workspace) : resolve(options.presetRoot)
  const registryPath = resolve(options.workspaceRegistryPath ?? DEFAULT_WORKSPACE_REGISTRY)
  const notes = []

  const presets = []
  const entries = await readdir(presetRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(presetRoot, entry.name)
    const info = await lstat(path).catch(() => undefined)
    if (info === undefined || (!info.isDirectory() && !info.isSymbolicLink())) continue
    const { manifest, name } = await readPresetMeta(path, entry.name)
    const missing = []
    for (const file of PRESET_FILES) {
      const present = await lstat(join(path, file)).then(() => true).catch(() => false)
      if (!present) missing.push(file)
    }
    presets.push({
      id: entry.name,
      name,
      path,
      symlink: info.isSymbolicLink(),
      generated: !info.isSymbolicLink() && manifest.includes(GENERATED_MARKER),
      missing,
      incomplete: missing.length > 0,
    })
  }
  const nameCounts = new Map()
  for (const preset of presets) nameCounts.set(preset.name, (nameCounts.get(preset.name) ?? 0) + 1)
  for (const preset of presets) {
    preset.duplicateName = (nameCounts.get(preset.name) ?? 0) > 1
    preset.residual = preset.generated && (preset.incomplete || preset.duplicateName)
  }

  let registry = { path: registryPath, exists: false, workspaces: [] }
  const rawRegistry = await readFile(registryPath, 'utf8').catch(() => undefined)
  if (rawRegistry !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(rawRegistry)
    } catch {
      notes.push(`${registryPath}：JSON 解析失败（宿主运行时不要手改它）`)
    }
    const workspaces = []
    for (const [id, record] of Object.entries(parsed?.tables?.workspaces ?? {})) {
      const path = typeof record?.path === 'string' ? record.path : null
      const exists = path === null ? null : await lstat(path).then(() => true).catch(() => false)
      workspaces.push({
        id,
        title: typeof record?.title === 'string' ? record.title : '',
        path,
        exists,
        sessions: Array.isArray(record?.sessionIds) ? record.sessionIds.length : 0,
      })
    }
    registry = { path: registryPath, exists: true, workspaces }
  }

  const knownPath = join(workspace, STATE_DIR, 'known.json')
  const rawKnown = await readFile(knownPath, 'utf8').catch(() => undefined)
  let known = { path: knownPath, exists: rawKnown !== undefined, names: [], deadIds: [] }
  if (rawKnown !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(rawKnown)
    } catch {
      notes.push(`${knownPath}：JSON 解析失败`)
    }
    const ids = new Set(presets.map(preset => preset.id))
    const recorded = Array.isArray(parsed?.presetIds) ? parsed.presetIds.map(String) : []
    known = {
      path: knownPath,
      exists: true,
      names: Array.isArray(parsed?.presetNames) ? parsed.presetNames.map(String) : [],
      deadIds: recorded.filter(id => !ids.has(id)),
    }
  }

  return { presetRoot, workspace, presets, registry, known, notes }
}

/** 打印体检报告（只读；末尾按类给"怎么清"的命令）。 */
function printScan(report) {
  const generated = report.presets.filter(preset => preset.generated)
  const residuals = report.presets.filter(preset => preset.residual)
  const incomplete = report.presets.filter(preset => preset.incomplete)
  const orphans = report.registry.workspaces.filter(item => item.exists === false)

  console.log('\n=== 残留体检（只读，不删任何东西）===')
  console.log(`预设根：${report.presetRoot}`)
  console.log(`工作区：${report.workspace}`)

  console.log(`\n① 预设：共 ${report.presets.length} 个（本插件生成 ${generated.length} 个）`)
  for (const preset of report.presets) {
    const tags = []
    if (preset.generated) tags.push('插件生成')
    if (preset.incomplete) tags.push(`残缺：缺 ${preset.missing.join(' / ')}`)
    if (preset.duplicateName) tags.push('显示名重复')
    if (preset.residual) tags.push('★疑似测试残留')
    console.log(`  · ${preset.id}　「${preset.name}」${tags.length === 0 ? '' : `　—— ${tags.join('｜')}`}`)
  }
  if (report.presets.length === 0) console.log('  （无）')

  console.log(`\n② 工作区登记 ${report.registry.path}：`
    + (report.registry.exists
      ? `共 ${report.registry.workspaces.length} 条，其中**孤儿 ${orphans.length} 条**（路径已不存在）`
      : '不存在'))
  for (const item of report.registry.workspaces) {
    const mark = item.exists === true ? '✓ 路径在' : item.exists === false ? '✗ **路径已不存在**' : '? 无 path'
    console.log(`  · ${mark}　${item.title === '' ? '(无标题)' : item.title}　${item.path ?? ''}　（会话 ${item.sessions} 条）`)
  }

  console.log(`\n③ 工作区状态 ${report.known.path}：${report.known.exists ? '存在' : '不存在'}`)
  if (report.known.exists) {
    console.log(`  · 记录在案：预设显示名 ${report.known.names.length === 0 ? '（无）' : report.known.names.join(' / ')}`)
    console.log(`  · **死引用（记了、目录却没了）：${report.known.deadIds.length} 个**`
      + (report.known.deadIds.length === 0 ? '' : `　—— ${report.known.deadIds.join(' / ')}`))
  }
  for (const note of report.notes) console.log(`  ⚠️ ${note}`)

  console.log('\n── 怎么清（按类给命令）────────────────────────────────────────────')
  for (const preset of residuals) {
    console.log(`  · 疑似测试残留「${preset.id}」⇒ node scripts/clean-test-state.mjs --only ${preset.id} --yes`)
  }
  if (incomplete.length > 0 && residuals.length === 0) {
    console.log('  · 有残缺预设（未带生成标记）：宿主会认为"该 id 被占着却装不起来"')
    console.log('    ⇒ 补回缺的文件，或（确认是自己的）手工删该目录')
  }
  if (orphans.length > 0) {
    console.log(`  · 孤儿工作区登记 ${orphans.length} 条：**不要手改 ${report.registry.path}**（宿主运行时尤其不要）`)
    console.log('    ⇒ 正解：重启宿主后，在 GUI 的工作区列表里把这条删掉（宿主有 workspaceRegistry.delete）')
  }
  if (report.known.deadIds.length > 0) {
    console.log('  · 死引用会让"同名再生成"拿到 -2 后缀；清法＝清该工作区状态一次：')
    console.log(`    node scripts/clean-test-state.mjs --workspace "${report.workspace}" --state-only --yes`)
  }
  if (residuals.length === 0 && incomplete.length === 0 && orphans.length === 0
    && report.known.deadIds.length === 0) {
    console.log('  · 未发现残留（预设两件套齐、登记无孤儿、无死引用）。')
  }
  console.log('')
}

/** 打印计划与下一步。 */
function print(plan, { applied, result }) {
  const selected = plan.presets.filter(preset => preset.selected === true)
  const generated = plan.presets.filter(preset => preset.generated)
  const kept = plan.presets.filter(preset => preset.selected !== true)

  console.log(`\n预设根：${plan.presetRoot}`)
  console.log(`工作区：${plan.workspace}`)
  console.log(`影响面：${plan.scope === 'only-listed'
    ? `**只处理你点名的预设**（${(plan.requested ?? []).join(' / ')}）`
    : '**所有本插件生成的预设 ＋ 工作区状态**（不加筛选的默认面）'}\n`)

  console.log(`本次${applied ? '已删' : '将删'}（${selected.length} 个预设）：`)
  for (const preset of selected) console.log(`  · ${preset.id}　「${preset.name}」`)
  if (selected.length === 0) console.log('  （无）')

  console.log(`\n保持不动（${kept.length} 个，含你自己的手工预设）：`)
  for (const preset of kept) {
    const tag = preset.generated ? '插件生成·本次未选中' : '非插件生成'
    console.log(`  · ${preset.id}　「${preset.name}」　（${tag}）`)
  }
  if (kept.length === 0) console.log('  （无）')

  console.log(`\n工作区状态 ${plan.state.path}：`
    + (plan.state.selected === true ? (plan.state.exists ? (applied ? '已删' : '将删') : '不存在') : '**本次不动**'))
  for (const note of plan.notes) console.log(`  ⚠️ ${note}`)

  if (generated.length > 1 && plan.scope === 'all-generated') {
    console.log(`\n⚠️ 本插件生成的预设共 ${generated.length} 个 —— 不加筛选会把它们**全部**删掉。`)
    console.log('   只想删一个：`--only <预设 id>`；**删前先摘依赖**'
      + '（`dsh plugin --profile <profile> remove @local/dsh-learn-preset-<预设 id>`，'
      + '本工具不替你摘），删后清 `known.json` 占用。步骤见 `docs/删除预设.md`。')
  }

  if (applied && result !== undefined) {
    console.log(`\n结果：删除 ${result.removed.length} 项，跳过 ${result.skipped.length} 项。`)
    for (const item of result.skipped) console.log(`  · 跳过：${item}`)
  }

  console.log('\n说明：**工作区骨架不会被删** —— 插件没有留下"哪些目录是它建的"的可靠记录，')
  console.log('      而那里面可能有你自己的内容。若这次测试用的是**专门新建的**工作区，')
  console.log('      直接把整个工作区目录删掉/另建一个，比逐目录清理更干净。')

  if (!applied) {
    console.log('\n这是**干跑**（什么都没删）。确认无误后加 `--yes` 执行。')
  } else {
    console.log('\n⚠️ 下一步：**重启 DSH 宿主**（预设名册一进程只挂载一次；不重启的话，')
    console.log('    删掉的预设仍会出现在列表里），然后**新建会话**再测试。')
  }
}

/** 收集重复出现的 `--only`（支持逗号分隔与多次给出）。 */
function collectOnly(args) {
  const ids = []
  for (let at = 0; at < args.length; at += 1) {
    if (args[at] !== '--only') continue
    const value = args[at + 1]
    if (value === undefined || value.startsWith('--')) continue
    for (const piece of value.split(',')) {
      const id = piece.trim()
      if (id !== '') ids.push(id)
    }
  }
  return ids
}

async function main(argv) {
  const args = argv.slice(2)
  const applied = args.includes('--yes')
  const valueOf = flag => {
    const at = args.indexOf(flag)
    return at === -1 ? undefined : args[at + 1]
  }
  // `--scan`：只读体检（识别残留），不删任何东西 —— 给它 `--yes` 也不会删。
  if (args.includes('--scan')) {
    printScan(await scanResidue({
      presetRoot: valueOf('--preset-root'),
      workspace: valueOf('--workspace'),
      workspaceRegistryPath: valueOf('--registry'),
    }))
    return
  }

  const plan = await planCleanup({
    presetRoot: valueOf('--preset-root'),
    workspace: valueOf('--workspace'),
    only: collectOnly(args),
    withState: args.includes('--with-state'),
    stateOnly: args.includes('--state-only'),
  })
  const result = applied ? await applyCleanup(plan) : undefined
  print(plan, { applied, result })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv)
}

export default planCleanup
