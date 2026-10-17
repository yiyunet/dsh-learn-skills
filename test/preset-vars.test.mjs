/**
 * preset-vars.test.mjs —— 「生成的预设里不许出现提示词变量」的回归测试。
 *
 * 为什么这条要单独成文件：它对应一次**已经复发过**的真实事故 ——
 * DSH 0.2.1-alpha.1 起 loop 只注册 `provider` / `model` 两个内置提示词变量，
 * 未注册变量在插值时**直接抛错**（严格插值）；工作目录改由 working-directory 服务
 * 作为运行时上下文注入。而生成器当时把 `{{cwd}}` 写死在 `persona.suffix` 里
 * ⇒ 每新建一个预设就重新种一次故障（选中即报 `unknown prompt variable "{{cwd}}"`）。
 *
 * 只删掉那一行是不够的（下一次"顺手补一句"就会加回来），所以这里钉三件事：
 *   ① 渲染产物里**不含任何**花括号变量；
 *   ② 用户正文里写了 `{{ }}` 时，入参处就拒绝（且给出能照着改的文案）；
 *   ③ **闸本身是活的** —— 把那一行故意加回去，`scripts/static-check.mjs` 必须红。
 *      这里用「控制组 + 实验组」两跑：先证明能绿，再证明能红。只证"能红"是不够的 ——
 *      一个恒红的闸同样教人忽略红灯。
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createPreset, findPromptVariable, renderAgentComposition, renderPresetPatch, validateAnswers,
} from '../plugin-src/host/preset.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 全填样例：空槽位会走 `（未填写）` 分支，覆盖不到真实产物形态。 */
const FILLED = {
  values: {
    name: '预设变量回归',
    vocation: '运维工程师',
    audience: '值班同事',
    expectation: '夜班也能自己定位问题',
    interests: ['故障复盘', '脚本'],
    goal: '把排障经验变成可检索的清单',
    baseline: '会看日志但不成体系',
    style: '先给结论再给依据',
    priority: '把常见故障的处置步骤写下来',
    trust: '能复现才算成立',
    judge: '先保稳定再谈速度',
  },
  unknown: {},
}

/** 全未填样例：走 `（未填写）` 分支，验证默认路径也不夹带变量。 */
const EMPTY = { values: { name: '预设变量回归' }, unknown: {} }

/** 含中文标点、单个花括号与 YAML 语法字符的样例 —— 用来证明"闸没有误伤"。 */
const PUNCTUATED = {
  values: {
    ...FILLED.values,
    style: '先给结论；再给依据（例如 `!!js process.platform === \'win32\'` 这类写法要原样保留）',
    baseline: '会算 {x} 这种单花括号的数学式子，也会写 { 单个花括号 }',
  },
  unknown: {},
}

describe('渲染产物不得含提示词变量', () => {
  for (const [label, answers] of [['全填', FILLED], ['全未填', EMPTY], ['含标点与单花括号', PUNCTUATED]]) {
    it(`${label}样例：renderAgentComposition 输出不含 {{ 或 }}`, () => {
      const text = renderAgentComposition(answers)
      assert.equal(/\{\{|\}\}/u.test(text), false, `产物里出现了花括号变量：\n${text}`)
    })

    it(`${label}样例：renderPresetPatch 输出不含 {{ 或 }}`, () => {
      const text = renderPresetPatch({ presetId: 'learn-vars', displayName: answers.values.name, answers })
      assert.equal(/\{\{|\}\}/u.test(text), false, `产物里出现了花括号变量：\n${text}`)
    })
  }

  it('对照组：产物里确实还写着 persona 行（证明"没有花括号"不是因为什么都没渲染）', () => {
    const text = renderAgentComposition(FILLED)
    assert.match(text, /@deepseek-ai\/dsh-persona/u)
    assert.match(text, /prefix: \|-/u)
    assert.match(text, /运维工程师/u)
  })
})

describe('入参闸：用户正文里的 {{ }} 必须在落库前被拒绝', () => {
  it('正文含 {{foo}} ⇒ 报 PROMPT_VARIABLE，且该字段保持未知', () => {
    const result = validateAnswers({ name: '带变量', style: '我喜欢 {{foo}} 这种写法' })
    assert.equal(result.ok, false)
    const error = result.errors.find(item => item.code === 'PROMPT_VARIABLE')
    assert.ok(error !== undefined, `没有报出 PROMPT_VARIABLE：${JSON.stringify(result.errors)}`)
    assert.equal(error.topic, 'style')
    // 报错文案必须能指导用户改：既点名「{{ }}」，也给一个等价写法。
    assert.match(error.message, /\{\{ \}\}/u)
    assert.match(error.message, /运行时上下文/u)
    assert.equal(result.normalized.values.style, null)
    assert.equal(result.normalized.unknown.style, true)
  })

  it('只写落单的 }} 也算命中（插值同样会炸）', () => {
    const result = validateAnswers({ name: '带变量', style: '结尾多打了一个 }}' })
    assert.equal(result.ok, false)
    assert.equal(result.errors.find(item => item.code === 'PROMPT_VARIABLE')?.topic, 'style')
  })

  it('关注方向（多选自由文本）同样被拦', () => {
    const result = validateAnswers({ name: '带变量', interests: ['正常方向', '{{分支}}'] })
    assert.equal(result.ok, false)
    assert.equal(result.errors.find(item => item.code === 'PROMPT_VARIABLE')?.topic, 'interests')
    assert.equal(result.normalized.values.interests, null)
  })

  it('名字里带 {{ }} 也被拦（名字会进人设首句）', () => {
    const result = validateAnswers({ name: '{{名字}}' })
    assert.equal(result.ok, false)
    assert.equal(result.errors.find(item => item.code === 'PROMPT_VARIABLE')?.topic, 'name')
  })

  it('对照组：单花括号与 !!js 语法**不得**被误伤', () => {
    const result = validateAnswers({
      name: '正常名字',
      style: "!!js process.platform === 'win32'",
      baseline: '会算 {x} 这种单花括号，也会写 { 单个花括号 }',
    })
    assert.equal(result.ok, true, `误伤了合法内容：${JSON.stringify(result.errors)}`)
    assert.equal(result.normalized.values.style, "!!js process.platform === 'win32'")
  })
})

