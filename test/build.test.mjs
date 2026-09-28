/**
 * build.test.mjs —— 构建产物的转义与标记契约测试。
 *
 * 这一组守的是一个**真的踩过的坑**：esbuild 会把非 ASCII 字符写成 `\uXXXX`
 * 转义形式，于是"产物里没有这个中文串"这句话可能是假阴性 ——
 * 串在，只是被转义了。
 *
 * 本插件的构建靠 `findMarker()`（字面量 + 转义两种形态都算命中）来判，
 * 所以这个测试验的其实是**那个判断函数本身对不对**：
 *   ① esbuild 真实的转义产物里，中文串**应该**能以转义形态被找到；
 *   ② 一个真的不存在的串**必须**找不到（否则 findMarker 会永远返回"找到了"，
 *      那就等于标记检查根本没做）。
 *
 * ② 是这条断言的**对照组**：只验"找得到"，不验"找得到的东西真的存在"，
 * 就分不清"检查通过"与"检查永远通过"。
 */
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

// 从 **零依赖** 的 markers.mjs 取，不从 build.mjs 取 —— 后者顶层 import esbuild，
// 会让这组契约测试在"只跑了 npm run static"的机器上直接爆掉。
import { CLIENT_EXTERNAL, ENTRY_LABELS, findMarker, REQUIRED_MARKERS } from '../scripts/markers.mjs'

const ROOT = resolve(import.meta.dirname, '..')

describe('findMarker —— 标记查找的两形态判定', () => {
  it('字面量命中', () => {
    assert.equal(findMarker('const x = "AI学习"', 'AI学习'), 'literal')
  })

  it('\\uXXXX 转义形态也算命中（esbuild 的正常处理）', () => {
    const escaped = 'const x = "AI\\u5b66\\u4e60"'
    assert.equal(findMarker(escaped, 'AI学习'), 'escaped')
  })

  it('大写十六进制转义也算命中', () => {
    assert.equal(findMarker('"\\u5B66\\u4E60"', '学习'), 'escaped')
  })

  it('对照组：真不存在的串必须找不到', () => {
    assert.equal(findMarker('const x = "AI学习"', '收集提炼'), undefined)
    assert.equal(findMarker('"\\u5b66\\u4e60"', '沉淀复用'), undefined)
  })
})

