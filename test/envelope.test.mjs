/**
 * envelope.test.mjs —— 客户端信封摊平（本轮"点菜单报执行失败"的根因之一）。
 *
 * 为什么单开一份：真机上失败只显示兜底文案「执行失败」，因为**这段逻辑原来是个空壳**
 * —— 宿主失败信封 `{ok:false, error:{code,message}}` 被原样交给界面，而界面读的是
 * `payload.message`（真值在 `error` 里那一层）⇒ 读不到 ⇒ 兜底文案。
 * 成功路径同样错位：真值在 `value` 里，各面板读 `payload.preview` 等字段一律为空。
 *
 * 契约依据（宿主源码，不是猜的）：`packages/client/connection/src/client/rpc.ts:59`
 * 直接 `return full.result` —— 成功 resolve `{ok:true,value}`；**业务失败也 resolve**
 * `{ok:false,error:{code,message,details}}`；只有传输失败/信封非法才 throw。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { unwrapEnvelope } from '../plugin-src/client/envelope.mjs'

describe('unwrapEnvelope —— 失败信封必须摊平（否则界面只会说「执行失败」）', () => {
  it('★ 宿主业务失败：code / message 必须出现在顶层', () => {
    const flat = unwrapEnvelope({
      ok: false,
      error: { code: 'NO_PROVIDER', message: 'no user-questions answerer accepted the request', details: {} },
    })

    assert.equal(flat.ok, false)
    assert.equal(flat.code, 'NO_PROVIDER', 'code 必须提到顶层 —— 界面按 payload.code 判 NO_WORKSPACE 等分支')
    assert.equal(flat.message, 'no user-questions answerer accepted the request')
    assert.equal(flat.message ?? '执行失败', 'no user-questions answerer accepted the request',
      '这条就是真机症状的复现：message 一旦丢了，界面就只剩兜底文案「执行失败」')
    assert.deepEqual(flat.details, {})
  })

  it('失败但 error 缺字段：仍给出可读结果，不抛', () => {
    assert.equal(unwrapEnvelope({ ok: false, error: {} }).code, 'error')
    assert.equal(unwrapEnvelope({ ok: false, error: {} }).message, '未知错误')
    assert.equal(unwrapEnvelope({ ok: false }).message, '未知错误')
  })

  it('details 缺省为空对象（客户端把它当对象用）', () => {
    assert.deepEqual(unwrapEnvelope({ ok: false, error: { code: 'x', message: 'y' } }).details, {})
  })
})

describe('unwrapEnvelope —— 成功信封必须摊平（否则各面板渲染为空）', () => {
  it('★ 对象值就地摊平，且 ok 保留', () => {
    const flat = unwrapEnvelope({ ok: true, value: { stage: 'preview', preview: { summary: ['a'] } } })

    assert.equal(flat.ok, true)
    assert.equal(flat.stage, 'preview', '界面读 result.stage 才能决定进 preview 还是 created')
    assert.deepEqual(flat.preview, { summary: ['a'] })
  })

  it('非对象值保留在 value 里', () => {
    assert.deepEqual(unwrapEnvelope({ ok: true, value: 'hi' }), { ok: true, value: 'hi' })
    assert.deepEqual(unwrapEnvelope({ ok: true, value: [1, 2] }), { ok: true, value: [1, 2] })
  })

  it('value 为 null 时也保留 value 键', () => {
    assert.deepEqual(unwrapEnvelope({ ok: true, value: null }), { ok: true, value: null })
  })
})

describe('unwrapEnvelope —— 异常输入不抛', () => {
  it('空结果给 empty', () => {
    assert.deepEqual(unwrapEnvelope(undefined), { ok: false, code: 'empty', message: '宿主没有返回结果' })
    assert.deepEqual(unwrapEnvelope(null), { ok: false, code: 'empty', message: '宿主没有返回结果' })
  })

  it('不是信封形状时原样返回（不猜）', () => {
    assert.equal(unwrapEnvelope({ foo: 1 }).foo, 1)
  })
})
