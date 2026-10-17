/**
 * static-check.mjs —— 免执行的静态一致性体检（`node scripts/static-check.mjs`）。
 *
 * 为什么需要它：本目录是在一个**没有 shell** 的环境里交付的，`npm test` 由使用者
 * 首次执行。在那之前，能做的最高价值检查是**静态**的：
 *   ① 每个 `import ... from './x.mjs'` 指向的文件真的存在；
 *   ② 每个相对 import 的**具名符号**在目标模块里真的有 `export`；
 *   ③ 每个 `.mjs` 文件语法能通过 `new Function`/动态 import 的语法检查；
 *   ④ 没有"引用了但没定义"的顶层标识符（按 export/import/声明/全局白名单核对）；
 *   ⑤ 客户端实现不得 import 非白名单的裸模块；
 *   ⑥ 宿主半侧不得 import 生态包（除宿主运行时提供的 @deepseek-ai/*）；
 *   ⑦ **预设生成物里不得出现白名单外的提示词变量**（`{{x}}`）—— 见本文件 ⑦ 段的事故说明。
 *
 * ⚠️ 它**不能替代** `npm test`：静态检查证明不了行为。文件里明写这一点，
 * 免得有人拿"static-check 通过"当成"测试通过"。
 *
 * @module dsh-learn-skills/static-check
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SCAN = ['plugin-src/host', 'plugin-src/client', 'scripts', 'test']
const failures = []
const notes = []

async function walk(directory, out = []) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'lib', '.git'].includes(entry.name)) continue
      await walk(path, out)
    } else if (entry.name.endsWith('.mjs')) {
      out.push(path)
    }
  }
  return out
}

/** 收集一个模块导出的名字（`export function` / `export const` / `export {a, b}` / `export class`）。 */
function exportsOf(source) {
  const names = new Set()
  for (const match of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gmu)) {
    names.add(match[1])
  }
  for (const match of source.matchAll(/^\s*export\s*\{([^}]*)\}/gmu)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/u).pop()?.trim()
      if (name !== undefined && name !== '') names.add(name)
    }
  }
  if (/^\s*export\s+default\b/mu.test(source)) names.add('default')
  return names
}

/** 收集一个模块里的相对 import 及其具名符号。 */
function importsOf(source) {
  const out = []
  const patterns = [
    /^\s*import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gmu,
    /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/gmu,
    /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/gmu,
  ]
  for (const match of source.matchAll(patterns[0])) {
    const names = match[1].split(',').map(piece => piece.trim().split(/\s+as\s+/u)[0]?.trim())
      .filter(name => name !== undefined && name !== '')
    out.push({ specifier: match[2], names })
  }
  for (const pattern of patterns.slice(1)) {
    for (const match of source.matchAll(pattern)) {
      out.push({ specifier: match[2], names: [match[1]] })
    }
  }
  return out
}

const files = []
for (const root of SCAN) await walk(join(ROOT, root), files)
notes.push(`扫描 ${files.length} 个 .mjs 文件`)

const sources = new Map()
for (const file of files) sources.set(file, await readFile(file, 'utf8'))

// ① + ② 相对 import 的存在性与具名符号
for (const [file, source] of sources) {
  for (const entry of importsOf(source)) {
    if (!entry.specifier.startsWith('.')) continue
    const target = resolve(dirname(file), entry.specifier)
    const info = await stat(target).catch(() => undefined)
    if (info === undefined || !info.isFile()) {
      failures.push(`${relative(ROOT, file).split(sep).join('/')} 引用了不存在的文件：${entry.specifier}`)
      continue
    }
    const targetSource = sources.get(target) ?? await readFile(target, 'utf8')
    const exported = exportsOf(targetSource)
    for (const name of entry.names) {
      if (!exported.has(name)) {
        failures.push(`${relative(ROOT, file).split(sep).join('/')} 从 ${entry.specifier} 导入了未导出的符号：${name}`)
      }
    }
  }
}

