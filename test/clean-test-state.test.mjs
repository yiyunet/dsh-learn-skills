/**
 * clean-test-state.test.mjs —— 清理工具必须**只删本插件自己的东西**。
 *
 * 为什么值得单测：这个脚本会**真删目录**，而它跑的机器上有用户的手工预设
 * （如 `alpha`）与已有工作区内容。判据一旦写成"按目录名匹配"或"删整个 .dsh"，
 * 就会造成不可逆的损失 —— 所以判据必须被钉死：**看文件里的生成标记**，
 * 工作区只碰 `.dsh/learn-skills/`。
 */
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { applyCleanup, planCleanup, scanResidue } from '../scripts/clean-test-state.mjs'

let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'learn-skills-clean-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * 造一个预设目录。
 * @param {string} presetRoot 预设根
 * @param {string} id 目录名
 * @param {{generated: boolean}} options 是否带本插件的生成标记
 * @returns {Promise<string>} 目录路径
 */
async function makePreset(presetRoot, id, { generated }) {
  const dir = join(presetRoot, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `@local/dsh-learn-preset-${id}`,
    version: '1.0.0',
    private: true,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2), 'utf8')
  await writeFile(
    join(dir, 'cordis.patch.yml'),
    `${generated ? `# 「${id}」的学习 Agent 预设 —— 由 @yiyunet/dsh-learn-skills 生成。\n` : '# 手工预设（无插件生成标记）\n'}`
      + '- insert:\n'
      + `    - id: preset-${id}\n`
      + "      name: '@deepseek-ai/dsh-agent-preset'\n"
      + '      config:\n'
      + `        id: ${id}\n`
      + `        name: '${id} 的名字'\n`
      + '        order: 50\n'
      + '        plugins:\n'
      + '          - id: persona\n'
      + "            name: '@deepseek-ai/dsh-persona'\n",
    'utf8',
  )
  return dir
}

describe('clean-test-state —— 只删本插件生成的东西', () => {
  it('★ 有生成标记的预设才删；手工预设一个字节都不许动', async () => {
    const presetRoot = join(root, 'presets-1')
    const generatedDir = await makePreset(presetRoot, 'learn-abc123', { generated: true })
    const handmadeDir = await makePreset(presetRoot, 'alpha', { generated: false })

    const plan = await planCleanup({ presetRoot, workspace: join(root, 'no-such-ws') })
    assert.equal(plan.presets.filter(preset => preset.generated).map(preset => preset.id).join(),
      'learn-abc123')
    assert.equal(plan.presets.find(preset => preset.id === 'alpha').generated, false)

    const result = await applyCleanup(plan)
    assert.equal(existsSync(generatedDir), false, '插件生成的预设必须被删掉')
    assert.equal(existsSync(handmadeDir), true, '手工预设绝不能被删')
    assert.equal(result.removed.length, 1)
    assert.equal(result.skipped.length, 1)
  })

  it('工作区只删 .dsh/learn-skills；knowledge/ 等既有内容不碰', async () => {
    const presetRoot = join(root, 'presets-2')
    await mkdir(presetRoot, { recursive: true })
    const ws = join(root, 'ws-2')
    const state = join(ws, '.dsh', 'learn-skills')
    const keep = join(ws, 'knowledge', 'nodes')
    await mkdir(state, { recursive: true })
    await mkdir(keep, { recursive: true })
    await writeFile(join(state, 'session.json'), '{}\n', 'utf8')
    await writeFile(join(keep, 'N01.md'), 'x\n', 'utf8')

    const plan = await planCleanup({ presetRoot, workspace: ws })
    assert.equal(plan.state.exists, true)

    await applyCleanup(plan)
    assert.equal(existsSync(state), false, '状态目录要删')
    assert.equal(existsSync(keep), true, '工作区内容（知识节点）绝不能被清理工具碰到')
  })

  it('预设根不存在时不抛（返回空计划）', async () => {
    const plan = await planCleanup({
      presetRoot: join(root, 'nope'),
      workspace: join(root, 'nope-ws'),
    })
    assert.deepEqual(plan.presets, [])
    assert.equal(plan.state.exists, false)
  })
})

describe('clean-test-state —— 只删一个（--only）不该牵连其它', () => {
  it('★ --only 只选中点名的那个；其它插件生成的预设保持不动', async () => {
    const presetRoot = join(root, 'presets-only')
    const named = await makePreset(presetRoot, 'learn-aaa', { generated: true })
    const other = await makePreset(presetRoot, 'learn-bbb', { generated: true })

    const plan = await planCleanup({ presetRoot, workspace: join(root, 'ws-only'), only: ['learn-aaa'] })
    assert.equal(plan.scope, 'only-listed')
    assert.deepEqual(plan.presets.filter(preset => preset.selected).map(preset => preset.id), ['learn-aaa'])

    await applyCleanup(plan)
    assert.equal(existsSync(named), false, '点名的要删')
    assert.equal(existsSync(other), true, '没点名的插件生成预设也不许删')
  })

  it('★ --only 默认不动工作区状态（那是"重置插件记忆"，另一件事）', async () => {
    const presetRoot = join(root, 'presets-only-2')
    await makePreset(presetRoot, 'learn-ccc', { generated: true })
    const ws = join(root, 'ws-only-2')
    const state = join(ws, '.dsh', 'learn-skills')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'session.json'), '{}\n', 'utf8')

    const plan = await planCleanup({ presetRoot, workspace: ws, only: ['learn-ccc'] })
    assert.equal(plan.state.selected, false, '--only 时状态默认不动')
    await applyCleanup(plan)
    assert.equal(existsSync(state), true)

    const withState = await planCleanup({ presetRoot, workspace: ws, only: ['learn-ccc'], withState: true })
    assert.equal(withState.state.selected, true, '显式 --with-state 才动')
  })

  it('点名删一个"不是本插件生成的"预设 ⇒ 仍然不删（判据在文件内容里）', async () => {
    const presetRoot = join(root, 'presets-only-3')
    const handmade = await makePreset(presetRoot, 'alpha', { generated: false })

    const plan = await planCleanup({ presetRoot, workspace: join(root, 'ws-only-3'), only: ['alpha'] })
    assert.equal(plan.presets.find(preset => preset.id === 'alpha').selected, false)
    await applyCleanup(plan)
    assert.equal(existsSync(handmade), true)
    assert.ok(plan.notes.some(note => note.includes('没有本插件的生成标记')))
  })
})

