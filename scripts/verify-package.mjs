/**
 * verify-package.mjs —— 发布契约校验（`npm run verify`，CI 会跑）。
 *
 * 校验的不是"代码对不对"，而是**发布形态有没有被破坏**。每条断言都对应一个
 * 真实失败模式（本部门在 `@yiyunet/dsh-dingtalk-connector` 上逐条踩过）：
 *
 *   ① 必需文件齐全（源码 + 构建产物 + 文档）
 *   ② 任何依赖节与 lock 文件都不得出现 @deepseek-ai/dsh-*
 *      —— DSH 运行时包用模块局部 Symbol 做 key，装第二份物理副本会破坏 Host 查找
 *   ③ 客户端产物必须注册正确的装载器 id 与槽位契约
 *   ④ 客户端产物不得含 ESM 语法（lib/ 是 esbuild 产物）
 *   ⑤ RPC 端点名在宿主真源 / 客户端真源 / 客户端产物三处一致
 *   ⑥ 四个入口的名称与顺序在宿主真源、客户端真源、客户端产物三处一致
 *   ⑦ 全仓不得含本机绝对路径与凭证形态；可选叠加私有词表扫描
 *   ⑧ files 白名单自洽 + **安装期脚本禁则**（preinstall / install / postinstall）
 *   ⑨ 宿主 inject 声明只引用 base bundle 里真实存在的服务
 *      —— 把可选能力写进 inject 会让插件在缺该能力的部署里**整体 inactive**
 *   ⑩ 客户端产物必须带"提交在 wrapper factory 内部"的装配证据
 *
 *   附 ⑥-b（2.1.0 增；2026-09 修订）：**预设新架构的两条硬纪律**——
 *   宿主半侧的 `installBundle(...)` 只允许出现在**人工触发区**（`installPreset`，锚点标记
 *   `人工触发区·install-on-click`）：生成路径（`init` / `finalize`）一律不得安装，且安装按钮
 *   必须带"会在宿主进程执行新代码"的显式警示；身份判据必须来自
 *   `ctx.agentPresets` 名册，且必须有"名册不可用 ⇒ 拒绝创建"的分支
 *   （官方：重复的 preset ID 会导致声明加载失败）。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

// 标记查找与标记表来自**同一个**模块，不再各自留一份实现。
//
// 教训：这里曾经有一份本地 `findMarker`，与 markers.mjs 那份是两份实现。
// 两份实现漂移的后果极其难查 —— 会出现"构建说 OK、verify 说缺"的自相矛盾，
// 而且两边都不算错，只是对"什么算命中"的判断不同。
import { CLIENT_EXTERNAL as EXPECTED_CLIENT_EXTERNAL, ENTRY_LABELS, findMarker } from './markers.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const failures = []
const warnings = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

function warn(condition, message) {
  if (!condition) warnings.push(message)
}

async function readIfExists(relativePath) {
  try {
    return await readFile(resolve(ROOT, relativePath), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function readJson(relativePath) {
  const text = await readIfExists(relativePath)
  if (text === undefined) {
    failures.push(`缺少必需文件：${relativePath}`)
    return {}
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    failures.push(`${relativePath} 不是合法 JSON：${error.message}`)
    return {}
  }
}

/** 递归列出源码文件（跳过产物与依赖目录）。 */
async function sourceFiles(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (['node_modules', 'lib', '.git', '.lib-staging', '.lib-backup'].includes(entry.name)) continue
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) await sourceFiles(path, out)
    else out.push(path)
  }
  return out
}

