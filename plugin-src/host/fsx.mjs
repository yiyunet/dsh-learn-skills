/**
 * fsx.mjs —— 可恢复的文件写入层。
 *
 * 本插件对用户文件只做四件事：**新增**、**更新（内容变了才算）**、**跳过**、**冲突**。
 * 没有第五种。任何"静默覆盖"都不在这里发生 —— {@link writeIfChanged} 会先读、先比，
 * 目标已存在且我们的基线对不上时，它返回 `conflict` 而不是写。
 *
 * 三个真实失败模式决定了本模块的形状（都不是假想）：
 *   ① 写到一半失败留下半截文件 → 一律写临时文件再 rename（同目录，保证同卷）；
 *   ② 两处并发写同一个文件 → 变更批次级文件锁 + 内容级 CAS；
 *   ③ 写入后进程死掉，用户不知道改到哪一步 → 变更日志先落盘、再动目标文件。
 *
 * @module dsh-learn-skills/fsx
 */

import { constants } from 'node:fs'
import {
  access, mkdir, open, readFile, rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

import { fingerprint, isoTimestamp } from './paths.mjs'

/** @returns {Promise<boolean>} 路径是否存在 */
export async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** @returns {Promise<boolean>} 路径是否是目录 */
export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** @returns {Promise<boolean>} 路径是否是普通文件 */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * 目录项（`withFileTypes` 的轻量投影；不存在返回 `[]`）。
 * @param {string} path 目录
 * @returns {Promise<{ name: string, directory: boolean, size: number, mtimeMs: number }[]>}
 */
export async function readDirectory(path) {
  try {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(path, { withFileTypes: true })
    const out = []
    for (const entry of entries) {
      const child = `${path}/${entry.name}`
      let size = 0
      let mtimeMs = 0
      if (entry.isFile()) {
        const info = await stat(child).catch(() => undefined)
        size = info?.size ?? 0
        mtimeMs = info?.mtimeMs ?? 0
      }
      out.push({ name: entry.name, directory: entry.isDirectory(), size, mtimeMs })
    }
    return out
  } catch {
    return []
  }
}

/** 读文本；不存在或读不动都返回 `undefined`（调用方据 undefined 判"缺失"）。 */
export async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 读 JSON；缺失或语法错返回 `undefined`。 */
export async function readJson(path) {
  const text = await readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

/**
 * 抗瞬时文件锁的重试（Windows：杀软 / 索引器 / 宿主文件监听会短暂持有句柄）。
 * POSIX 下重命名已被打开的目录是允许的，故 Linux CI 不会触发。
 * @template T
 * @param {() => Promise<T>} operation 操作
 * @param {string} what 失败时的说明（写"做什么"）
 * @param {{ attempts?: number, baseDelayMs?: number }} [options]
 * @returns {Promise<T>} 操作结果
 */
export async function withTransientRetry(operation, what, options = {}) {
  const attempts = options.attempts ?? 5
  const baseDelayMs = options.baseDelayMs ?? 150
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!TRANSIENT.has(error?.code)) throw error
      if (attempt >= attempts) {
        throw new Error(
          `${what} 失败：连续 ${attempts} 次遇到瞬时文件锁（${error.code}）。`
          + '常见原因：杀毒软件实时扫描 / 索引器 / 其它进程正持有该文件句柄。'
          + `原始错误：${error.message}`,
        )
      }
      await new Promise(resolve => { setTimeout(resolve, baseDelayMs * attempt) })
    }
  }
}

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖。
 *
 * 为什么临时文件必须同目录：跨卷 rename 会退化成"复制+删除"，就不再是原子的。
 * @param {string} path 目标绝对路径
 * @param {string} content 内容
 * @returns {Promise<{ bytes: number, sha: string }>} 落盘字节数与内容指纹
 */
export async function writeFileAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  const bytes = Buffer.byteLength(content, 'utf8')
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await withTransientRetry(() => rename(temporary, path), `写入 ${path}`)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  // 回读自证：不凭"没报错"下结论。
  const written = await readText(path)
  if (written === undefined) throw new Error(`写入后回读失败：${path}`)
  if (Buffer.byteLength(written, 'utf8') !== bytes) {
    throw new Error(`写入后字节数不符：${path}（期望 ${bytes}，实得 ${Buffer.byteLength(written, 'utf8')}）`)
  }
  return { bytes, sha: fingerprint(written) }
}

/**
 * 一次写入的裁决。`action` 三值即本插件全部写语义。
 * @typedef {{ action: 'create' | 'update' | 'skip' | 'conflict', path: string, relative: string,
 *   reason: string, beforeSha?: string, afterSha?: string, bytes?: number, content?: string }} WriteDecision
 */

