/**
 * command-router.test.mjs —— `/learn` 命令的路由（外部测评 #1321 的 F2）。
 *
 * 为什么值得单独一个文件：本仓此前的测试**全部直接调 `flows.*`**，于是
 * 「帮助文本承诺了 `/learn rollback`、命令路由里却没有这个分支」这类
 * **承诺与实现之间的裂缝**完全测不到 —— 自带 349 条测试全绿，命令却报「未知入口」。
 *
 * 所以这里用真实 `apply(ctx)` ＋ 桩 `commands` 截获 handler，把命令**当命令**测。
 *
 * ⚠️ 已知副作用：`apply()` 里的诊断出口会往 `~/.dsh/learn-skills-boot.log`
 *    追加一行（插件既有行为，见 index.mjs 的 `diagnose()`）。它不影响断言。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { apply } from '../plugin-src/host/index.mjs'

/**
 * 最小宿主桩：只够把 `apply()` 跑起来并截获命令 handler。
 *
 * 刻意**不给** `connection` / `agents` / `workspaceRegistry` ——
 * 这正是"未绑定工作区"的真实情形，用来验证命令**先走到 flows**，
 * 而不是被命令层用「未知入口」挡回去。
 * @returns {(input: string) => Promise<{ kind: string, text: string }>} 执行入口
 */
function commandHarness() {
  let handler
  const ctx = {
    logger: { info() {}, warn() {} },
    commands: {
      register: definition => {
        handler = definition.handler
        return () => {}
      },
    },
    effect: () => () => {},
    get: () => undefined,
    userQuestions: { ask: async () => ({ answers: [] }) },
  }
  apply(ctx, {})
  assert.equal(typeof handler, 'function', 'apply() 应当注册 /learn 命令')
  return input => handler({ rawInput: input, agent: { id: 'session-test' } })
}

describe('/learn 命令路由 —— 承诺的命令必须真的可达（测评 #1321 的 F2）', () => {
  it('★ /learn rollback <批次号> 不再报「未知入口」', async () => {
    const run = commandHarness()
    const result = await run('rollback U20261020-abcd')
    assert.ok(!String(result.text).includes('未知入口'),
      `命令仍在报未知入口（F2 未修）：${result.text}`)
    // 桩里没有工作区 ⇒ `flows.rollback` 会以 NO_WORKSPACE 结束。
    // 这恰恰是"路由已经通了"的证据：它进了业务流程，而不是被命令层挡下。
    assert.match(String(result.text), /工作区|批次/u,
      `应已进入 flows.rollback，实得：${result.text}`)
  })

  it('不给批次号时给出用法，而不是「未知入口」', async () => {
    const run = commandHarness()
    const result = await run('rollback')
    assert.match(String(result.text), /用法/u)
    assert.ok(!String(result.text).includes('未知入口'))
  })

  it('帮助里四个入口齐全，且说明 rollback 是附加动作', async () => {
    const run = commandHarness()
    const help = await run('help')
    for (const label of ['初始预设', '收集提炼', '关联升级', '沉淀复用']) {
      assert.ok(String(help.text).includes(label), `帮助里缺「${label}」`)
    }
    assert.ok(String(help.text).includes('rollback'), '帮助里应说明 rollback')
  })

  it('真未知的入口仍然报错（放行 rollback ≠ 什么都放行）', async () => {
    const run = commandHarness()
    const result = await run('nonsense')
    assert.equal(result.kind, 'error')
    assert.match(String(result.text), /未知入口/u)
  })
})