// ③ 语法检查：逐个文件交给 `node --check`（专为语法检查设计，零副作用、零执行）。
//
// ⚠️ 这里曾经用的是土办法「剥掉 import/export 行再 new Function」—— 那是错的：
//    剥掉 `export const X = [...]` 会留下一个孤立的数组字面量，于是**每个健康的文件
//    都被报成语法错误**。假阳性检查器比没有检查器更坏：它教人忽略红灯。
//
// 为什么不用 `vm.SourceTextModule`：它需要 `--experimental-vm-modules`，
// 而 Node 默认不开 —— 一个"要加旗标才准"的检查，装到别人机器上就会退化成假阳性。
// `node --check` 没有这个问题：它就是语法检查本身。
const syntaxTemp = await mkdtemp(join(tmpdir(), 'learn-skills-syntax-'))
let syntaxFailures = 0
try {
  for (const [file, source] of sources) {
    const relativePath = relative(ROOT, file).split(sep).join('/')
    // ★ 后缀必须是 `.mjs`：否则 `node --check` 按 CommonJS 解析，把 `import`/`export`
    //    全判成语法错 —— 那正是上一版假阳性的另一个来源（每个文件都"语法错误"）。
    const probe = join(syntaxTemp, `${relativePath.replace(/[/\\]/gu, '__')}.mjs`)
    await writeFile(probe, source, 'utf8')
    const result = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' })
    if (result.status === 0) continue
    syntaxFailures += 1
    const stderr = String(result.stderr ?? '').trim().split('\n')
    // node --check 的最后一两行才是诊断，前面是文件路径与代码框。
    const detail = stderr.filter(line => line.trim() !== '').slice(-3).join(' / ')
    failures.push(`${relativePath} 存在语法错误：${detail.replaceAll(probe, relativePath)}`)
  }
} finally {
  await rm(syntaxTemp, { recursive: true, force: true })
}
notes.push(`语法检查：node --check（${sources.size} 个文件，${syntaxFailures} 个失败）`)

// ③′ 重复顶层声明检查：**这是实测踩过三次的同一类错**。
//
// 病根是"删旧块、加新块"的编辑方式：新块加了，旧块没删干净 ——
// `build.mjs` 的 findMarker、`verify-package.mjs` 的 testFiles、`flows.test.mjs` 的
// presetRoot 都是这么来的。
//
// ⚠️ 判据必须是「行首无缩进」：第一版我写成 `^\s*`，于是把**函数体内的**
//    `const result` 也算成顶层声明，一次性误报 89 处。报 89 条的检查等于没有检查 ——
//    它教人忽略红灯。所以锚点用 `^` 且**不允许前导空白**，只认真正的顶层。
const DUP_DECL = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gmu
const DUP_IMPORT = /^import\s+\{([^}]*)\}\s+from\s+['"][^'"]+['"]/gmu
for (const [file, source] of sources) {
  const relativePath = relative(ROOT, file).split(sep).join('/')
  /** 名字 → 出现次数（顶层声明 + 具名 import）。 */
  const seen = new Map()
  for (const match of source.matchAll(DUP_DECL)) {
    seen.set(match[1], (seen.get(match[1]) ?? 0) + 1)
  }
  for (const match of source.matchAll(DUP_IMPORT)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/u).pop()?.trim()
      if (name === undefined || name === '') continue
      seen.set(name, (seen.get(name) ?? 0) + 1)
    }
  }
  for (const [name, count] of seen) {
    if (count > 1) {
      failures.push(`${relativePath} 顶层标识符重复声明 ${count} 次：${name}`
        + '（典型成因：删旧代码块时没删干净 —— 语法解析器会直接拒绝加载该文件）')
    }
  }
}
notes.push('重复顶层声明检查：已跑（只认行首无缩进的声明）')