/**
 * 决定"该不该写"，并在允许时写。
 *
 * 三种输入组合的语义：
 *   目标不存在                        → `create`
 *   目标存在 && 内容完全相同           → `skip`（"内容实际变化才递增版本"就落在这里）
 *   目标存在 && 内容不同 && 给出基线   → 基线对得上 → `update`；对不上 → `conflict`（别人改过）
 *   目标存在 && 内容不同 && 无基线     → `conflict`（我方无授权静默覆盖用户内容）
 *
 * @param {object} options
 * @param {string} options.absolute 目标绝对路径
 * @param {string} options.relative 工作区相对路径（报告里用它，不暴露本机绝对路径）
 * @param {string} options.content 拟写内容
 * @param {string|null} [options.baselineSha] 我方已知的目标内容指纹；null 表示"我方认为不存在过"
 * @param {boolean} [options.dryRun] 只裁决不落盘
 * @param {boolean} [options.overwrite] 显式授权覆盖不存在基线的既有文件
 * @returns {Promise<WriteDecision>} 裁决
 */
export async function writeIfChanged(options) {
  const {
    absolute, relative, content, baselineSha = undefined, dryRun = false, overwrite = false,
  } = options
  const current = await readText(absolute)
  const currentSha = current === undefined ? undefined : fingerprint(current)
  const nextSha = fingerprint(content)

  if (current === undefined) {
    if (dryRun) {
      return { action: 'create', path: absolute, relative, reason: '目标不存在，将新建', afterSha: nextSha }
    }
    const written = await writeFileAtomic(absolute, content)
    return {
      action: 'create', path: absolute, relative, reason: '目标不存在，已新建',
      afterSha: written.sha, bytes: written.bytes,
    }
  }

  if (currentSha === nextSha) {
    return {
      action: 'skip', path: absolute, relative, reason: '内容完全相同，不写（版本不递增）',
      beforeSha: currentSha, afterSha: nextSha,
    }
  }

  if (baselineSha !== undefined && baselineSha !== null && baselineSha === currentSha) {
    if (dryRun) {
      return {
        action: 'update', path: absolute, relative, reason: '基线一致，将更新',
        beforeSha: currentSha, afterSha: nextSha,
      }
    }
    const written = await writeFileAtomic(absolute, content)
    return {
      action: 'update', path: absolute, relative, reason: '基线一致，已更新',
      beforeSha: currentSha, afterSha: written.sha, bytes: written.bytes,
    }
  }

  if (overwrite === true) {
    if (dryRun) {
      return {
        action: 'update', path: absolute, relative, reason: '已获显式覆盖授权，将更新',
        beforeSha: currentSha, afterSha: nextSha,
      }
    }
    const written = await writeFileAtomic(absolute, content)
    return {
      action: 'update', path: absolute, relative, reason: '已获显式覆盖授权，已更新',
      beforeSha: currentSha, afterSha: written.sha, bytes: written.bytes,
    }
  }

  return {
    action: 'conflict', path: absolute, relative,
    reason: baselineSha === undefined || baselineSha === null
      ? '目标已存在且我方无基线记录，拒绝覆盖（需人显式确认）'
      : '目标内容与我方基线不一致，期间被其它会话或工具改过，拒绝覆盖',
    beforeSha: currentSha, afterSha: nextSha,
  }
}

/**
 * 文件锁：`<dir>/<name>.lock`，`wx` 创建失败即视为已持有。
 *
 * 语义是"超时等待 + 超时后如实报错"，不是无限阻塞 —— 卡死的锁比没有锁更坏。
 * @param {string} lockPath 锁文件路径
 * @param {() => Promise<T>} body 临界区
 * @param {{ timeoutMs?: number, pollMs?: number, staleMs?: number }} [options]
 * @template T
 * @returns {Promise<T>} 临界区结果
 */
export async function withLock(lockPath, body, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const pollMs = options.pollMs ?? 60
  const staleMs = options.staleMs ?? 120000
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let handle
  for (;;) {
    try {
      handle = await open(lockPath, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = await stat(lockPath).catch(() => undefined)
      if (info !== undefined && Date.now() - info.mtimeMs > staleMs) {
        // 陈旧锁：持有者已经不可能还在写（进程死了）。清掉并立刻重试一次。
        await unlink(lockPath).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`等待文件锁超时（${timeoutMs}ms）：${lockPath}。另一个学习流程可能正在运行。`)
      }
      await new Promise(resolve => { setTimeout(resolve, pollMs) })
    }
  }
  try {
    await handle.writeFile(String(process.pid), 'utf8')
    return await body()
  } finally {
    await handle.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
  }
}