describe('标记表本身的自洽性', () => {

  it('标记表不许出现空针（空串是任何字符串的子串，会让检查恒真）', () => {
    for (const marker of REQUIRED_MARKERS) {
      assert.ok(typeof marker.needle === 'string' && marker.needle.length > 0,
        `标记「${marker.label}」的 needle 为空 —— 这条检查会永远通过`)
    }
  })

  it('四个入口的名称与顺序在标记表里逐字固定', () => {
    assert.deepEqual(ENTRY_LABELS, ['初始预设', '收集提炼', '关联升级', '沉淀复用'])
  })

  it('客户端外部模块白名单与平台冻结表一致', () => {
    assert.deepEqual(CLIENT_EXTERNAL, ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'])
  })
})

describe('宿主产物与真源一致 —— 改源必须重建，否则测试全绿而线上照旧', () => {
  /**
   * 这组守的是一个**真实踩过**的故障模式：修好了 `plugin-src/host/` 里的 bug、
   * 没跑 `npm run build`，于是 `lib/knowledge.mjs` 还是旧解析器。
   *
   * 为什么"测试全绿"骗人：全部测试 import 的是 `plugin-src/`（真源），
   * 而 DSH **实际加载**的是 `lib/`（产物）。两者漂移时，测试证明的是"源码对了"，
   * 不是"插件对了" —— 线上照样丢 frontmatter id。
   *
   * 判据必须与构建时**逐字**一致（含行尾与末尾换行）：构建产物的加载解析对
   * 行尾零容忍，这里放宽就等于把闸门让开。
   */

  /**
   * 在产物里定位源码的**字节起点**（找不到返回 -1）。
   *
   * 判据刻意做成"只认那一处、且不依赖任何解码假设"：
   *   ① 产物必须**以源码字节结尾**（构建做的事就是"前面插两行横幅"）；
   *   ② 起点 = 产物长度 − 源码长度。
   * 全程只用 `Buffer`，不碰字符串比较、不碰 BOM、不碰横幅文本。
   *
   * ⚠️ 前两版都栽在"想聪明一点"上：
   *    第一版在 utf8 解码层比字符串（横幅里的 U+FEFF 让 `startsWith` 恒假）；
   *    第二版拿源码的 SHA-256 当锚点（实测**锚点也找不到**）。
   *    反复修不好时，正确动作不是再想一个更聪明的锚，而是**换一条不需要锚的判据**。
   * @param {Buffer} built 产物字节
   * @param {number} sourceLength 源码字节长度
   * @returns {number} 源码起点偏移（不符合"以源码结尾"时为 -1）
   */
  function sourceOffsetIn(built, sourceLength) {
    if (built.length < sourceLength) return -1
    return built.length - sourceLength
  }

  it('每个宿主源码文件都有一份内容相同的 lib/ 产物（横幅除外）', async () => {
    if (!existsSync(join(ROOT, 'lib'))) return
    const names = (await readdir(join(ROOT, 'plugin-src', 'host')))
      .filter(name => name.endsWith('.mjs')).sort()
    assert.ok(names.length > 0, 'plugin-src/host/ 是空的 —— 测试装配错误，不是产物问题')
    const drifted = []
    for (const name of names) {
      const source = await readFile(join(ROOT, 'plugin-src', 'host', name))
      const built = await readFile(join(ROOT, 'lib', name)).catch(() => null)
      if (built === null) {
        drifted.push(`${name}（lib/ 里没有对应文件）`)
        continue
      }
      const offset = sourceOffsetIn(built, source.length)
      if (offset === -1) {
        drifted.push(`${name}（产物 ${built.length}B 比源码 ${source.length}B 还短 —— 不可能带着横幅）`)
        continue
      }
      if (built.subarray(offset).equals(source)) continue
      const stripped = built.subarray(offset).toString('utf8')
      const want = source.toString('utf8')
      let at = 0
      while (at < Math.min(stripped.length, want.length) && stripped[at] === want[at]) at += 1
      drifted.push(`${name}（产物 ${built.length}B（源码起点 @${offset} = ${built.length} − ${source.length}）/ `
        + `源码 ${source.length}B；首个不同字符在第 ${at} 位；还原后该处 ${JSON.stringify(stripped.slice(at, at + 24))}`
        + ` vs 源码 ${JSON.stringify(want.slice(at, at + 24))}）`)
    }
    assert.deepEqual(drifted, [],
      `lib/ 与 plugin-src/ 不同步：${drifted.join('、')}。\n`
      + '  → 跑 `npm run build` 重新生成 lib/。'
      + '（测试跑的是源码，DSH 加载的是 lib/；不重建就会出现"测试全绿、插件照旧出错"。）')
  })

  it('反向检查：lib/ 里没有源码已删除的残留宿主文件', async () => {
    if (!existsSync(join(ROOT, 'lib'))) return
    const sources = new Set((await readdir(join(ROOT, 'plugin-src', 'host'))).filter(name => name.endsWith('.mjs')))
    // client.js 是客户端半侧的产物（由 esbuild 生成），不在这条检查的对象里。
    const stale = (await readdir(join(ROOT, 'lib')))
      .filter(name => name.endsWith('.mjs') && !sources.has(name))
    assert.deepEqual(stale, [], `lib/ 里有源码中不存在的残留文件：${stale.join('、')} —— 跑 \`npm run build\` 清理`)
  })
})

describe('esbuild 实际转义行为 —— 用真实打包器验证，不靠猜测', () => {
  it('打包后的产物里，中文串能以字面量或转义形态被找到', async () => {
    let esbuild
    try {
      esbuild = await import('esbuild')
    } catch {
      // 未装 esbuild（例如只跑了 npm run static）时跳过，而不是判失败：
      // 这条测试的对象是构建期行为，没装构建依赖就无从验。
      return
    }
    const source = [
      'const MENU = [',
      "  { id: 'init', label: '初始预设', description: '六轮问答' },",
      "  { id: 'distill', label: '收集提炼' },",
      "  { id: 'upgrade', label: '关联升级' },",
      "  { id: 'audit', label: '沉淀复用' },",
      ']',
      'export const name = "learn-skills-client"',
      'export function apply() { return MENU }',
    ].join('\n')

    const result = await esbuild.build({
      stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'probe.mjs' },
      bundle: true,
      format: 'iife',
      globalName: 'Probe',
      platform: 'browser',
      target: 'esnext',
      minify: false,
      write: false,
      logLevel: 'silent',
    })
    const output = result.outputFiles[0].text

    for (const needle of ['AI学习', '初始预设', '收集提炼', '关联升级', '沉淀复用', 'learn-skills-client']) {
      const found = findMarker(output, needle)
      if (needle === 'AI学习') {
        // 上面那段源码里没有 AI学习，所以这里**应**为 undefined —— 对照组。
        assert.equal(found, undefined, '对照组失败：不存在的串居然命中')
        continue
      }
      assert.notEqual(found, undefined,
        `中文串「${needle}」在 esbuild 产物里既非字面量也非转义形态 —— findMarker 的转义算法与 esbuild 不一致。`
        + `产物片段：${output.slice(0, 200)}`)
    }
  })
})