// ④ 顶层标识符使用 vs 定义（粗粒度，但足以抓住"改名漏改"）
const GLOBALS = new Set([
  'console', 'process', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'structuredClone', 'fetch', 'Response', 'Request', 'Headers', 'AbortController', 'AbortSignal',
  'Promise', 'Symbol', 'Proxy', 'Reflect', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Object',
  'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'Function', 'BigInt', 'Intl', 'globalThis', 'window', 'document', 'navigator', 'location',
  'Infinity', 'NaN', 'undefined', 'arguments', 'require', 'module', 'exports',
])
for (const [file, source] of sources) {
  const defined = new Set([...GLOBALS])
  for (const match of source.matchAll(/^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gmu)) {
    defined.add(match[1])
  }
  for (const match of source.matchAll(/^\s*import\s+\{([^}]*)\}/gmu)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/u).pop()?.trim()
      if (name !== undefined && name !== '') defined.add(name)
    }
  }
  for (const match of source.matchAll(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/gmu)) defined.add(match[1])
  for (const match of source.matchAll(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from/gmu)) defined.add(match[1])
  // 解构与函数参数里的名字
  for (const match of source.matchAll(/(?:const|let)\s+\{([^}]*)\}\s*=/gmu)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/[:=]/u)[0]?.trim()
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/u.test(name)) defined.add(name)
    }
  }
  for (const match of source.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/gmu)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/[:=]/u)[0]?.trim()
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/u.test(name)) defined.add(name)
    }
  }
  // catch (error)
  for (const match of source.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/gmu)) defined.add(match[1])

  // 只查"形如函数调用"的顶层名字。
  //
  // ⚠️ 扫的是 `blankOut(source)`（注释与字符串内容已抹掉），**不是裸 source**。
  //    这条曾经直接扫源码，于是出现了两次同型假阳性：
  //      ① 本仓注释里大量引用代码片段当反例 —— 那些字样被当成真调用；
  //      ② 一个时间正则里的 `T` 紧跟左圆括号，被报成"引用了未定义的符号 T"
  //         （正则字面量不在 blankOut 的抹除范围内，但至少注释与字符串不再进扫描面）。
  //    与 ④′ 用的是同一条判据（那里早就改成 CODE 了）—— 两处口径必须一致。
  //    方向是**只减不加**：字符串/注释里的字样本来就不是调用。
  const called = new Set()
  for (const match of blankOut(source).matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/gu)) called.add(match[1])
  const real = [...called].filter(name => !defined.has(name))
  // 只报大驼峰（更可能是真实符号，而不是方法名/局部变量），压低误报
  const suspicious = real.filter(name => /^[A-Z]/u.test(name))
  if (suspicious.length > 0) {
    failures.push(`${relative(ROOT, file).split(sep).join('/')} 可能引用了未定义的符号：${suspicious.join(', ')}`)
  }
}

// ④′ 调用形态检查：**函数返回数组还是对象，调用方必须一致**。
//
// 这一条来自实战：把 `loadNodes` 从"返回数组"改成"返回 `{nodes, skipped}`"时，
// 漏改了一个调用点 → `relateToNodes(candidates, {nodes,skipped})` 拿到非数组 →
// 关联**静默为空** → 后续"按 id 配对"全部落空 → 每个候选都判成"新增"。
// 它不报错、不抛异常，只是把关系变没 —— 这类错**只能靠机械检查抓**。

/**
 * 把注释抹掉、把字符串**内容**抹掉（保留引号本身），换行数不变。
 *
 * 两件事都必须做，理由都是实测出来的：
 *
 *   ① **注释**：本仓注释里大量引用代码片段当反例（"漏改的调用点长这样：…"）。
 *      逐字扫描会把它们当成真调用 —— 实测假阳性两次都是这么来的，一次在 `flows.mjs`
 *      的注释里，一次在本文件自己的报错文案里（**检查器读自己写的话**）。
 *
 *   ② **字符串内容**：同上，报错文案与说明文本里也会出现代码片段。
 *      更危险的是**注释判定本身会被字符串骗**：字符串里出现的 `//` 会被当行注释起点，
 *      于是**后半个文件被整段抹掉** —— 那会让下面所有检查**静默失效**，
 *      而"以为有闸门"比"知道没有闸门"危险得多。抹掉字符串内容后，这种骗法不成立。
 *
 * 只处理确定形态，不猜：行注释、同行闭合的块注释、三种引号（含模板串的插值嵌套）。
 * @param {string} text 源码
 * @returns {string} 换行数不变、注释被删、字符串内容被清空的源码
 */
