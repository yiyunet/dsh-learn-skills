/**
 * build.mjs —— 生成 lib/（发布产物）。唯一真源在 plugin-src/。
 *
 *   npm run build           全量构建
 *   npm run build:host      只构建宿主半侧
 *   npm run build:client    只构建客户端半侧
 *
 * ── 宿主半侧（plugin-src/host/ → lib/）────────────────────────────────────
 *   纯 ESM，不做转换：逐文件复制 + 加"构建生成"横幅。
 *   之所以复制而不是 re-export：发布物与源码同构，可被插件加载器直接解析。
 *
 * ── 客户端半侧（plugin-src/client/ → lib/client.js）──────────────────────
 *   esbuild 打包 impl.mjs 成 IIFE（globalName = __DshLearnSkills），
 *   再套上手写装载器 wrapper → window.__ModuleLoader__.load({ id, factory })，与
 *   官方客户端模块系统同形。
 *
 * ⚠️ react / react-dom 必须保持 external：它们由平台冻结模块表提供，通过
 *    factory 注入的 require 在**运行时**解析。打进来会与宿主 React 冲突。
 *
 * @module dsh-learn-skills/build
 */

import { builtinModules } from 'node:module'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { runInNewContext } from 'node:vm'

import * as esbuild from 'esbuild'

import { CLIENT_EXTERNAL, CLIENT_GLOBAL, findMarker, REQUIRED_MARKERS } from './markers.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_HOST = join(ROOT, 'plugin-src', 'host')
const SRC_CLIENT = join(ROOT, 'plugin-src', 'client')
const LIB = join(ROOT, 'lib')
const STAGING = join(ROOT, '.lib-staging')
const BACKUP = join(ROOT, '.lib-backup')

// 全局名 / 外部模块白名单 / 标记表 / findMarker 全部来自 `./markers.mjs`（零依赖）——
// 单独成模块是为了让标记契约测试**不需要 esbuild** 也能跑。这里不再重复声明。

const GENERATED_BANNER = name =>
  '// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。\n'
  + `// 真源：plugin-src/${name}\n`

const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function withTransientRetry(operation, what, { attempts = 6, baseDelayMs = 200 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!TRANSIENT.has(error?.code)) throw error
      if (attempt >= attempts) {
        throw new Error(
          `${what} 失败：连续 ${attempts} 次遇到瞬时文件锁（${error.code}）。`
          + '常见原因：杀毒软件实时扫描 / 索引器 / 宿主进程正持有该目录句柄。'
          + `原始错误：${error.message}`,
        )
      }
      await new Promise(resolveDelay => { setTimeout(resolveDelay, baseDelayMs * attempt) })
    }
  }
}