// ── ① 必需文件 ────────────────────────────────────────────────────────────
const REQUIRED = [
  'lib/index.mjs',
  'lib/client.js',
  'plugin-src/client/index.mjs',
  'plugin-src/client/impl.mjs',
  'plugin-src/host/index.mjs',
  'plugin-src/host/flows.mjs',
  'plugin-src/host/paths.mjs',
  'plugin-src/host/fsx.mjs',
  'plugin-src/host/knowledge.mjs',
  'plugin-src/host/status.mjs',
  'plugin-src/host/audit.mjs',
  'plugin-src/host/redact.mjs',
  'plugin-src/host/preset.mjs',
  'plugin-src/host/rpc.mjs',
  'scripts/build.mjs',
  'scripts/markers.mjs',
  'scripts/verify-package.mjs',
  'scripts/static-check.mjs',
  'scripts/inspect-bundle.mjs',
  'scripts/clean-test-state.mjs',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'CHANGELOG.md',
  'docs/兼容性核验.md',
  'docs/迁移与兼容.md',
  'docs/删除预设.md',
  'docs/测试.md',
  'docs/测试步骤.md',
  'docs/反复测试-清理流程.md',
  'test/paths.test.mjs',
  'test/fsx.test.mjs',
  'test/knowledge.test.mjs',
  'test/audit.test.mjs',
  'test/flows.test.mjs',
  'test/build.test.mjs',
  'test/rpc.test.mjs',
  'test/envelope.test.mjs',
  'test/clean-test-state.test.mjs',
  'test/fixtures.mjs',
]
for (const relativePath of REQUIRED) {
  const info = await stat(resolve(ROOT, relativePath)).catch(() => undefined)
  check(info !== undefined && info.isFile(), `缺少必需文件：${relativePath}`)
}

const manifest = await readJson('package.json')

// ── ②-b lock 与 manifest 版本一致性 ────────────────────────────────────────
// 为什么单钉一条：`npm ci`（CI 的安装步）判据是 **lock 与 package.json 严格一致**，
// 不一致即 `EUSAGE: npm ci can only install packages when your package.json and
// package-lock.json are in sync`。
// ⚠️ 本地之所以看不见：**`npm test` / `npm run build` / `npm run verify` 都不读 lock**
// ⇒ 四项本地门禁全绿而 CI 首跑即红（实测：lock 停在 2.1.0、manifest 已 2.2.0）。
// 与 B1（`files`×`link:`）、B7（`postinstall`×pnpm）同型：**字段只在另一条路径上被读**。
{
  const lock = await readJson('package-lock.json')
  if (lock !== undefined && lock.version !== undefined) {
    check(lock.version === manifest?.version,
      `package-lock.json 的 version（${String(lock.version)}）与 package.json 的 version`
      + `（${String(manifest?.version)}）不一致 —— CI 的 \`npm ci\` 会直接报 EUSAGE。`
      + '修法：`npm install --package-lock-only`')
    const rootPkg = lock.packages?.['']
    if (rootPkg !== undefined) {
      check(rootPkg.version === manifest?.version,
        `package-lock.json 的 packages[""].version（${String(rootPkg.version)}）与 package.json`
        + `（${String(manifest?.version)}）不一致 —— 同上，\`npm ci\` 会失败`)
    }
  }
}

// ── ② 依赖节不得出现宿主运行时包 ──────────────────────────────────────────
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
for (const section of DEP_SECTIONS) {
  for (const name of Object.keys(manifest?.[section] ?? {})) {
    if (section === 'peerDependencies' && name === '@deepseek-ai/cordis') continue
    check(!name.startsWith('@deepseek-ai/dsh-'),
      `${section} 里出现了宿主运行时包 ${name} —— 装第二份物理副本会破坏 Host 的 Symbol 查找`)
  }
}
for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']) {
  const text = await readIfExists(lock)
  if (text === undefined) continue
  check(!/@deepseek-ai\/dsh-/u.test(text), `${lock} 里出现了 @deepseek-ai/dsh-* —— 同上，会破坏宿主查找`)
}

// ── ③ 客户端产物：装载器 id / 槽位契约 / 四个入口 ────────────────────────
const clientBundle = await readIfExists('lib/client.js') ?? ''
const clientSource = await readIfExists('plugin-src/client/impl.mjs') ?? ''
const hostIndex = await readIfExists('plugin-src/host/index.mjs') ?? ''
const hostRpc = await readIfExists('plugin-src/host/rpc.mjs') ?? ''