/**
 * 变更批次日志（journal）—— 回滚与"部分失败如实汇报"的唯一依据。
 *
 * 顺序是刻意设计的：**先写 journal，再写目标文件**。反过来会留下
 * "文件改了、日志没有"的窗口，那时回滚能力已经丢了。
 */
export class ChangeJournal {
  /** @param {string} path journal 文件绝对路径 */
  constructor(path) {
    this.path = path
    /** @type {{ relative: string, path: string, action: string, beforeSha: string|null, beforeText: string|null, afterSha: string|null }[]} */
    this.entries = []
    this.batchId = undefined
    this.intent = undefined
    this.workspace = undefined
    this.abortReason = undefined
  }

  /**
   * 开批：写盘建日志。
   * @param {string} batchId 批次 id（稳定锚点）
   * @param {{ intent: string, workspace: string }} meta 批次元信息
   * @returns {Promise<void>} 完成
   */
  async begin(batchId, meta) {
    this.batchId = batchId
    this.intent = meta.intent
    this.workspace = meta.workspace
    this.entries = []
    await writeFileAtomic(this.path, `${JSON.stringify({
      version: 1,
      batchId,
      intent: meta.intent,
      workspace: meta.workspace,
      startedAt: isoTimestamp(),
      status: 'open',
      entries: [],
    }, null, 2)}\n`)
  }

  /**
   * 记录一条待写项（在真正写目标文件之前调用）。
   * @param {{ relative: string, path: string, action: string, beforeText: string|null }} entry 条目
   * @returns {Promise<void>} 完成
   */
  async plan(entry) {
    this.entries.push({
      relative: entry.relative,
      path: entry.path,
      action: entry.action,
      beforeSha: entry.beforeText === null ? null : fingerprint(entry.beforeText),
      beforeText: entry.beforeText,
      afterSha: null,
    })
    await this.#flush('open')
  }

  /** 写入成功后落定该项的实际结果指纹。 */
  async settle(relative, afterSha) {
    const entry = this.entries.find(item => item.relative === relative)
    if (entry !== undefined) entry.afterSha = afterSha
    await this.#flush('open')
  }

  /** 批次结束（成功）。 */
  async complete() {
    await this.#flush('done')
  }

  /** 批次因失败/取消而中断，如实标注。 */
  async abort(reason) {
    this.abortReason = reason
    await this.#flush('aborted')
  }

  async #flush(status) {
    await writeFileAtomic(this.path, `${JSON.stringify({
      version: 1,
      batchId: this.batchId,
      intent: this.intent,
      workspace: this.workspace,
      status,
      ...this.abortReason === undefined ? {} : { abortReason: this.abortReason },
      entries: this.entries,
    }, null, 2)}\n`).catch(() => {})
  }

  /**
   * 回滚本批次：新建的删掉、更新的还原。
   *
   * ★ 只还原"当前内容仍等于本批次写入结果"的文件。用户在写入之后又改过的文件
   *   **一律不动**，并列入 `skipped` 如实上报 —— 回滚不该变成第二次覆盖。
   * @returns {Promise<{ restored: string[], removed: string[], skipped: { relative: string, reason: string }[] }>} 回滚结果
   */
  async rollback() {
    const restored = []
    const removed = []
    const skipped = []
    for (const entry of [...this.entries].reverse()) {
      const current = await readText(entry.path)
      const currentSha = current === undefined ? undefined : fingerprint(current)
      if (entry.afterSha !== null && currentSha !== entry.afterSha) {
        skipped.push({
          relative: entry.relative,
          reason: currentSha === undefined ? '目标已不存在，跳过' : '写入之后被改动过，不覆盖',
        })
        continue
      }
      if (entry.action === 'create') {
        if (currentSha === undefined) {
          skipped.push({ relative: entry.relative, reason: '目标已不存在，无需删除' })
          continue
        }
        await rm(entry.path, { force: true })
        removed.push(entry.relative)
        continue
      }
      if (entry.beforeText === null) {
        skipped.push({ relative: entry.relative, reason: '无写入前内容可还原' })
        continue
      }
      await writeFileAtomic(entry.path, entry.beforeText)
      restored.push(entry.relative)
    }
    await this.#flush('rolled-back')
    return { restored, removed, skipped }
  }
}

/** 读一个 journal 文件（回滚命令要用；损坏则返回 undefined）。 */
export async function readJournal(path) {
  const raw = await readJson(path)
  if (raw === undefined || typeof raw !== 'object' || raw === null) return undefined
  return raw
}