async function walk(directory) {
  const out = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** 抽出源码里 import 的裸模块名。 */
function bareImportsOf(source) {
  const names = new Set()
  const patterns = [
    /^\s*import\s+[^'"]*?from\s*['"]([^'"]+)['"]/gmu,
    /^\s*import\s*['"]([^'"]+)['"]/gmu,
    /^\s*export\s+[^'"]*?from\s*['"]([^'"]+)['"]/gmu,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1])
  }
  return [...names].filter(specifier => !specifier.startsWith('.') && !specifier.startsWith('/'))
}

/** 宿主半侧：复制 + 横幅 + 依赖体检。 */
async function buildHost() {
  const files = await walk(SRC_HOST)
  if (files.length === 0) throw new Error('plugin-src/host/ 是空的')
  if (!files.some(file => relative(SRC_HOST, file) === 'index.mjs')) {
    throw new Error('plugin-src/host/index.mjs 不存在 —— 宿主入口缺失，发布物会是空的')
  }
  const notices = []
  for (const file of files) {
    const relativePath = relative(SRC_HOST, file)
    const source = await readFile(file, 'utf8')
    for (const specifier of bareImportsOf(source)) {
      if (BUILTINS.has(specifier)) continue
      if (specifier.startsWith('@deepseek-ai/')) continue
      notices.push(`${relativePath} imports "${specifier}" —— 请确认该包是 Node 内置或宿主运行时提供`)
    }
    const target = join(STAGING, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, GENERATED_BANNER(`host/${relativePath}`) + source, 'utf8')
  }
  const entryStat = await stat(join(STAGING, 'index.mjs')).catch(() => undefined)
  if (entryStat === undefined || !entryStat.isFile()) {
    throw new Error('lib/index.mjs 写出后不存在 —— 构建自证失败')
  }
  return { count: files.length, notices }
}

/** 客户端半侧：esbuild → IIFE → 塞进 wrapper 的 factory。 */
async function buildClient() {
  const wrapper = await readFile(join(SRC_CLIENT, 'index.mjs'), 'utf8')
  const entry = join(SRC_CLIENT, 'impl.mjs')

  for (const specifier of bareImportsOf(await readFile(entry, 'utf8'))) {
    if (!CLIENT_EXTERNAL.includes(specifier)) {
      throw new Error(
        `plugin-src/client/impl.mjs 引入了非白名单模块 "${specifier}"。`
        + `平台冻结模块表只保证 ${CLIENT_EXTERNAL.join(' / ')}。`,
      )
    }
  }

  let result
  try {
    result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'iife',
      globalName: CLIENT_GLOBAL,
      platform: 'browser',
      target: 'esnext',
      external: CLIENT_EXTERNAL,
      legalComments: 'none',
      write: false,
      logLevel: 'warning',
    })
  } catch (error) {
    const details = Array.isArray(error?.errors) && error.errors.length > 0
      ? error.errors.map(item => `  · ${item.text}`).join('\n')
      : `  · ${error?.message ?? error}`
    throw new Error(`esbuild 打包失败：\n${details}\n提示：构建依赖 esbuild，请先在本目录跑 \`npm install\`。`)
  }

  const outputFiles = result?.outputFiles ?? []
  if (outputFiles.length === 0) throw new Error('esbuild 没有产出任何文件 —— 打包器输出契约变了')
  const bundled = outputFiles[0].text.trimEnd()
  if (!bundled.includes(CLIENT_GLOBAL)) {
    throw new Error(`打包产物里没有出现全局名 ${CLIENT_GLOBAL} —— esbuild 输出形态可能变了`)
  }

  const PLACEHOLDER = '__DSH_CLIENT_BUNDLE__'
  if (!wrapper.includes(PLACEHOLDER)) {
    throw new Error(`plugin-src/client/index.mjs 缺少占位符 // ${PLACEHOLDER} —— `
      + 'wrapper 必须把 esbuild 产物放在 factory 内部，否则顶层执行到 require("react") 会让整个 /plugins 拼接 bundle 全灭')
  }

  // ★ 装配方式：**按行切分再拼**，不用 `String.replace`。
  //
  // 两个理由，都不是理论洁癖：
  //   ① `String.replace(pattern, replacement)` 会解释 replacement 里的 `$&` / `$'` /
  //      `` $` `` / `$$` —— 恰好这些都是**合法 JS**，可能出现在压缩后的产物里。
  //      一旦命中，注入的内容会被静默改错，而产物体积照旧、看不出异常。
  //   ② 替换是否成功没有自证。实测遇到过"构建说 OK、verify 说占位符还在"的自相矛盾。
  //
  // ⚠️ 占位符的匹配**必须容忍前后空白**，且**必须归一化行尾**：
  //    第一版要求"行首无缩进 + 恰好等于占位符串"，结果 CRLF 文件里每行都带 `\r`，
  //    于是连"独立的占位符行"都匹配不上（报错说"找到它但不在行首"，其实行首是对的）。
  //    判据要容忍无害的格式差异 —— 它要拦的是"装配没发生"，不是"缩进不是 0"。
  const lines = wrapper.replaceAll('\r\n', '\n').split('\n')
  const at = lines.findIndex(line => line.trim() === `// ${PLACEHOLDER}`)
  if (at === -1) {
    throw new Error(`找不到独立的占位符行 // ${PLACEHOLDER} —— `
      + '装配按行切分，占位符必须独占一行（前后可带缩进）')
  }
  // 匹配时**不读、也不保留**占位符的缩进：bundle 一律顶格插入。
  // （产物是生成文件，缩进无意义；早先想"跟随占位符缩进"只是多一个出错面。）
  const output = [
    ...lines.slice(0, at),
    bundled,
    ...lines.slice(at + 1),
  ].join('\n')

  // 装配自证：不凭"没报错"下结论。
  //
  // ⚠️ 判据只查**行形态的残留**，不查 `output.includes(PLACEHOLDER)`。
  //    原因：占位符字样可能（且确实曾经）出现在 wrapper 的注释里 —— 那时
  //    `includes` 即使装配完全成功也会命中，于是"自证"变成"必然误报"。
  //    真正要拦的是"占位符那一行还在"，不是"这个串在任何地方出现"。
  const leftover = output.replaceAll('\r\n', '\n').split('\n')
    .filter(line => line.trim() === `// ${PLACEHOLDER}`).length
  if (leftover > 0) {
    throw new Error(`装配后仍存在 ${leftover} 行未替换的占位符 —— 拼接逻辑失效`)
  }
  if (output.length <= wrapper.length) {
    throw new Error(`装配后产物没有变大（wrapper ${wrapper.length} 字节 → 产物 ${output.length} 字节）—— `
      + '说明 bundle 没有被插进去')
  }
  // ★ 顺序自证：esbuild 的 IIFE（`var <全局名> = (`）必须出现在 **`factory:` 之后**。
  //
  // ⚠️ 判据刻意**不用** `require("react")` 这个名字 —— 它太容易出现在注释与文档里
  //    （实测：wrapper 的头注释里就有一处，于是断言在注释上命中，
  //    把一个完全健康的产物判成"产物落在了工厂外面"）。
  //    IIFE 的 `var <全局名> = (` 只由 esbuild 生成，注释里不会出现，是**唯一**可靠锚点。
  const factoryAt = output.indexOf('factory:')
  // 断言用两种形态都认（`var` / `const` / `let` 都含 `= (` 这段），
  // 否则 esbuild 换个声明关键字就会让断言变假阴性。
  const iifeAt = output.indexOf(`${CLIENT_GLOBAL} = (`)
  if (factoryAt === -1) {
    throw new Error('lib/client.js 里找不到 `factory:` —— 装载器契约被破坏')
  }
  if (iifeAt === -1) {
    throw new Error(`lib/client.js 里找不到 esbuild 的 IIFE（\`var ${CLIENT_GLOBAL} = (\`）—— `
      + '说明 bundle 没有被插进去，或 esbuild 的输出形态变了')
  }
  if (iifeAt < factoryAt) {
    throw new Error(`esbuild 的 IIFE 出现在 factory 之前（IIFE@${iifeAt}, factory@${factoryAt}）—— `
      + '产物落在了工厂外面：顶层执行会抛错，整个 /plugins 拼接 bundle 会全灭。'
      + '最常见成因：占位符被写在了 factory 之外的注释或代码里。')
  }
  console.log(`  · 装配：占位符（第 ${at + 1} 行）已用 ${bundled.length} 字节产物替换，`
    + `文件 ${wrapper.length} → ${output.length} 字节；factory@${factoryAt} < IIFE@${iifeAt}`)

  await mkdir(STAGING, { recursive: true })
  await writeFile(join(STAGING, 'client.js'), output, 'utf8')

  const written = await readFile(join(STAGING, 'client.js'), 'utf8')
  if (written.trim() === '') throw new Error('lib/client.js 写出后为空 —— 写入环节异常')
  const markerReport = REQUIRED_MARKERS.map(marker => ({ marker, found: findMarker(written, marker.needle) }))
  const missing = markerReport.filter(item => item.found === undefined)
  if (missing.length > 0) {
    // 诊断信息必须足够让人**不用猜**：产物多大、哪些标记在、缺的那些长什么样。
    // 只说"缺少关键标记"会让下一个人重复我这次的排查。
    const present = markerReport.filter(item => item.found !== undefined)
    const detail = [
      `lib/client.js 大小 ${Buffer.byteLength(written, 'utf8')} 字节`,
      `已在的标记（${present.length}/${REQUIRED_MARKERS.length}）：`
        + (present.map(item => `${item.marker.label}(${item.found})`).join('、') || '（一个都没有）'),
      '产物开头 400 字符：',
      written.slice(0, 400),
      '产物结尾 300 字符：',
      written.slice(-300),
      `产物里 \\u 转义序列出现次数：${(written.match(/\\u[0-9a-fA-F]{4}/gu) ?? []).length}`,
    ].join('\n')
    throw new Error(
      `lib/client.js 缺少关键标记：${missing.map(item => `${item.marker.label}「${item.marker.needle}」`).join('、')}\n`
      + `──── 诊断 ────\n${detail}\n──────────────\n`
      + '  → 跑 `npm run inspect` 看产物实况；若源码里也没有该串，那是契约漂移，改源码而非改构建。',
    )
  }

  // 装载层自证：用最小 __ModuleLoader__ 桩把产物真跑一遍。
  const registrations = []
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, TextEncoder, TextDecoder,
    navigator: { userAgent: 'node' },
    location: { href: 'http://localhost/' },
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    requestAnimationFrame: callback => setTimeout(callback, 0),
    document: {
      currentScript: null,
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, setAttribute() {} }),
      addEventListener() {},
      removeEventListener() {},
      head: { appendChild() {} },
    },
    window: { __ModuleLoader__: { mode: 'queue', load: registration => registrations.push(registration) } },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox

  try {
    runInNewContext(written, sandbox, { filename: 'lib/client.js' })
  } catch (error) {
    throw new Error(`lib/client.js 顶层执行抛错：${error?.name}: ${error?.message}\n`
      + '  → 最常见原因：esbuild 产物没有插进 wrapper 的 factory 内部。')
  }
  if (!registrations.some(item => item?.id === '@yiyunet/dsh-learn-skills')) {
    throw new Error('lib/client.js 执行后没有注册 @yiyunet/dsh-learn-skills —— 装载器契约被破坏')
  }

  const requireCalls = []
  let face
  try {
    face = registrations[0].factory(specifier => {
      requireCalls.push(specifier)
      if (specifier === 'react') {
        return {
          useState: () => [0, () => {}],
          useEffect: () => {},
          useCallback: fn => fn,
          useRef: () => ({ current: null }),
          useMemo: fn => fn(),
          createElement: () => null,
          Fragment: null,
        }
      }
      if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null }
      if (specifier === 'react-dom') return { createPortal: () => null }
      if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {} }) }
      return new Proxy({}, { get: () => () => undefined })
    })
  } catch (error) {
    throw new Error(`lib/client.js 的 factory 执行抛错：${error?.name}: ${error?.message}`)
  }
  if (typeof face?.apply !== 'function') {
    throw new Error('lib/client.js 的装载器面没有导出 apply()（客户端插件对象缺少 apply，插件不会生效）')
  }
  return { bytes: Buffer.byteLength(output, 'utf8'), requireCalls }
}