for (const [label, needle] of [
  ['装载器 id', '@yiyunet/dsh-learn-skills'],
  ['槽位契约', 'conversation.input.left'],
  ['菜单标题', 'AI学习'],
  ['RPC 端点名', 'dsh-learn-skills'],
]) {
  check(findMarker(clientBundle, needle) !== undefined,
    `lib/client.js 里找不到${label}「${needle}」—— 产物与真源漂移`)
}

// 诊断：产物自查（只在缺标记时打印，免得平时刷屏）。
// 这条是给"构建说 OK、verify 说缺"这种自相矛盾准备的 —— 把实况摊开，别让人猜。
if (clientBundle !== '') {
  const probe = ENTRY_LABELS.filter(label => findMarker(clientBundle, label) === undefined)
  if (probe.length > 0) {
    const escapes = (clientBundle.match(/\\u[0-9a-fA-F]{4}/gu) ?? []).length
    console.log('  ── lib/client.js 诊断 ──')
    console.log(`     大小：${Buffer.byteLength(clientBundle, 'utf8')} 字节`)
    console.log(`     \\u 转义序列出现次数：${escapes}`)
    console.log(`     冒烟：占位符残留=${clientBundle.includes('__DSH_CLIENT_BUNDLE__')}`
      + ` 全局名=${clientBundle.includes('__DshLearnSkills')}`
      + ` 装载器=${clientBundle.includes('__ModuleLoader__')}`)
    console.log(`     开头 300 字符：${JSON.stringify(clientBundle.slice(0, 300))}`)
    console.log('  ────────────────────────')
  }
}

/** 四个入口的固定顺序与名称由 markers.mjs 单一提供（与 build.mjs、客户端真源共用一份）。 */
for (const entry of ENTRY_LABELS) {
  check(findMarker(clientSource, entry) !== undefined, `客户端真源里找不到入口「${entry}」`)
  check(findMarker(clientBundle, entry) !== undefined, `lib/client.js 里找不到入口「${entry}」`)
  check(hostIndex.includes(entry) || (await readIfExists('plugin-src/host/flows.mjs') ?? '').includes(entry),
    `宿主真源里找不到入口「${entry}」`)
}
// 顺序断言：在客户端真源的 MENU 数组里，四个 id 必须按固定次序出现。
const menuBlock = /const MENU = \[([\s\S]*?)\]/u.exec(clientSource)
check(menuBlock !== null, '客户端真源里找不到 `const MENU = [...]` —— 菜单顺序无从断言')
if (menuBlock !== null) {
  const ids = [...menuBlock[1].matchAll(/id:\s*'([a-z]+)'/gu)].map(match => match[1])
  check(JSON.stringify(ids) === JSON.stringify(['init', 'distill', 'upgrade', 'audit']),
    `菜单顺序被改动：期望 init/distill/upgrade/audit，实得 ${ids.join('/')}`)
}

// 客户端真源不得 import 白名单以外的裸模块（平台冻结表只给 react 系）。
{
  const bare = new Set()
  for (const pattern of [
    /^\s*import\s+[^'"]*?from\s*['"]([^'"]+)['"]/gmu,
    /^\s*import\s*['"]([^'"]+)['"]/gmu,
  ]) {
    for (const match of clientSource.matchAll(pattern)) bare.add(match[1])
  }
  for (const specifier of bare) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue
    check(EXPECTED_CLIENT_EXTERNAL.includes(specifier),
      `客户端真源引入了非白名单裸模块 ${specifier}（平台冻结模块表只保证 ${EXPECTED_CLIENT_EXTERNAL.join(' / ')}）`)
  }
}

// ── ④ 客户端产物不得含 ESM 语法 ───────────────────────────────────────────
check(!/^\s*export\s+(default|\{|const|function|class)/mu.test(clientBundle),
  'lib/client.js 里出现 ESM export —— 说明源码未经 esbuild 打包就被发出来了')
check(!/^\s*import\s+[^'"]*from\s*['"]/mu.test(clientBundle),
  'lib/client.js 里出现 ESM import —— 同上')

// ── ⑤ RPC 端点名三处一致 ──────────────────────────────────────────────────
const endpointFromHost = /export const RPC_ENDPOINT = '([^']+)'/u.exec(hostRpc)?.[1]
const endpointFromClient = /const RPC_ENDPOINT = '([^']+)'/u.exec(clientSource)?.[1]
check(endpointFromHost !== undefined, '宿主 rpc.mjs 里找不到 RPC_ENDPOINT 声明')
check(endpointFromClient !== undefined, '客户端 impl.mjs 里找不到 RPC_ENDPOINT 声明')
check(endpointFromHost === endpointFromClient,
  `RPC 端点名不一致：宿主「${String(endpointFromHost)}」vs 客户端「${String(endpointFromClient)}」`)

