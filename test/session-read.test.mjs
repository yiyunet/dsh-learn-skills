/**
 * 会话事件读取的回归闸。
 *
 * 为什么单独立文件：这一层（`sessionInfo()` 里的事件读取）此前**一条测试都没有**，
 * 而它正是「收集提炼」恒 0 候选的病根 —— 0.2.1-rc.1 的 `Session` 没有 `events()`，
 * 只有 `snapshotEvents()`（`packages/core/session/src/index.ts:725`），旧代码于是
 * **永远拿到空数组**，下游再把空数组当成"没有内容"，界面还报「完整历史」。
 *
 * 教训写在闸里：**"读不到"必须与"没有内容"分开**，而分开的前提是这一层被测到。
 * 因此每个"新形状"用例都配一个"老形状"控制组 —— 只证明新名字能用，不证明回退还活着；
 * 回退死了，旧宿主会静默归零，那正是这次踩的坑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSessionEvents, sourceKindOf } from '../plugin-src/host/index.mjs'

/** 造一条 `user/message` 事件（宿主真实形状：data 里是 content 数组 + source 对象）。 */
function userEvent(seq, text, kind = 'user') {
  return { type: 'user/message', seq, data: { content: [{ type: 'text', text }], source: { kind } } }
}

test('rc.1 真身：只有 snapshotEvents() 也要读得到', () => {
  const events = [userEvent(0, '热成像仪怎么标定')]
  const read = readSessionEvents({ snapshotEvents: () => events })
  assert.equal(read.eventsSource, 'snapshotEvents')
  assert.equal(read.events.length, 1)
  assert.equal(read.events[0].seq, 0)
})

test('控制组：只有 events() 的旧形状仍能读到（回退必须是活的）', () => {
  const events = [userEvent(0, '旧宿主上的会话')]
  const read = readSessionEvents({ events: () => events })
  assert.equal(read.eventsSource, 'events')
  assert.equal(read.events.length, 1)
})

test('裸数组形状：events 本身就是数组', () => {
  const read = readSessionEvents({ events: [userEvent(0, 'x')] })
  assert.equal(read.eventsSource, 'events-array')
  assert.equal(read.events.length, 1)
})

test('snapshotEvents 返回不可迭代 ⇒ 继续回落到 events()', () => {
  const read = readSessionEvents({
    snapshotEvents: () => undefined,
    events: () => [userEvent(0, '回落成功')],
  })
  assert.equal(read.eventsSource, 'events')
  assert.equal(read.events.length, 1)
})

test('两种接口都没有 ⇒ none，且不抛', () => {
  assert.deepEqual(readSessionEvents({}), { events: [], eventsSource: 'none' })
  assert.deepEqual(readSessionEvents({ snapshotEvents: 'not-a-function' }), { events: [], eventsSource: 'none' })
})

test('session 缺失（沿用既有防御）⇒ none', () => {
  assert.deepEqual(readSessionEvents(undefined), { events: [], eventsSource: 'none' })
  assert.deepEqual(readSessionEvents(null), { events: [], eventsSource: 'none' })
})

test('返回的是副本：改数组不污染宿主会话', () => {
  const events = [userEvent(0, 'x')]
  const read = readSessionEvents({ snapshotEvents: () => events })
  read.events.push(userEvent(1, 'y'))
  assert.equal(events.length, 1)
})

test('sourceKindOf：对象按 kind 取，**不许**回落成 [object Object]', () => {
  assert.equal(sourceKindOf({ source: { kind: 'agent.inject' } }), 'agent.inject')
  // 系统注入的上下文也是 user/message，kind 各不相同 —— 这正是要按 kind 判的原因。
  assert.equal(sourceKindOf({ source: { kind: 'runtime-context' } }), 'runtime-context')
  // 老形状：source 直接是字符串。
  assert.equal(sourceKindOf({ source: 'user' }), 'user')
  // 关键断言：认不出时给 'unknown'，而不是把对象转成字符串（旧版按对象比较，
  // `=== 'agent.inject'` 永远不成立 ⇒ 自己的提问从未被排除）。
  assert.equal(sourceKindOf({ source: {} }), 'unknown')
  assert.equal(sourceKindOf({}), 'unknown')
  assert.equal(sourceKindOf(undefined), 'unknown')
})
