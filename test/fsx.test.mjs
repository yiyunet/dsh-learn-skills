/**
 * fsx.test.mjs —— 写入层的真实行为测试（**真跑文件系统**，不 mock）。
 *
 * 这一组用例守的是本插件最核心的承诺：
 *   「已有知识、预设、用户文件和技能不得被静默覆盖」。
 * 所以每条断言都落到"磁盘上现在是什么"，而不是"函数返回了什么"。
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  ChangeJournal, readDirectory, readText, withLock, writeFileAtomic, writeIfChanged,
} from '../plugin-src/host/fsx.mjs'
import { fingerprint } from '../plugin-src/host/paths.mjs'

let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'learn-skills-fsx-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('建目录、写文件、回读一致', async () => {
    const target = join(root, 'a/b/c.txt')
    const result = await writeFileAtomic(target, '你好 world')
    assert.equal(await readText(target), '你好 world')
    assert.equal(result.sha, fingerprint('你好 world'))
    assert.equal(result.bytes, Buffer.byteLength('你好 world', 'utf8'))
  })

  it('覆盖写不会留下临时文件', async () => {
    const target = join(root, 'crash.txt')
    await writeFileAtomic(target, 'first')
    await writeFileAtomic(target, 'second')
    assert.equal(await readText(target), 'second')
    const entries = await readDirectory(join(root))
    assert.equal(entries.filter(entry => entry.name.startsWith('crash.txt.tmp-')).length, 0)
  })
})

describe('writeIfChanged —— 本插件全部写语义都在这里', () => {
  it('目标不存在 → create', async () => {
    const target = join(root, 'create.md')
    const decision = await writeIfChanged({ absolute: target, relative: 'create.md', content: 'A' })
    assert.equal(decision.action, 'create')
    assert.equal(await readText(target), 'A')
  })

  it('内容完全相同 → skip，且**不改动文件**', async () => {
    const target = join(root, 'skip.md')
    await writeIfChanged({ absolute: target, relative: 'skip.md', content: 'same' })
    const before = await readFile(target, 'utf8')
    const decision = await writeIfChanged({ absolute: target, relative: 'skip.md', content: 'same' })
    assert.equal(decision.action, 'skip')
    assert.equal(decision.reason, '内容完全相同，不写（版本不递增）')
    assert.equal(await readFile(target, 'utf8'), before)
  })

  it('目标已存在、无基线、内容不同 → conflict（**绝不静默覆盖**）', async () => {
    const target = join(root, 'conflict.md')
    await writeFile(target, '用户自己写的内容', 'utf8')
    const decision = await writeIfChanged({ absolute: target, relative: 'conflict.md', content: '插件想写的内容' })
    assert.equal(decision.action, 'conflict')
    assert.equal(decision.beforeSha, fingerprint('用户自己写的内容'))
    assert.equal(await readFile(target, 'utf8'), '用户自己写的内容', '冲突时文件必须原样不动')
  })

  it('基线对得上 → update', async () => {
    const target = join(root, 'update.md')
    await writeFile(target, 'v1', 'utf8')
    const decision = await writeIfChanged({
      absolute: target, relative: 'update.md', content: 'v2', baselineSha: fingerprint('v1'),
    })
    assert.equal(decision.action, 'update')
    assert.equal(await readFile(target, 'utf8'), 'v2')
  })

  it('基线对不上（别人改过）→ conflict，保留别人的版本', async () => {
    const target = join(root, 'stale.md')
    await writeFile(target, '别人的新内容', 'utf8')
    const decision = await writeIfChanged({
      absolute: target, relative: 'stale.md', content: '我的内容', baselineSha: fingerprint('旧内容'),
    })
    assert.equal(decision.action, 'conflict')
    assert.match(decision.reason, /被其它会话或工具改过/u)
    assert.equal(await readFile(target, 'utf8'), '别人的新内容')
  })

  it('显式覆盖授权时才覆盖', async () => {
    const target = join(root, 'forced.md')
    await writeFile(target, 'old', 'utf8')
    const decision = await writeIfChanged({
      absolute: target, relative: 'forced.md', content: 'new', overwrite: true,
    })
    assert.equal(decision.action, 'update')
    assert.equal(await readFile(target, 'utf8'), 'new')
  })

  it('dryRun 只裁决不落盘', async () => {
    const target = join(root, 'dry.md')
    const decision = await writeIfChanged({ absolute: target, relative: 'dry.md', content: 'x', dryRun: true })
    assert.equal(decision.action, 'create')
    assert.equal(await readText(target), undefined, 'dryRun 不得写盘')
  })
})

describe('withLock —— 并发保护', () => {
  it('被持有时超时并如实报错', async () => {
    const lock = join(root, 'flow.lock')
    await withLock(lock, async () => {
      await assert.rejects(
        () => withLock(lock, async () => 'never', { timeoutMs: 120, pollMs: 20 }),
        /等待文件锁超时/u,
      )
    })
  })

  it('释放之后可再次获取', async () => {
    const lock = join(root, 'flow2.lock')
    assert.equal(await withLock(lock, async () => 'first'), 'first')
    assert.equal(await withLock(lock, async () => 'second'), 'second')
  })

  it('体内抛错也会释放锁', async () => {
    const lock = join(root, 'flow3.lock')
    await assert.rejects(() => withLock(lock, async () => { throw new Error('boom') }), /boom/u)
    assert.equal(await withLock(lock, async () => 'ok'), 'ok')
  })
})

describe('ChangeJournal —— 可回滚的变更批次', () => {
  it('回滚还原更新、删除新建', async () => {
    const journalPath = join(root, 'changes/001.json')
    const updated = join(root, 'j-updated.md')
    const created = join(root, 'j-created.md')
    await writeFile(updated, '原始内容', 'utf8')

    const journal = new ChangeJournal(journalPath)
    await journal.begin('001', { intent: 'upgrade', workspace: root })
    await journal.plan({ relative: 'j-updated.md', path: updated, action: 'update', beforeText: '原始内容' })
    const d1 = await writeIfChanged({ absolute: updated, relative: 'j-updated.md', content: '新内容', baselineSha: fingerprint('原始内容') })
    await journal.settle('j-updated.md', d1.afterSha)
    await journal.plan({ relative: 'j-created.md', path: created, action: 'create', beforeText: null })
    const d2 = await writeIfChanged({ absolute: created, relative: 'j-created.md', content: '新建的' })
    await journal.settle('j-created.md', d2.afterSha)
    await journal.complete()

    const result = await journal.rollback()
    assert.deepEqual(result.restored, ['j-updated.md'])
    assert.deepEqual(result.removed, ['j-created.md'])
    assert.equal(await readFile(updated, 'utf8'), '原始内容')
    assert.equal(await readText(created), undefined)
  })

  it('写入之后被用户改过的文件，回滚**不动它**', async () => {
    const journalPath = join(root, 'changes/002.json')
    const target = join(root, 'j-touched.md')
    await writeFile(target, 'v0', 'utf8')

    const journal = new ChangeJournal(journalPath)
    await journal.begin('002', { intent: 'upgrade', workspace: root })
    await journal.plan({ relative: 'j-touched.md', path: target, action: 'update', beforeText: 'v0' })
    const decision = await writeIfChanged({
      absolute: target, relative: 'j-touched.md', content: 'v1', baselineSha: fingerprint('v0'),
    })
    await journal.settle('j-touched.md', decision.afterSha)
    // 用户在这之后自己改了
    await writeFile(target, '用户后来的修改', 'utf8')

    const result = await journal.rollback()
    assert.equal(result.restored.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.match(result.skipped[0].reason, /被改动过，不覆盖/u)
    assert.equal(await readFile(target, 'utf8'), '用户后来的修改')
  })

  it('journal 先落盘再写目标文件（顺序反了就丢回滚能力）', async () => {
    const journalPath = join(root, 'changes/003.json')
    const journal = new ChangeJournal(journalPath)
    await journal.begin('003', { intent: 'upgrade', workspace: root })
    const raw = JSON.parse(await readFile(journalPath, 'utf8'))
    assert.equal(raw.batchId, '003')
    assert.equal(raw.status, 'open')
    assert.deepEqual(raw.entries, [])
  })
})