describe('clean-test-state --scan —— 识别残留（只读）', () => {
  it('★ 残缺预设（缺 cordis.patch.yml）被标出', async () => {
    const presetRoot = join(root, 'scan-1')
    const dir = join(presetRoot, 'learn-noic')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), '{"name":"@local/x","version":"1.0.0"}\n', 'utf8')

    const report = await scanResidue({
      presetRoot,
      workspace: join(root, 'ws-scan-1'),
      workspaceRegistryPath: join(root, 'no-registry.json'),
    })

    const item = report.presets.find(preset => preset.id === 'learn-noic')
    assert.equal(item.incomplete, true)
    assert.ok(item.missing.includes('cordis.patch.yml'))
    assert.equal(report.registry.exists, false, '登记表不存在时如实标注，不抛')
  })

  it('★ 孤儿工作区登记（路径已不存在）被标出', async () => {
    const registryPath = join(root, 'registry.json')
    await writeFile(registryPath, JSON.stringify({
      tables: {
        workspaces: {
          gone: { path: join(root, 'gone-ws'), title: '已删的工作区', sessionIds: [] },
          here: { path: root, title: '还在的工作区', sessionIds: ['session-x'] },
        },
      },
    }), 'utf8')

    const report = await scanResidue({
      presetRoot: join(root, 'scan-2'),
      workspace: join(root, 'ws-scan-2'),
      workspaceRegistryPath: registryPath,
    })

    assert.equal(report.registry.exists, true)
    assert.deepEqual(report.registry.workspaces.filter(item => item.exists === false).map(item => item.title),
      ['已删的工作区'])
    assert.equal(report.registry.workspaces.find(item => item.title === '还在的工作区').exists, true)
  })

  it('★ 死引用（known.json 记了、预设根却没有）被标出', async () => {
    const presetRoot = join(root, 'scan-3')
    await mkdir(presetRoot, { recursive: true })
    const ws = join(root, 'ws-scan-3')
    const state = join(ws, '.dsh', 'learn-skills')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'known.json'),
      JSON.stringify({ presetIds: ['learn-gone'], presetNames: ['消失的预设'] }), 'utf8')

    const report = await scanResidue({
      presetRoot,
      workspace: ws,
      workspaceRegistryPath: join(root, 'no-registry.json'),
    })

    assert.equal(report.known.exists, true)
    assert.deepEqual(report.known.deadIds, ['learn-gone'])
    assert.deepEqual(report.known.names, ['消失的预设'])
  })
})

describe('默认预设根随工作区走（2.1.0）', () => {
  it('★ 不给 --preset-root 时，默认根＝<工作区>/.dsh/preset-bundles', async () => {
    // 2.0.0 的默认根是 `<dshHome>/preset-bundles` —— 那里现在住着**部署方自己的组合包**
    // （如 `dsh-migrated-presets`，一个文件里声明 12 个预设），不属于本插件。
    // 若默认还指向它，本工具会去数别人的产物 ⇒ 既可能误报，也可能误删。
    const ws = join(root, 'ws-default-root')
    const expectedRoot = join(ws, '.dsh', 'preset-bundles')
    await makePreset(expectedRoot, 'learn-default', { generated: true })

    const plan = await planCleanup({ workspace: ws })
    assert.equal(plan.presetRoot, expectedRoot)
    assert.deepEqual(plan.presets.map(item => item.id), ['learn-default'])
    assert.equal(plan.presets[0].selected, true, '带生成标记 ⇒ 默认会被选中（这是 `--yes` 的影响面）')

    const report = await scanResidue({ workspace: ws, workspaceRegistryPath: join(root, 'no-registry-2.json') })
    assert.equal(report.presetRoot, expectedRoot)
    assert.deepEqual(report.presets.map(item => item.id), ['learn-default'])
  })

  it('★ 残缺判据是**两件套**（不再把 AGENTS.md 当必需件）', async () => {
    // 2.1.0 起 bundle 只写 package.json + cordis.patch.yml（官方 SKILL: "exactly two files"）。
    // 若判据还留着 AGENTS.md，每个健康的本插件预设都会被误报成"残缺"。
    const ws = join(root, 'ws-two-files')
    const presetRoot = join(ws, '.dsh', 'preset-bundles')
    await makePreset(presetRoot, 'learn-ok', { generated: true })

    const report = await scanResidue({ workspace: ws, workspaceRegistryPath: join(root, 'no-registry-3.json') })
    const preset = report.presets.find(item => item.id === 'learn-ok')
    assert.deepEqual(preset.missing, [], '两件套齐全 ⇒ 不缺件')
    assert.equal(preset.incomplete, false)
    assert.equal(preset.residual, false, '健康预设不得被当成残留')
  })
})