const only = process.argv[2]
const isPartial = only === '--host-only' || only === '--client-only'

await rm(STAGING, { recursive: true, force: true })
await mkdir(STAGING, { recursive: true })
if (isPartial) await mkdir(LIB, { recursive: true })

try {
  if (only !== '--client-only') {
    const host = await buildHost()
    console.log(`✓ 宿主半侧：${host.count} 个文件 → lib/（入口 lib/index.mjs）`)
    for (const notice of host.notices) console.log(`  · ${notice}`)
  }
  if (only !== '--host-only') {
    const client = await buildClient()
    console.log(`✓ 客户端半侧：lib/client.js（${(client.bytes / 1024).toFixed(1)} KB）`)
    console.log(`  · 装载验证：顶层执行 OK，注册 OK，factory require(${client.requireCalls.join(', ') || 'none'})，导出 apply OK`)
  }

  if (isPartial) {
    for (const file of await walk(STAGING)) {
      const target = join(LIB, relative(STAGING, file))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await readFile(file))
    }
    await rm(STAGING, { recursive: true, force: true })
    console.log('  · 产物已叠加写入 lib/（部分构建，另一半保留）')
  } else {
    await withTransientRetry(() => rm(BACKUP, { recursive: true, force: true }), '清理上一次的 .lib-backup')
    const hadLib = await stat(LIB).then(info => info.isDirectory()).catch(() => false)
    if (hadLib) await withTransientRetry(() => rename(LIB, BACKUP), '把旧 lib/ 挪成 .lib-backup')
    try {
      await withTransientRetry(() => rename(STAGING, LIB), '把暂存区就位为 lib/')
    } catch (error) {
      let note = ''
      if (hadLib) {
        try {
          await withTransientRetry(() => rename(BACKUP, LIB), '回滚 .lib-backup → lib/', { attempts: 3 })
        } catch (rollbackError) {
          note = `；⚠️ 且回滚也失败：${rollbackError.message}。旧产物仍在 ${BACKUP}，可手动改名回 lib/ 恢复`
        }
      }
      throw new Error(`替换 lib/ 失败${note}。原始错误：${error?.message ?? error}`)
    }
    await withTransientRetry(() => rm(BACKUP, { recursive: true, force: true }), '清理 .lib-backup')
    console.log('  · 产物已原子替换 lib/')
  }
} catch (error) {
  await rm(STAGING, { recursive: true, force: true }).catch(() => {})
  console.error(`\n✗ 构建失败：\n${error?.message ?? error}\n`)
  const libExists = await stat(LIB).then(info => info.isDirectory()).catch(() => false)
  console.error(libExists
    ? '✓ 旧的 lib/ 未被改动（构建先写暂存区，失败不动产物）—— 插件仍可用旧版本。'
    : '! 当前没有 lib/，插件在 DSH 里无法加载。修好原因后重跑 `npm run build`。')
  process.exit(1)
}

const produced = (await walk(LIB)).map(file => `lib/${relative(LIB, file).split(sep).join('/')}`).sort()
console.log(`\nlib/ 实际落盘 ${produced.length} 个文件：`)
for (const file of produced) console.log(`  · ${file}`)
if (!produced.includes('lib/index.mjs')) {
  console.error('\n✗ 缺少 lib/index.mjs —— 宿主入口未落盘，verify 会失败。')
  process.exit(1)
}
console.log('\n构建完成。下一步：npm test && npm run verify')
