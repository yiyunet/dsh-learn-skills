/**
 * ui-text.test.mjs —— 界面文案的纯函数测试（2.2.3 新增）。
 *
 * 为什么这些文案值得单独测：它们是**用户唯一能看到的证据**。
 * 一次真实故障就是文案说错话 —— 范围为空时界面显示 `范围 ?–?｜完整历史`，
 * 读起来像"读完了、只是没东西"，实际是"一条消息都没读到"；而批次选择器只给
 * 一个批次号，用户没有依据在几批之间做选择。这两件事都不是"排版问题"，
 * 而是**说了假话 / 没说清**，所以必须钉死。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  batchChoice, distillEmptyReason, distillOverview, eventTypesText, plainText, rangeText, shortTime,
} from '../plugin-src/host/ui-text.mjs'

describe('plainText —— 界面是纯文本，星号不许漏出来', () => {
  it('成对的 ** 被剥掉', () => {
    assert.equal(plainText('本阶段**没有**修改任何正式知识'), '本阶段没有修改任何正式知识')
  })

  it('落单的 ** 也剥掉（文案写错时不该把星号丢给用户）', () => {
    assert.equal(plainText('这里有**一个落单标记'), '这里有一个落单标记')
  })

  it('没有星号时原样返回；非字符串输入不抛错', () => {
    assert.equal(plainText('普通文案'), '普通文案')
    assert.equal(plainText(undefined), '')
    assert.equal(plainText(null), '')
  })

  it('对照组：单个星号（乘号 / 通配符）不被误伤', () => {
    assert.equal(plainText('a * b 与 *.md'), 'a * b 与 *.md')
  })
})

describe('rangeText —— 空范围必须说"没读到"，不许退化成 ?–?', () => {
  it('正常范围给 seq from–to', () => {
    assert.equal(rangeText({ from: 3, to: 14 }), 'seq 3–14')
  })

  it('空范围说"未读到会话消息"（这是本次修复的核心判据）', () => {
    assert.equal(rangeText({ from: null, to: null }), '未读到会话消息')
    assert.equal(rangeText(undefined), '未读到会话消息')
    // ⚠️ 不许出现 `?`：界面上 `?–?` 与"已读完但序号算不出"无法区分。
    assert.equal(/\?/u.test(rangeText({ from: null, to: null })), false)
  })
})

describe('shortTime / eventTypesText', () => {
  it('时间戳截到分钟', () => {
    assert.equal(shortTime('2026-10-17T13:46:50'), '10-17 13:46')
  })

  it('认不出的时间戳原样截断，不抛错', () => {
    assert.equal(shortTime('不知道'), '不知道')
    assert.equal(shortTime(undefined), '')
  })

  it('事件类型分布按 `类型×次数` 拼', () => {
    assert.equal(
      eventTypesText({ eventTypes: [{ type: 'user/message', count: 18 }, { type: 'assistant/message', count: 19 }] }),
      'user/message×18、assistant/message×19',
    )
    assert.equal(eventTypesText(null), '')
  })
})

describe('distillOverview —— 要说清"收集了什么、提炼了什么"', () => {
  const base = {
    batchId: '002',
    createdAt: '2026-10-17T13:45:46',
    range: { from: 3, to: 14 },
    stats: { considered: 12, noise: 3, merged: 1, alreadyProcessed: 2 },
    readStats: { eventsRead: 37, messagesBuilt: 12, eventTypes: [{ type: 'user/message', count: 18 }] },
    candidates: [{ id: 'c1' }, { id: 'c2' }],
    kept: 1,
    excluded: 1,
  }

  it('第一行给出批次 / 时间 / 消息数 / 范围 / 候选与裁决数', () => {
    const [first] = distillOverview(base)
    assert.match(first, /批次 002/u)
    assert.match(first, /10-17 13:45/u)
    assert.match(first, /消息 12 条/u)
    assert.match(first, /seq 3–14/u)
    assert.match(first, /候选 2 条（保留 1 \/ 排除 1）/u)
  })

  it('第二行给出明细（噪声 / 重复 / 已处理 / 事件读数）', () => {
    const [, second] = distillOverview(base)
    assert.match(second, /噪声 3/u)
    assert.match(second, /同批重复合并 1/u)
    assert.match(second, /与旧批次重复 2/u)
    assert.match(second, /会话事件 37 条/u)
    assert.match(second, /建出消息 12 条/u)
  })

  it('有事件类型时补第三行', () => {
    const lines = distillOverview(base)
    assert.equal(lines.length, 3)
    assert.match(lines[2], /user\/message×18/u)
  })

  it('读统计缺失时不编数（不写"会话事件 undefined"）', () => {
    const lines = distillOverview({ ...base, readStats: null })
    assert.equal(lines.some(line => /undefined/u.test(line)), false)
    assert.equal(lines.length, 2)
  })

  it('0 候选 0 消息时，范围文本是"未读到会话消息"', () => {
    const lines = distillOverview({
      batchId: '003', createdAt: '2026-10-17T13:46:50', range: { from: null, to: null },
      stats: { considered: 0, noise: 0, merged: 0, alreadyProcessed: 0 },
      readStats: { eventsRead: 0, messagesBuilt: 0, eventTypes: [] }, candidates: [], kept: 0, excluded: 0,
    })
    assert.match(lines[0], /未读到会话消息/u)
    assert.equal(lines.some(line => /\?–\?/u.test(line)), false)
  })
})

describe('distillEmptyReason —— 0 候选必须说清原因', () => {
  it('有候选时返回 null（不做多余提示）', () => {
    assert.equal(distillEmptyReason({ candidates: [{ id: 'c1' }] }), null)
  })

  it('没读到消息：点名事件读数，并请用户把这行发回来', () => {
    const reason = distillEmptyReason({
      candidates: [], stats: { considered: 0 },
      readStats: { eventsRead: 0, messagesBuilt: 0, eventTypes: [] },
    })
    assert.match(reason, /未读到本会话的消息/u)
    assert.match(reason, /会话事件 0 条/u)
    assert.match(reason, /发我/u)
  })

  it('全是噪声：给出被过滤的条数', () => {
    const reason = distillEmptyReason({
      candidates: [], stats: { considered: 5, noise: 5 },
      readStats: { eventsRead: 9, messagesBuilt: 5, eventTypes: [] },
    })
    assert.match(reason, /5 条消息全部被判为噪声/u)
  })

  it('全是旧批次重复：指出这一点', () => {
    const reason = distillEmptyReason({
      candidates: [], stats: { considered: 2, noise: 0, alreadyProcessed: 2 },
      readStats: { eventsRead: 4, messagesBuilt: 2, eventTypes: [] },
    })
    assert.match(reason, /与旧批次重复/u)
  })

  it('原因未明时如实说"未明"，不编一个理由', () => {
    const reason = distillEmptyReason({ candidates: [], stats: {}, readStats: null })
    assert.match(reason, /原因未明/u)
  })
})

describe('batchChoice —— 升级时要能看懂每一批是什么', () => {
  const batch = { batchId: '002', createdAt: '2026-10-17T13:45:46' }
  const file = {
    candidates: [
      { id: 'c1', title: '热成像仪的标定步骤' },
      { id: 'c2', title: '声成像仪的信噪比判据' },
      { id: 'c3', title: '北美站的合规要求（FCC 标识）' },
      { id: 'c4', title: '第四条候选' },
    ],
  }

  it('label 以「批次 <id>」开头（宿主靠它反解批次 id）', () => {
    const choice = batchChoice(batch, file)
    assert.equal(choice.label.startsWith('批次 002'), true, choice.label)
  })

  it('label 里带时间与待裁决条数', () => {
    const choice = batchChoice(batch, file)
    assert.match(choice.label, /10-17 13:45/u)
    assert.match(choice.label, /待裁决 4 条/u)
  })

  it('description 列出前三条内容（不是只给一个批次号）', () => {
    const choice = batchChoice(batch, file)
    assert.match(choice.description, /1\) 热成像仪的标定步骤/u)
    assert.match(choice.description, /2\) 声成像仪的信噪比判据/u)
    assert.match(choice.description, /3\) 北美站的合规要求/u)
    assert.match(choice.description, /…共 4 条/u)
  })

  it('已裁决过的批次标注"已裁决"', () => {
    const choice = batchChoice(batch, { ...file, reviewedAt: '2026-10-17T14:00:00' })
    assert.match(choice.label, /已裁决 4 条/u)
  })

  it('0 候选的批次直说"建议重新提炼"', () => {
    const choice = batchChoice(batch, { candidates: [] })
    assert.match(choice.description, /没有候选/u)
    assert.match(choice.description, /重新提炼/u)
  })

  it('标题过长时截断到 24 字（选项描述不能被撑爆）', () => {
    const choice = batchChoice(batch, { candidates: [{ id: 'c1', title: '很'.repeat(60) }] })
    const first = choice.description.split(') ')[1] ?? ''
    assert.ok(first.length <= 25, `首条摘要过长：${first.length}`)
  })

  it('机器注入不占预览，并如实报出"另有 N 条像机器上下文"', () => {
    // 真机：前三名是 `【任务】…`、`Current runtime context.`、`<system-reminder> A skil…`
    // ⇒ 预览整段是噪声，人看不出这一批是什么。预览必须跳过注入，并说出有多少条。
    const mixed = {
      candidates: [
        { id: 'c0', title: '<system-reminder> A skill is a reusable set…' },
        { id: 'c1', title: '热成像仪的标定步骤' },
        { id: 'c2', title: 'Current runtime context. This snapshot supersedes…' },
        { id: 'c3', title: '声成像仪的信噪比判据' },
      ],
    }
    const choice = batchChoice(batch, mixed)
    assert.match(choice.description, /1\) 热成像仪的标定步骤/u)
    assert.equal(choice.description.includes('<system-reminder>'), false, '注入不许进预览')
    assert.match(choice.description, /另有 2 条像是机器上下文/u)
  })

  it('整批都是机器上下文 ⇒ 直说"建议清理这一批"', () => {
    const junk = {
      candidates: [
        { id: 'c1', title: '<system-reminder> Additional instructions from AGENTS.md' },
        { id: 'c2', title: 'Current runtime context. Current working directory…' },
      ],
    }
    const choice = batchChoice(batch, junk)
    assert.match(choice.description, /整批像是机器上下文/u)
    assert.match(choice.description, /建议清理这一批/u)
  })

  it('内容相同的批次在 label 上点名（不然摘要一模一样，人无从区分）', () => {
    const choice = batchChoice(batch, file, { duplicateOf: '004' })
    assert.match(choice.label, /与 004 内容相同/u)
    // 没有重复时不许冒出这句话
    assert.equal(batchChoice(batch, file).label.includes('内容相同'), false)
  })

  it('已裁决的批次要给出结果（保留几 / 排除几），否则"已裁决"不回答"还要不要处理"', () => {
    const reviewedFile = {
      ...file,
      reviewedAt: '2026-10-17T14:00:00',
      candidates: [
        { id: 'c1', title: '甲', decision: 'keep' },
        { id: 'c2', title: '乙', decision: 'exclude' },
        { id: 'c3', title: '丙', decision: 'exclude' },
      ],
    }
    const choice = batchChoice(batch, reviewedFile)
    assert.match(choice.label, /已裁决 3 条/u)
    assert.match(choice.label, /保留 1 \/ 排除 2/u)
  })
})
