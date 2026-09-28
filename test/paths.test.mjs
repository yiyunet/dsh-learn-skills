/**
 * paths.test.mjs —— 路径与稳定 id 的真实行为测试。
 *
 * 这些用例针对的是需求里点名的风险：中文名、重名、非法输入、路径穿越、
 * "显示名与内部 id 分离"。每一条都断言**具体结果**，不是"函数存在"。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  candidateId, dateStamp, fingerprint, nextNodeId, presetIdFromName, PRESET_ID,
  resolveInside, toRelative, validatePresetName,
} from '../plugin-src/host/paths.mjs'

describe('resolveInside —— 路径必须落在工作区根之内', () => {
  it('拼接相对路径', () => {
    assert.equal(resolveInside('D:/ws', 'knowledge/nodes/a.md'), 'D:/ws/knowledge/nodes/a.md')
  })

  it('空相对路径得到根目录本身', () => {
    assert.equal(resolveInside('D:/ws', ''), 'D:/ws')
    assert.equal(resolveInside('D:/ws/', '/'), 'D:/ws')
  })

  it('反斜杠与重复分隔符被归一化', () => {
    assert.equal(resolveInside('D:/ws', 'a\\b//c'), 'D:/ws/a/b/c')
  })

  it('拒绝 .. 穿越', () => {
    assert.throws(() => resolveInside('D:/ws', '../escape'), /路径越界/u)
    assert.throws(() => resolveInside('D:/ws', 'a/../../b'), /路径越界/u)
  })

  it('拒绝相对路径作为工作区根', () => {
    assert.throws(() => resolveInside('relative/path', 'x'), /必须是绝对路径/u)
  })

  it('toRelative 把工作区内的绝对路径还原成相对路径', () => {
    assert.equal(toRelative('D:/ws', 'D:/ws/a/b.md'), 'a/b.md')
    assert.equal(toRelative('D:/ws', 'E:/other/b.md'), 'E:/other/b.md')
  })
})

describe('validatePresetName —— 名字校验只判断，不静默转换', () => {
  it('接受中文名', () => {
    const result = validatePresetName('小书童')
    assert.equal(result.ok, true)
    assert.equal(result.name, '小书童')
  })

  it('接受中英混合与空格', () => {
    assert.equal(validatePresetName('  My 助手  ').ok, true)
  })

  it('拒绝空值与纯空白', () => {
    assert.equal(validatePresetName('').code, 'EMPTY')
    assert.equal(validatePresetName('   ').code, 'EMPTY')
    assert.equal(validatePresetName(undefined).code, 'EMPTY')
  })

  it('拒绝超长名字', () => {
    assert.equal(validatePresetName('x'.repeat(33)).code, 'TOO_LONG')
    assert.equal(validatePresetName('x'.repeat(32)).ok, true)
  })

  it('拒绝路径分隔符与控制字符', () => {
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a|b', 'a"b', 'a<b', 'a>b', `a\u0007b`]) {
      assert.equal(validatePresetName(bad).code, 'ILLEGAL_CHARS', `应拒绝：${JSON.stringify(bad)}`)
    }
  })

  it('拒绝纯点或纯空白', () => {
    assert.equal(validatePresetName('...').code, 'ILLEGAL_CHARS')
  })

  it('重名时要求改名，不静默改名、不覆盖', () => {
    const result = validatePresetName('小书童', { used: ['小书童'] })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DUPLICATE')
    assert.match(result.message, /不会覆盖/gu)
    // 关键：返回的 message 里不带"已改名为 X"之类的替代方案 —— 改名是用户的决定。
    assert.equal(result.name, undefined)
  })

  it('保留名被拒绝', () => {
    assert.equal(validatePresetName('standard').code, 'RESERVED')
    assert.equal(validatePresetName('cordis').code, 'RESERVED')
  })
})

describe('presetIdFromName —— 显示名与内部 id 分离', () => {
  it('英文名得到可读 slug', () => {
    assert.equal(presetIdFromName('My Study Buddy', []), 'my-study-buddy')
  })

  it('中文名退回稳定指纹 id（不用中文拼路径）', () => {
    const id = presetIdFromName('小书童', [])
    assert.ok(PRESET_ID.test(id), `id 必须合法：${id}`)
    assert.ok(/^learn-[0-9a-f]{6}$/u.test(id), `中文名应得到 learn-<指纹>，实得 ${id}`)
    assert.equal(id, presetIdFromName('小书童', []), '同一名字必须得到同一 id（稳定性）')
  })

  it('相同 id 已被占用时追加序号，而不是覆盖', () => {
    const id = presetIdFromName('My Study Buddy', ['my-study-buddy'])
    assert.equal(id, 'my-study-buddy-2')
    assert.equal(presetIdFromName('My Study Buddy', ['my-study-buddy', 'my-study-buddy-2']), 'my-study-buddy-3')
  })

  it('全符号名也能得到合法 id', () => {
    assert.ok(PRESET_ID.test(presetIdFromName('!!!', [])))
  })
})

describe('id 分配', () => {
  it('节点 id 从 LN-<日期>-001 起递增', () => {
    assert.equal(nextNodeId('20260917', []), 'LN-20260917-001')
    assert.equal(nextNodeId('20260917', ['LN-20260917-001']), 'LN-20260917-002')
  })

  it('已分配 id 不回收：归档的号仍占位', () => {
    const used = ['LN-20260917-001', 'LN-20260917-002', 'LN-20260917-005']
    assert.equal(nextNodeId('20260917', used), 'LN-20260917-006')
  })

  it('候选 id 由批次号与序号决定，重跑得到同一组 id', () => {
    assert.equal(candidateId('003', 0), 'C-003-01')
    assert.equal(candidateId('003', 11), 'C-003-12')
  })

  it('日期戳格式稳定', () => {
    assert.equal(dateStamp(new Date(2026, 8, 17)), '20260917')
  })
})

describe('fingerprint —— 变更检测用', () => {
  it('同内容同指纹，异内容异指纹', () => {
    assert.equal(fingerprint('abc'), fingerprint('abc'))
    assert.notEqual(fingerprint('abc'), fingerprint('abd'))
  })

  it('空值是稳定值，不抛错', () => {
    assert.equal(typeof fingerprint(undefined), 'string')
  })
})
