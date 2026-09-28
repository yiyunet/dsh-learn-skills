/**
 * inspect-bundle.mjs —— 产物体检（`npm run inspect`）。
 *
 * 目的：当 verify 或运行时报错时，先让人**一眼看到产物实况**，而不是靠猜。
 * 只读，不改任何文件。
 *
 * @module dsh-learn-skills/inspect
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const LIB = join(ROOT, 'lib')

async function walk(directory) {
  const out = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

function findMarker(haystack, needle) {
  if (haystack.includes(needle)) return 'literal'
  const escaped = [...needle].map(char => char.charCodeAt(0) > 127
    ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    : char).join('')
  if (haystack.includes(escaped)) return 'escaped'
  return undefined
}

const exists = await stat(LIB).then(info => info.isDirectory()).catch(() => false)
if (!exists) {
  console.error('✗ 没有 lib/ —— 先跑 `npm run build`。')
  process.exit(1)
}

const files = (await walk(LIB)).map(file => `lib/${relative(LIB, file).split(sep).join('/')}`).sort()
console.log(`lib/ 共 ${files.length} 个文件：`)
for (const file of files) {
  const info = await stat(join(ROOT, file))
  console.log(`  · ${file}（${info.size} 字节）`)
}

const client = await readFile(join(LIB, 'client.js'), 'utf8').catch(() => undefined)
console.log('')
if (client === undefined) {
  console.error('✗ 缺少 lib/client.js —— 客户端半侧不会被装载。')
} else {
  const markers = [
    ['装载器 id', '@yiyunet/dsh-learn-skills'],
    ['槽位契约', 'conversation.input.left'],
    ['菜单标题', 'AI学习'],
    ['RPC 端点名', 'dsh-learn-skills'],
    ['入口一', '初始预设'],
    ['入口二', '收集提炼'],
    ['入口三', '关联升级'],
    ['入口四', '沉淀复用'],
    ['全局名', '__DshLearnSkills'],
    ['装配证据', '__ModuleLoader__'],
  ]
  console.log('lib/client.js 标记检查：')
  for (const [label, needle] of markers) {
    const found = findMarker(client, needle)
    console.log(`  ${found === undefined ? '✗' : '✓'} ${label}「${needle}」${found === 'escaped' ? '（\\uXXXX 转义形式，正常）' : ''}`)
  }
  const factoryIndex = client.indexOf('factory:')
  const requireIndex = client.indexOf('require("react")')
  const assembled = factoryIndex >= 0 && (requireIndex === -1 || requireIndex > factoryIndex)
  console.log(`  ${assembled ? '✓' : '✗'} 提交在 wrapper factory 内部（factory@${factoryIndex}, require("react")@${requireIndex}）`)
  console.log(`  ${client.includes('__DSH_CLIENT_BUNDLE__') ? '✗ 仍留着占位符' : '✓'} 占位符已被真实产物替换`)
  console.log(`  · 大小：${(Buffer.byteLength(client, 'utf8') / 1024).toFixed(1)} KB`)
}

const host = await readFile(join(LIB, 'index.mjs'), 'utf8').catch(() => undefined)
console.log('')
if (host === undefined) {
  console.error('✗ 缺少 lib/index.mjs —— 宿主入口缺失，插件加载不了。')
} else {
  const inject = /export const inject = \[([^\]]*)\]/u.exec(host)
  console.log(`宿主入口：lib/index.mjs（${(Buffer.byteLength(host, 'utf8') / 1024).toFixed(1)} KB）`)
  console.log(`  · inject：${inject === null ? '未找到' : inject[1].replace(/\s+/gu, ' ').trim()}`)
  console.log(`  · 构建横幅：${host.startsWith('// ⚠️ 本文件由') ? '有（说明是产物而非手改）' : '✗ 缺失'}`)
  const hostFiles = files.filter(file => file.endsWith('.mjs'))
  console.log(`  · 宿主半侧文件：${hostFiles.length} 个`)
}