describe('生成侧兜底闸：绕过问答环直接调 createPreset 也拦得住', () => {
  let presetRoot

  before(async () => {
    presetRoot = await mkdtemp(join(tmpdir(), 'learn-skills-vars-'))
  })

  after(async () => {
    await rm(presetRoot, { recursive: true, force: true })
  })

  it('findPromptVariable 能定位到具体字段', () => {
    assert.equal(findPromptVariable(FILLED), null)
    const hit = findPromptVariable({ values: { ...FILLED.values, style: 'x {{y}}' } })
    assert.deepEqual(hit, { topic: 'style', value: 'x {{y}}' })
  })

  it('createPreset 拒绝含变量的答案，且一个文件都不写', async () => {
    const result = await createPreset({
      presetRoot,
      presetId: 'learn-badvars',
      displayName: '带变量的预设',
      answers: { values: { ...FILLED.values, style: '我要 {{cwd}}' }, unknown: {} },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'PROMPT_VARIABLE')
    assert.match(result.message, /\{\{ \}\}/u)
    // 刻意**不开** dryRun：这样"没写盘"才是闸的功劳，而不是 dryRun 的功劳。
    const exists = await stat(result.directory).then(() => true, () => false)
    assert.equal(exists, false, '拒绝必须发生在写盘之前 —— 目录都不该被建出来')
  })

  it('对照组：干净答案能正常生成（证明上面那条不是因为 createPreset 恒失败）', async () => {
    const result = await createPreset({
      presetRoot,
      presetId: 'learn-goodvars',
      displayName: '干净预设',
      answers: FILLED,
    })
    assert.equal(result.ok, true, String(result.message ?? ''))
    assert.equal(result.decisions.length, 2)
    const patch = await readFile(join(result.directory, 'cordis.patch.yml'), 'utf8')
    assert.equal(/\{\{|\}\}/u.test(patch), false, patch)
  })
})

describe('静态闸是活的：控制组必须绿，实验组（把 suffix 行加回去）必须红', () => {
  let sandbox

  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'learn-skills-gate-'))
    // 只复制闸要扫的两棵子树：闸自己（scripts/）与被扫的真源（plugin-src/）。
    for (const dir of ['plugin-src', 'scripts']) {
      await cp(join(ROOT, dir), join(sandbox, dir), { recursive: true })
    }
  })

  after(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  const runStaticCheck = () => spawnSync(process.execPath, ['scripts/static-check.mjs'], {
    cwd: sandbox,
    encoding: 'utf8',
  })

  it('控制组 + 实验组', async () => {
    // ① 控制组：未改动的副本必须通过。没有这一步，"红"可能只是闸一直坏着。
    const control = runStaticCheck()
    assert.equal(control.status, 0, `控制组本该通过，实得 exit ${control.status}：\n${control.stderr}`)
    assert.match(control.stdout, /提示词变量白名单检查/u)

    // ② 实验组：把事故那一行塞回 persona 配置，闸必须报出来并 exit 1。
    const presetPath = join(sandbox, 'plugin-src', 'host', 'preset.mjs')
    const original = await readFile(presetPath, 'utf8')
    const anchor = "    '    prefix: |-',"
    assert.ok(original.includes(anchor), '找不到插入锚点 —— 生成器的 persona 配置形态已变，请同步本用例')
    try {
      await writeFile(presetPath, original.replace(anchor, `    '    suffix: Your working directory is {{cwd}}.',\n${anchor}`), 'utf8')
      const experiment = runStaticCheck()
      assert.equal(experiment.status, 1, `实验组本该失败，实得 exit ${experiment.status}：\n${experiment.stdout}`)
      assert.match(experiment.stderr, /\{\{cwd\}\}/u)
      assert.match(experiment.stderr, /plugin-src\/host\/preset\.mjs/u)
    } finally {
      await writeFile(presetPath, original, 'utf8')
    }

    // ③ 复原后必须回到绿：证明实验组的红来自那一行，而不是拷贝过程留下的副作用。
    const restored = runStaticCheck()
    assert.equal(restored.status, 0, `复原后本该通过，实得 exit ${restored.status}：\n${restored.stderr}`)
  })
})