function blankOut(text) {
  return text.split('\n').map(line => {
    let out = ''
    let quote = ''
    let depth = 0
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]
      if (quote === '') {
        if (char === '"' || char === "'" || char === '`') { quote = char; out += char; continue }
        if (char === '/' && line[i + 1] === '/') break
        if (char === '/' && line[i + 1] === '*') {
          const end = line.indexOf('*/', i + 2)
          if (end === -1) break
          i = end + 1
          continue
        }
        out += char
        continue
      }
      if (char === '\\') { i += 1; continue }
      if (quote === '`' && char === '$' && line[i + 1] === '{') { depth += 1; i += 1; continue }
      if (quote === '`' && depth > 0) {
        if (char === '{') depth += 1
        else if (char === '}') depth -= 1
        // 模板串插值里的代码**是代码**，原样保留（它可能真的调用本契约函数）。
        if (depth > 0) out += char
        continue
      }
      if (char === quote) { quote = ''; out += char; continue }
      // 字符串内容：丢掉（引号已在上面保留），避免它骗过注释判定、也避免被当成代码。
    }
    return out
  }).join('\n')
}

const CODE = new Map()
for (const [file, source] of sources) CODE.set(file, blankOut(source))

/**
 * 取第 `index` 个字符处那次函数调用的**顶层实参**。
 * 逐字符配平，不用正则 —— 正则的惰性匹配在 `f(a, g(b))` 上会截错，
 * 而"截错实参"的后果是**报出一个不存在的错**（实测：误报实参为 `deduped.candidates`）。
 * @param {string} source 已抹掉注释与字符串内容的源码
 * @param {number} index 函数名在源码中的位置
 * @returns {string[]} 各实参（已 trim）
 */
function callArgsAt(source, index) {
  const open = source.indexOf('(', index)
  if (open === -1) return []
  let depth = 0
  let quote = ''
  const args = []
  let current = ''
  for (let i = open + 1; i < source.length; i += 1) {
    const char = source[i]
    if (quote !== '') {
      current += char
      if (char === '\\') { i += 1; current += source[i] ?? ''; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; current += char; continue }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') {
      if (char === ')' && depth === 0) { args.push(current); break }
      depth -= 1
    }
    if (char === ',' && depth === 0) { args.push(current); current = ''; continue }
    current += char
  }
  return args.map(item => item.trim().replace(/\s+/gu, ' '))
}