// ── ⑤-b RPC 注册必须是「两段式」────────────────────────────────────────────
// 为什么单独钉一条：实测真机症状＝菜单能弹、斜杠命令可用，点菜单报
// `transport failure for /api/dsh-learn-skills: HTTP 404`。
// 根因＝注册只在 `apply()` 那一刻试一次 `ctx.connection`，而 `connection`
// 属于 Web 运行时那一层、当时**尚未就绪** ⇒ 插件安静放弃注册。
// `connection` 不许进静态 `inject`（见 ⑥，那会让无 Web 运行时的部署整体 inactive），
// 所以只剩一条正路：**挂到它就绪之后**（`ctx.inject(['connection'], …)`）。
check(/\bctx\.inject\(\s*\[[^\]]*'connection'[^\]]*\]/u.test(hostRpc),
  'rpc.mjs 里找不到 ctx.inject([\'connection\'], …) —— connection 不在静态 inject 里，'
  + '就必须"挂到它就绪之后再注册"，否则输入区菜单必 404（实测过）')

// ── ⑥ 宿主 inject 只引用 base bundle 里真实存在的服务 ────────────────────
const injectMatch = /export const inject = \[([^\]]*)\]/u.exec(hostIndex)
check(injectMatch !== null, '宿主 index.mjs 里找不到 inject 声明')
const injectNames = injectMatch === null
  ? []
  : [...injectMatch[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
check(injectNames.includes('userQuestions'),
  '宿主 inject 必须包含 userQuestions —— 六轮问答用它（ctx.userQuestions.ask）')
check(injectNames.includes('commands'),
  '宿主 inject 必须包含 commands —— 斜杠命令 /learn 用它')
/** 宿主平面可选能力（不该进 inject 的）：这些一律走 ctx.get() 降级。 */
const OPTIONAL_SERVICES = ['agents', 'workspaceRegistry', 'connection', 'tools', 'fs', 'agentPresets', 'pluginManager']
for (const name of injectNames) {
  check(!OPTIONAL_SERVICES.includes(name),
    `inject 里出现了可选服务 ${name} —— 它会让插件在缺该能力的部署里整体 inactive，应改用 ctx.get()`)
}

// ── ⑥-b 预设新架构的两条硬纪律（2.1.0 增；2026-09 修订为"人工触发区"判据）──
//
// ① **不得无确认安装**（原判据是"不得出现 installBundle 调用"，2026-09 修订）：
//    安装 bundle 会在 Host 进程执行新代码。官方入口 `plugin_manager` 工具为此
//    **强制**弹 `danger-full-access` 审批（`plugin-manager/src/tools.ts:38-42`，
//    `approveEscalation`），而服务方法 `installBundle()` 本身**没有审批闸**
//    （`plugin-manager/src/index.ts:461-462`，`@Remote`）—— 插件若在**生成路径**里
//    直接调它，就等于**替用户越权**。
//
//    ⚠️ 修订理由（方案 A′，由老板裁定）：原判据把"无人确认的自动安装"与
//    "人工点击触发的安装"一并禁掉了。但本插件的界面要求是"点了就装、不让人去找
//    预设 id"，于是需要把两者**分开**：
//      · 允许：用户按下界面「安装预设」按钮 ⇒ RPC `installPreset` ⇒ 调
//        `installBundle`。那一次点击即审批动作，且按钮文案写明会在宿主进程
//        执行新代码。
//      · 禁止：`init` / `finalize` 等**生成路径**中出现任何安装调用。
//    修订后的判据强度如实说明（**不宣称它严于原判据**）：它由"锚点标记 + 调用位置"
//    两部分组成，能挡住"生成路径里偷偷装"，但**不能**阻止有人刻意把标记搬到别处 ——
//    这属于"故意绕过自家门禁"，不在静态判据的可防范围内。故另有三条行为测试兜底
//    （test/flows.test.mjs 的「人工点击才装 / 创建路径零调用 / 服务缺席如实降级」）。
//
// ② **身份判据必须来自名册**：预设身份＝声明行里的 `config.id`，注册表不扫目录
//    （`agent-preset-registry/README.zh.md:46`）；一份组合包可声明多个预设。
//    靠扫目录数数会数错、判重会失效 ⇒ 官方明写"重复的 preset ID 会导致声明加载失败"。
const hostFlows = await readIfExists('plugin-src/host/flows.mjs') ?? ''
const hostPreset = await readIfExists('plugin-src/host/preset.mjs') ?? ''
const clientImpl = await readIfExists('plugin-src/client/impl.mjs') ?? ''

/** 人工触发区的锚点标记（真源与判据共用同一个串，改一处必须改两处）。 */
const INSTALL_ON_CLICK_MARKER = '人工触发区·install-on-click'
const markerIndex = hostFlows.indexOf(INSTALL_ON_CLICK_MARKER)
const installPresetAt = hostFlows.indexOf('async function installPreset(')
const installCallAt = hostFlows.search(/\.installBundle\s*\(/u)
const finalizeAt = hostFlows.indexOf('async function finalize(')

check(markerIndex !== -1,
  `宿主半侧缺少人工触发区标记「${INSTALL_ON_CLICK_MARKER}」—— 安装的合法性由它界定，`
  + '删了它就无法证明安装只发生在人工触发的动作里')
check(installPresetAt !== -1,
  '宿主半侧找不到 installPreset() —— 「界面一键安装」的人工触发入口不存在')
check(markerIndex !== -1 && installPresetAt !== -1 && markerIndex < installPresetAt,
  '人工触发区标记必须写在 installPreset() **之前** —— 标记在函数之后等于没界定触发区')
check(installCallAt !== -1,
  '宿主半侧找不到 installBundle(...) 调用 —— 「点了就装」这条能力没接上（只出指引等于退回 2.1.0）')
check(installCallAt !== -1 && markerIndex !== -1 && markerIndex < installCallAt,
  'installBundle(...) 调用出现在人工触发区**之外** —— 安装只能发生在人点过之后，'
  + '生成路径（init / finalize）一律不得安装')
check(!(finalizeAt !== -1 && installCallAt !== -1 && finalizeAt < installCallAt && installCallAt < installPresetAt),
  'installBundle(...) 出现在 finalize（生成路径）里 —— 这是**无确认自动安装**，'
  + '正是 2.1.0 那条纪律禁止的事')
check(/会在宿主进程执行新代码/u.test(clientImpl),
  '客户端安装按钮缺少显式警示（"会在宿主进程执行新代码"）—— '
  + '人工点击之所以算审批，前提是用户知道自己在批准什么')

check(/get\(\s*'agentPresets'\s*\)|ctx\.agentPresets/u.test(hostFlows),
  '宿主半侧读不到 ctx.agentPresets —— 预设身份的唯一权威来源是名册（不扫目录），'
  + '缺了它就会生成与既有预设重复的 config.id')
check(/ROSTER_UNAVAILABLE/u.test(hostFlows),
  '宿主半侧没有"名册不可用 ⇒ 拒绝创建"的分支 —— 宁可不落盘，也不能出重复 id')
check(!/export function renderPresetAgents/u.test(hostPreset),
  'preset.mjs 仍在产出 `AGENTS.md` 死产物 —— 新架构的指令面没有"预设目录"，那个文件没有消费者')
check(/export function installInstructions/u.test(hostPreset),
  'preset.mjs 缺少 installInstructions() —— 安装指引必须是可测的纯函数（本插件只出指引，不安装）')

// ── ⑦ 本机绝对路径与凭证形态 ──────────────────────────────────────────────
// 扫描面 = **随包出去的源码与脚本**。两个刻意排除项，各自都有理由：
//   · `test/` —— 它的**职责**就是构造畸形输入（假令牌、假路径）。把 fixture 当泄漏，
//     会让这条断言天天红，于是所有人都学会忽略它 —— 那样它就等于不存在。
//     替代做法：下面单独检查 test/ 里**除 fixture 形态之外**的真实本机路径。
//   · `docs/` 里的示例路径 —— 文档要展示"命令长什么样"，只能写形态化的路径；
//     判据是"是否含真实用户名"，不是"是否含 C:\Users"。
const SCAN_ROOTS = ['plugin-src', 'scripts', 'docs']
const files = []
for (const root of SCAN_ROOTS) await sourceFiles(resolve(ROOT, root), files)
for (const relativePath of ['package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'CHANGELOG.md']) {
  const absolute = resolve(ROOT, relativePath)
  const info = await stat(absolute).catch(() => undefined)
  if (info?.isFile()) files.push(absolute)
}
/** 形态化占位符与明显虚构的用户名 —— 不算泄漏（它们是"说清楚这里有个用户名"，不是"真名"）。 */
const PLACEHOLDER_USERS = new Set(['someone', 'other', 'user', 'username', 'yourname', 'example'])
const PRIVATE_PATTERNS = [
  { name: 'Windows 用户目录', pattern: /[A-Za-z]:\\+Users\\+([^\\/\s"']+)/gu },
  { name: 'POSIX 用户目录', pattern: /\/(?:home|Users)\/([A-Za-z0-9._-]+)\//gu },
  { name: '厂商令牌', pattern: /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,})\b/gu },
  { name: '凭证赋值', pattern: /(api[_-]?key|client[_-]?secret|password)\s*[:=]\s*['"][^'"]{8,}['"]/giu },
]
const isPlaceholder = match => {
  const user = match[1]
  return user !== undefined && PLACEHOLDER_USERS.has(user.toLowerCase())
}
const hits = []
const skipped = []
for (const file of files) {
  const text = await readFile(file, 'utf8').catch(() => '')
  for (const rule of PRIVATE_PATTERNS) {
    for (const match of text.matchAll(rule.pattern)) {
      if (isPlaceholder(match)) {
        skipped.push(`${file.slice(ROOT.length + 1)} ← ${rule.name} 形态化占位符「${match[0].slice(0, 40)}」`)
        continue
      }
      hits.push(`${file.slice(ROOT.length + 1)} ← ${rule.name}：${match[0].slice(0, 60)}`)
    }
  }
}
check(hits.length === 0, `发现可能的私有信息泄漏：\n    - ${hits.join('\n    - ')}`)
if (skipped.length > 0) console.log(`  · 形态化占位符（不算泄漏，已列明）：${skipped.length} 处`)

/**
 * `test/` 单独一轮。**两件事都做**，这是刻意的：
 *   ① 照常扫敏感形态 —— 真实凭证要是藏在测试里，这里能发现；
 *   ② 但命中必须能在 `test/fixtures.mjs` 的**运行时夹具表**里找到对应，
 *      否则报出来。夹具在源码里是拼装出来的（不是完整字面量），所以
 *      "扫描器命中它"本身就是异常信号，而不是天天响的噪音。
 *
 * 早先的写法是"写一张字面量白名单放行 test/" —— 两个毛病：白名单自己又成了
 * 新的字面量，而且必然漏（实测漏了两条）。补丁式白名单治不了根。
 */
let fixtureValues = []
try {
  const fixtures = await import(new URL('../test/fixtures.mjs', import.meta.url).href)
  fixtureValues = [...(fixtures.ALL_FIXTURES ?? [])]
} catch (error) {
  check(false, `无法加载 test/fixtures.mjs 的夹具表：${String(error?.message ?? error)}`)
}
const testFiles = []
await sourceFiles(resolve(ROOT, 'test'), testFiles)
const testHits = []
let testRegistered = 0
for (const file of testFiles) {
  const text = await readFile(file, 'utf8').catch(() => '')
  for (const rule of PRIVATE_PATTERNS) {
    for (const match of text.matchAll(rule.pattern)) {
      const hit = match[0]
      if (isPlaceholder(match)) continue
      const registered = fixtureValues.some(value => hit.includes(value))
      if (registered) {
        testRegistered += 1
        continue
      }
      testHits.push(`${file.slice(ROOT.length + 1)} ← ${rule.name}：${hit.slice(0, 60)}`)
    }
  }
}
check(testHits.length === 0,
  `test/ 里出现了**未登记在 test/fixtures.mjs** 的敏感形态（真泄漏会藏在这里）：\n    - ${testHits.join('\n    - ')}`)
console.log(`  · test/ 单独一轮：${testFiles.length} 个文件，命中 ${testRegistered} 处（全部对上夹具表）、未登记 ${testHits.length} 处`)

/** 可选：私有词表（放仓库外，经环境变量挂入；未设置则跳过 —— CI 永不接触这些词）。 */
const privateTermsPath = process.env.DSH_PRIVATE_TERMS
if (privateTermsPath !== undefined && privateTermsPath !== '') {
  const terms = (await readFile(privateTermsPath, 'utf8').catch(() => ''))
    .split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
  const termHits = []
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const term of terms) if (text.includes(term)) termHits.push(`${file.slice(ROOT.length + 1)} ← 「${term}」`)
  }
  check(termHits.length === 0, `私有词表命中：\n    - ${termHits.join('\n    - ')}`)
  console.log(`  · 私有词表扫描：${terms.length} 个词，命中 ${termHits.length} 处`)
} else {
  console.log('  · 私有词表扫描：跳过（未设置 DSH_PRIVATE_TERMS）')
}

// ── ⑧ files 白名单自洽 + 安装期脚本禁则 ──────────────────────────────────
const filesAllow = manifest?.files
check(Array.isArray(filesAllow) && filesAllow.length > 0, 'package.json 缺少 files 白名单')
if (Array.isArray(filesAllow)) {
  for (const entry of filesAllow) {
    const info = await stat(resolve(ROOT, entry)).catch(() => undefined)
    check(info !== undefined, `files 白名单里的 ${entry} 在磁盘上不存在 —— 发布包会缺件`)
  }
  for (const must of ['lib', 'plugin-src', 'scripts', 'cordis.patch.yml']) {
    check(filesAllow.includes(must), `files 白名单漏了 ${must} —— 安装方会缺件（link: 装载下看不见这个缺陷）`)
  }
  // 生命周期脚本引用的文件必须在包内：漏了会让安装方 `npm install` 直接失败。
  for (const hook of Object.values(manifest?.scripts ?? {})) {
    for (const match of String(hook).matchAll(/\bnode\s+([\w./-]+\.mjs)/gu)) {
      const referenced = match[1]
      check(filesAllow.some(entry => entry.startsWith(referenced.split('/')[0])),
        `生命周期脚本引用了 ${referenced}，但 files 白名单未覆盖它所在的目录 —— 安装方会缺件`)
      // ★ 引用的文件本身也得在磁盘上：`prepare` 指向一个不存在的脚本，
      //   会让 `npm install` / `npm ci` 的构建钩子静默不生效（或直接失败）。
      const referencedInfo = await stat(resolve(ROOT, referenced)).catch(() => undefined)
      check(referencedInfo !== undefined && referencedInfo.isFile(),
        `生命周期脚本引用了 ${referenced}，但该文件在磁盘上不存在 —— 构建钩子会失效`)
    }
  }
}
const scripts = manifest?.scripts ?? {}
for (const forbidden of ['preinstall', 'install', 'postinstall']) {
  check(scripts[forbidden] === undefined,
    `package.json 声明了 ${forbidden} —— pnpm 10+ 会拦截依赖的安装期脚本，消费者安装**直接失败**；构建自动化请用 prepare`)
}
check(typeof scripts.prepublishOnly === 'string', 'package.json 缺少 prepublishOnly —— 未构建就发布会把 main 指向不存在的 lib/')
check(typeof scripts.verify === 'string', 'package.json 缺少 verify 脚本')
check(manifest?.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json 的 dsh.bundle.patch 必须指向 ./cordis.patch.yml')
check(manifest?.dsh?.client?.platform === 'web', 'package.json 的 dsh.client.platform 必须是 web')
check(Array.isArray(manifest?.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0,
  'package.json 缺少 dsh.client.inject —— 客户端半侧不会被装载')
// ★ 运行时要求写在 engines.dsh（官方 schema 的字段）；dsh.compatibility 是生态约定、
//   DSH 当前不强制（package-manifest/types.ts 自述 "declarative until a reader enforces it"）。
check(typeof manifest?.engines?.dsh === 'string' && manifest.engines.dsh !== '',
  'package.json 缺少 engines.dsh —— 不兼容版本无法给出明确反馈（dsh.compatibility 不被宿主强制）')
check(typeof manifest?.dsh?.compatibility?.dsh === 'string',
  'package.json 缺少 dsh.compatibility.dsh（生态约定字段；缺失不影响运行，但排障时无从判断）')

// ── ⑨ cordis.patch.yml 与宿主默认值一致性 ────────────────────────────────
const patch = await readIfExists('cordis.patch.yml') ?? ''
check(patch.includes('@yiyunet/dsh-learn-skills'), 'cordis.patch.yml 里没有本包名 —— profile 不会装载它')
check(/installed: true|-\s*insert:/u.test(patch), 'cordis.patch.yml 结构不对（应含 insert 行）')
const packageName = manifest?.name
check(packageName === '@yiyunet/dsh-learn-skills', `包名必须是 @yiyunet/dsh-learn-skills，实得 ${String(packageName)}`)

// ── ⑩ 客户端装配证据：提交必须在 wrapper factory 内部 ──────────────────────
//
// ⚠️ 两条判据都**刻意避开容易出现在注释里的名字**：
//   · 占位符残留 —— 按行去空白比对（不是整串 includes，注释里提一次就会误报）；
//   · 位置关系 —— 锚点用 esbuild 的 IIFE `__DshLearnSkills = (`，
//     **不用** `require("react")`：后者的字面量在 wrapper 的说明注释里就有，
//     实测因此把健康产物判成"产物落在工厂外面"两次。
const placeholderLines = clientBundle.replaceAll('\r\n', '\n').split('\n')
  .map(line => line.trim()).filter(line => line === '// __DSH_CLIENT_BUNDLE__')
check(placeholderLines.length === 0,
  `lib/client.js 里仍留着占位符注释（${placeholderLines.length} 行）—— 构建时没有真正把产物嵌进 wrapper`)
check(clientBundle.includes('__ModuleLoader__'), 'lib/client.js 没有 __ModuleLoader__.load —— 装载器契约缺失')
{
  const factoryIndex = clientBundle.indexOf('factory:')
  const iifeIndex = clientBundle.indexOf('__DshLearnSkills = (')
  check(factoryIndex >= 0, 'lib/client.js 里找不到 `factory:` —— 装载器契约被破坏')
  check(iifeIndex >= 0,
    'lib/client.js 里找不到 esbuild 的 IIFE（`__DshLearnSkills = (`）—— bundle 没有被插进去')
  check(factoryIndex >= 0 && iifeIndex >= 0 && iifeIndex > factoryIndex,
    `esbuild 的 IIFE 出现在 factory 之前（IIFE@${iifeIndex}, factory@${factoryIndex}）—— `
    + '产物落在工厂外面：顶层执行会抛错，整个 /plugins 拼接 bundle 会全灭')
}

// ── 输出 ──────────────────────────────────────────────────────────────────
console.log('')
if (warnings.length > 0) {
  console.log(`⚠ ${warnings.length} 条提示：`)
  for (const item of warnings) console.log(`  · ${item}`)
  console.log('')
}
if (failures.length > 0) {
  console.error(`✗ 契约校验未通过：${failures.length} 条`)
  for (const item of failures) console.error(`  · ${item}`)
  process.exit(1)
}
console.log('✓ 契约校验通过（10 组断言全部为真）')