// 判据只认**调用处**的实参形态，不去解析函数签名 ——
// 先前那版要先正则出形参里的 `名字[]` 再比对，结果被判据自己的细节绊住
// （报"找不到这个函数"，而函数明明在文件里），**检查器自己成了故障源**。
// 现在只问一件事：这个位置的实参，长得像不像一个"数组"？
const ARRAY_CONTRACTS = [
  { file: 'plugin-src/host/knowledge.mjs', name: 'relateToNodes', param: 1 },
]
{
  /** 实参是不是"显然的数组"：数组字面量、`.map()`/`.filter()` 这类流水线结果、展开。 */
  const looksLikeArray = arg => /^\s*\[/u.test(arg)
    || /\.(?:map|filter|slice|concat|flatMap|values)\s*\(/u.test(arg)
    || /^\s*\.\.\./u.test(arg)

  /** 实参是不是**对象**形态。刻意连空格一起归一：`{nodes,skipped}` 与 `{ nodes, skipped }` 是同一种错。 */
  const looksLikeObject = arg => /^\s*\{/u.test(arg.replace(/\s*([{},])\s*/gu, '$1'))

  for (const contract of ARRAY_CONTRACTS) {
    let called = 0
    let known = 0
    for (const [callerPath, callerSource] of sources) {
      const callerRel = relative(ROOT, callerPath).split(sep).join('/')
      if (callerRel === contract.file) continue
      const code = CODE.get(callerPath) ?? blankOut(callerSource)
      // ⚠️ 名字后面**必须紧跟 `(`** —— 否则会先命中"import 列表里的函数名"这种**没有调用**的位置，
      //    再由下面 `indexOf('(')` 向后找到**别的**括号，取出来的实参根本不是这次调用的。
      //    实测症状：假阳性指向一段注释里的代码片段，而真调用其实是好的 ——
      //    我这个检查器前面那两轮误报，全部来自这一处。
      for (const hit of code.matchAll(new RegExp(`(?<![\\w$.])${contract.name}\\s*\\(`, 'gu'))) {
        called += 1
        // ⚠️ 这里**只传命中位置**，不要再自己加偏移：`callArgsAt` 内部会
        //    `indexOf('(', index)` 定位那个括号。先前多传了 `hit[0].indexOf('(')`，
        //    于是定位偏到**同一行后面另一个**调用上，取出来的实参属于别人 ——
        //    报出的错因此指向一个与该调用无关的表达式（实测：报"实参是 003-….md"，
        //    而那其实是另一行的路径模板）。
        const arg = callArgsAt(code, hit.index)[contract.param]
        if (arg === undefined || arg === '') continue
        if (looksLikeArray(arg)) { known += 1; continue }
        // 已经解构过 `{ nodes }` 的自有变量，在插件源码里是已知约定，放行。
        if (/^(?:nodes|list|items|entries|candidates)$/u.test(arg)) { known += 1; continue }
        const verdict = looksLikeObject(arg) ? '看起来是个**对象**' : '既不像是数组'
        failures.push(`${callerRel} 调用 ${contract.name}() 时第 ${contract.param + 1} 个实参是 `
          + `\`${arg.slice(0, 40)}\` —— 该位置要的是**数组**，而它${verdict}。`
          + '传对象不会报错，只会让结果**静默退化成空数组**'
          + '（典型成因：函数返回形态从数组改成对象时漏改调用点）')
      }
    }
    // ★ 反查：这个函数在别处**一次都没被调用**时也要报 —— 多半是改名了，
    //   那意味着这条契约检查已经失去对象（静默失效的检查等于没有检查）。
    if (called === 0) {
      failures.push(`全仓找不到对 ${contract.name}() 的调用 —— 契约漂移（函数改名/删除），`
        + `请同步更新本检查的 ARRAY_CONTRACTS（当前登记：${contract.file}）`)
    } else {
      notes.push(`调用形态检查：${contract.name}() 共 ${called} 处调用，${known} 处实参形态可判`)
    }
  }
}

// ⑤ 客户端半侧的裸模块白名单
const ALLOWED_CLIENT = new Set(['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'])
for (const specifier of ['plugin-src/client/impl.mjs', 'plugin-src/client/index.mjs']) {
  const source = sources.get(join(ROOT, specifier))
  if (source === undefined) continue
  for (const entry of importsOf(source)) {
    if (entry.specifier.startsWith('.')) continue
    if (!ALLOWED_CLIENT.has(entry.specifier)) {
      failures.push(`${specifier} 引入了非白名单裸模块：${entry.specifier}（平台冻结模块表只给 react 系）`)
    }
  }
}

// ⑥ 宿主半侧不得 import 生态包（除宿主运行时提供的 @deepseek-ai/*）
for (const [file, source] of sources) {
  if (!file.includes(`${sep}host${sep}`)) continue
  for (const entry of importsOf(source)) {
    if (entry.specifier.startsWith('.') || entry.specifier.startsWith('node:')) continue
    if (entry.specifier.startsWith('@deepseek-ai/')) continue
    failures.push(`${relative(ROOT, file).split(sep).join('/')} 引入了 ${entry.specifier} —— 宿主半侧只允许 node: 内置与宿主运行时包`)
  }
}

// ⑦ 预设生成物不得含未注册的提示词变量 —— **这条闸是为一次真实事故加的**。
//
// 事故（两台真机都踩过）：DSH 0.2.1-alpha.1 起 loop 只注册 `provider` / `model`
// 两个内置提示词变量，**未注册变量在插值时直接抛错**（严格插值）；工作目录不再是
// 提示词变量，改由 working-directory 服务作为**运行时上下文**注入。而本插件的
// 预设生成器当时把 `{{cwd}}` 写死在 `persona.suffix` 里 ⇒ 每新建一个预设就重新
// 种一次故障：选中任何由本插件生成的预设，模型请求前即失败，
// `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`。
//
// 为什么判据落在**渲染输出**上，而不是扫源码字符串：真正被宿主插值的是产物；
// 源码里的字样可能只是注释、反例或检查器自己的报错文案。输出里没有，才是那条线。
//
// ⚠️ 这一条仍然只是静态体检的一条规则（`failures.push` 记账、最后统一 exit），
//    不替代 `npm test`：`test/preset-vars.test.mjs` 另有一条"把该行加回去，闸必须红"
//    的反向用例 —— 闸自己也要被验证过，否则它可能一直是红的或一直是绿的。
const ALLOWED_PROMPT_VARIABLES = ['provider', 'model']
{
  const presetModule = await import(new URL('../plugin-src/host/preset.mjs', import.meta.url).href)
  // 样例答案刻意**填满**：空槽位会走 `（未填写）` 分支，覆盖不到真实产物的形态。
  const sampleAnswers = {
    values: {
      name: '静态体检样例',
      vocation: '技术文档写作者',
      audience: '刚接手知识库的同事',
      expectation: '三个月内能独立维护一套索引',
      interests: ['知识管理', '写作'],
      goal: '把散落的笔记变成可检索的节点',
      baseline: '会写但不成体系',
      style: '先给结论再给依据',
      priority: '把索引补齐',
      trust: '能给出处才算成立',
      judge: '先保稳定再谈速度',
    },
    unknown: {},
  }
  const renders = [
    { label: 'renderAgentComposition()', text: presetModule.renderAgentComposition(sampleAnswers) },
    {
      label: 'renderPresetPatch()',
      text: presetModule.renderPresetPatch({
        presetId: 'learn-staticcheck',
        displayName: '静态体检样例',
        answers: sampleAnswers,
      }),
    },
  ]
  const allowed = new RegExp(`\\{\\{(?:${ALLOWED_PROMPT_VARIABLES.join('|')})\\}\\}`, 'gu')
  let checkedLines = 0
  for (const render of renders) {
    String(render.text).split('\n').forEach((line, index) => {
      checkedLines += 1
      // 先剥掉白名单变量，再问"还剩不剩花括号" —— 比只按命名正则扫更严：
      // `{{Foo}}`、`{{ }}`、落单的 `}}` 都由同一条判据接住。
      if (!/\{\{|\}\}/u.test(line.replace(allowed, ''))) return
      const named = [...line.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/gu)].map(match => match[1])
      const why = named.length === 0
        ? '出现了无法识别的花括号写法'
        : `出现了未注册的提示词变量 {{${named[0]}}}（白名单：${ALLOWED_PROMPT_VARIABLES.join(' / ')}）`
      failures.push(`plugin-src/host/preset.mjs 的 ${render.label} 输出第 ${index + 1} 行${why}：`
        + `\`${line.trim()}\` —— 宿主会把它当提示词变量插值，未注册变量直接抛错`
        + '（DSH 0.2.1-alpha.1 起只注册 provider / model；工作目录改由运行时上下文注入）')
    })
  }
  notes.push(`提示词变量白名单检查：${renders.length} 份渲染产物 / ${checkedLines} 行`)
}

console.log(`静态一致性体检：${notes.join('；')}`)
if (failures.length === 0) {
  console.log('✓ 通过（相对 import 齐全、具名符号存在、语法可解析、客户端模块白名单、宿主依赖面、提示词变量白名单）')
  console.log('⚠️ 这只证明静态一致性，**不证明行为** —— 必须另外跑 npm test / npm run verify。')
  process.exit(0)
}
console.error(`✗ ${failures.length} 处问题：`)
for (const failure of failures) console.error(`  · ${failure}`)
process.exit(1)
