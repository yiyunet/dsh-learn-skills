/**
 * status.mjs —— 插件的持久状态（**只写工作区 `<stateDir>/`，绝不碰宿主配置**）。
 *
 * 四种状态，四种寿命，故意分开存：
 *   session.json  单次流程的断点（可取消、可恢复；同工作区只允许一个在跑）
 *   batches.json  已处理批次账（跨会话续办与"不重复创建候选"的唯一依据）
 *   audit.json    上次成功保存的体检基线（缺失即"首次，无历史基线"）
 *   known.json    已分配过的节点 id、预设占用记录、**我方上次写入的指纹**（id 不回收）
 *
 * @module dsh-learn-skills/status
 */

import { ChangeJournal, readJson, writeFileAtomic } from './fsx.mjs'
import { isoDate, isoTimestamp } from './paths.mjs'

/** 状态版本。结构变了就递增，读到旧版按"未知结构"处理而不是硬套。 */
export const STATE_VERSION = 1

/** 一次流程的生命周期阶段。 */
export const PHASES = Object.freeze({
  collecting: 'collecting',
  awaitingReview: 'awaitingReview',
  approved: 'approved',
  aborted: 'aborted',
  done: 'done',
})

/** 运行中的流程（单工作区同时只允许一个）。 */
export class SessionStore {
  /**
   * @param {{ stateRoot: string, lockRoot: string, workspace: string }} options 路径
   */
  constructor(options) {
    this.stateRoot = options.stateRoot
    this.lockRoot = options.lockRoot
    this.workspace = options.workspace
    this.path = `${options.stateRoot}/session.json`
  }

  /** @returns {Promise<object|undefined>} 当前会话状态 */
  async read() {
    const raw = await readJson(this.path)
    if (raw === undefined || raw?.version !== STATE_VERSION) return undefined
    return raw
  }

  /** @param {object} next 新状态 @returns {Promise<void>} 完成 */
  async write(next) {
    await writeFileAtomic(this.path, `${JSON.stringify({
      version: STATE_VERSION,
      updatedAt: isoTimestamp(),
      ...next,
    }, null, 2)}\n`)
  }

  /** 清空断点（流程结束）。 */
  async clear() {
    await this.write({ phase: PHASES.done, step: null, answers: {}, batchId: null })
  }

  /**
   * 并发闸：已经在跑就**如实拒绝**，不排队 ——
   * 排队的结果是用户以为没生效，于是再点一次，制造两个并发写。
   *
   * ⚠️ 本方法**不持文件锁**。锁只在真正写入的那一小段取（见 `flows.mjs` 的
   * `withLock`）——把锁跨在等人回答的几分钟上，会让"锁超时"变成用户在问答
   * 过程里任何其它操作的报错原因，那是把工具缺陷伪装成人机交互问题。
   * @param {string} flow 流程名（'init' | 'distill' | 'upgrade' | 'audit'）
   * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string, running: object }>} 裁决
   */
  async assertIdle(flow) {
    const current = await this.read()
    if (current !== undefined && current.phase === PHASES.collecting) {
      return {
        ok: false,
        code: 'FLOW_RUNNING',
        message: `已有学习流程正在运行（${current.flow} · ${current.step ?? '进行中'}）。`
          + '请先在界面上取消它，或等它结束再启动新的流程。',
        running: current,
      }
    }
    return { ok: true }
  }

  /**
   * 开一个可恢复的流程（先落盘断点，再开始提问）。
   * @param {string} flow 流程名
   * @param {object} [seed] 初始字段
   * @returns {Promise<{ sessionId: string }>} 会话 id
   */
  async open(flow, seed = {}) {
    const sessionId = `${flow}-${Date.now().toString(36)}`
    await this.write({
      flow,
      sessionId,
      phase: PHASES.collecting,
      step: seed.step ?? null,
      answers: seed.answers ?? {},
      startedAt: isoTimestamp(),
      updatedAt: isoTimestamp(),
    })
    return { sessionId }
  }

  /** 记一步（断点恢复靠它）。 */
  async step(flow, step, answers) {
    const current = await this.read()
    await this.write({
      ...current ?? {},
      flow,
      phase: PHASES.collecting,
      step,
      answers: answers ?? current?.answers ?? {},
    })
  }
}

/** 批次账：已处理的批次与内容指纹账。 */
export class BatchesStore {
  /** @param {{ stateRoot: string }} options 路径 */
  constructor(options) {
    this.path = `${options.stateRoot}/batches.json`
  }

  /** @returns {Promise<{ version: number, batches: object[], seen: Record<string, string> }>} 账本 */
  async read() {
    const raw = await readJson(this.path)
    if (raw === undefined || raw?.version !== STATE_VERSION) {
      return { version: STATE_VERSION, batches: [], seen: {} }
    }
    return {
      version: STATE_VERSION,
      batches: Array.isArray(raw.batches) ? raw.batches : [],
      seen: raw.seen !== null && typeof raw.seen === 'object' ? raw.seen : {},
    }
  }

  /** 开一个新批次，并把它记进账本。 */
  async openBatch(flow, meta = {}) {
    const ledger = await this.read()
    const sequence = ledger.batches.length + 1
    const batchId = `${String(sequence).padStart(3, '0')}`
    const batch = {
      batchId,
      flow,
      createdAt: isoTimestamp(),
      date: isoDate(),
      status: 'open',
      ...meta,
    }
    ledger.batches.push(batch)
    await this.#flush(ledger)
    return batch
  }

  /** 按批次 id 找批次。 */
  async find(batchId) {
    const ledger = await this.read()
    return ledger.batches.find(item => item.batchId === batchId)
  }

  /** 列出未处理完的批次（关联升级要用户明确选批）。 */
  async pending() {
    const ledger = await this.read()
    return ledger.batches.filter(item => item.status !== 'done' && item.status !== 'aborted')
  }

  /** 更新批次。 */
  async update(batchId, patch) {
    const ledger = await this.read()
    const index = ledger.batches.findIndex(item => item.batchId === batchId)
    if (index === -1) return undefined
    ledger.batches[index] = { ...ledger.batches[index], ...patch, updatedAt: isoTimestamp() }
    await this.#flush(ledger)
    return ledger.batches[index]
  }

  /**
   * 标记一批消息指纹为"已处理"。
   *
   * 这是"重复处理相同消息不重复创建候选"的判据：重跑同一段会话时，
   * 每个候选先查这里，命中即标 `alreadyProcessed`，用户看到的是新增项。
   * @param {Record<string, string>} fingerprints 指纹 → 批次 id
   * @returns {Promise<void>} 完成
   */
  async markSeen(fingerprints) {
    const ledger = await this.read()
    for (const [key, value] of Object.entries(fingerprints)) {
      ledger.seen[key] = value
    }
    await this.#flush(ledger)
  }

  async #flush(ledger) {
    await writeFileAtomic(this.path, `${JSON.stringify({
      version: STATE_VERSION, updatedAt: isoTimestamp(), ...ledger,
    }, null, 2)}\n`)
  }
}

/** 体检基线：每次"保存报告与对比基线"成功后才更新。 */
export class BaselineStore {
  /** @param {{ stateRoot: string }} options 路径 */
  constructor(options) {
    this.path = `${options.stateRoot}/audit.json`
  }

  /** @returns {Promise<object|undefined>} 上次基线 */
  async read() {
    const raw = await readJson(this.path)
    if (raw === undefined || raw?.version !== STATE_VERSION) return undefined
    return raw
  }

  /**
   * 更新基线。**只在报告真的写盘成功之后调用** —— 顺序反了会出现
   * "基线说报告存在、磁盘上没有"的假成功。
   * @param {object} baseline 基线（不得含敏感原文）
   * @returns {Promise<void>} 完成
   */
  async save(baseline) {
    await writeFileAtomic(this.path, `${JSON.stringify({
      version: STATE_VERSION, savedAt: isoTimestamp(), ...baseline,
    }, null, 2)}\n`)
  }
}

/**
 * 已分配 id / 预设占用记录 / **写基线**（id 一经分配不回收）。
 *
 * `writeShas`（路径 → 本插件上次写入的指纹）是"拒绝覆盖用户手改"的唯一判据：
 * 这个判断必须跨会话、跨进程成立，所以它不能只活在内存里 —— 上一次升级进程
 * 结束后，只有这份记录还记得"那个文件是我写的、写进去的是什么"。
 */
export class KnownStore {
  /** @param {{ stateRoot: string }} options 路径 */
  constructor(options) {
    this.path = `${options.stateRoot}/known.json`
  }

  /**
   * @returns {Promise<{ nodeIds: string[], presetNames: string[], presetIds: string[], writeShas: Record<string, string> }>} 记录
   */
  async read() {
    const raw = await readJson(this.path)
    return {
      nodeIds: Array.isArray(raw?.nodeIds) ? raw.nodeIds : [],
      presetNames: Array.isArray(raw?.presetNames) ? raw.presetNames : [],
      presetIds: Array.isArray(raw?.presetIds) ? raw.presetIds : [],
      writeShas: readWriteShas(raw?.writeShas),
    }
  }

  /** 追加记录（幂等：已存在不重复追加）。 */
  async add(patch) {
    const current = await this.read()
    const next = {
      nodeIds: [...new Set([...current.nodeIds, ...patch.nodeIds ?? []])],
      presetNames: [...new Set([...current.presetNames, ...patch.presetNames ?? []])],
      presetIds: [...new Set([...current.presetIds, ...patch.presetIds ?? []])],
      // 写基线按**覆盖**合并：同一个文件的最新一次写入才算数（追加式会留下过期指纹）。
      writeShas: { ...current.writeShas, ...readWriteShas(patch.writeShas) },
    }
    await this.#save(next)
    return next
  }

  /**
   * 撤销写基线（当前内容已被合法推翻时必须调用）。
   *
   * 唯一调用点是回滚：回滚把文件还原成"本插件从未写过"的状态，若还留着基线，
   * 下一次升级会拿一个**对不上的**指纹判冲突 —— 文件明明被自己回滚过，插件却
   * 说"被别的东西改过，拒绝覆盖"，用户就再也写不进去了。
   * @param {{ paths: string[] }} patch 要撤销的路径
   * @returns {Promise<void>} 完成
   */
  async forget(patch) {
    const paths = new Set((patch.paths ?? []).map(item => String(item)))
    if (paths.size === 0) return
    const current = await this.read()
    const writeShas = Object.fromEntries(
      Object.entries(current.writeShas).filter(([path]) => !paths.has(path)),
    )
    await this.#save({ ...current, writeShas })
  }

  async #save(next) {
    await writeFileAtomic(this.path, `${JSON.stringify({
      version: STATE_VERSION, updatedAt: isoTimestamp(), ...next,
    }, null, 2)}\n`)
  }
}

/** 只接受 `路径 → 指纹` 的字符串对；其余一律丢弃（状态文件可能被手工编辑过）。 */
function readWriteShas(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, sha]) => typeof sha === 'string' && sha !== ''),
  )
}

/**
 * 变更批次 id 的**字符白名单**。
 *
 * ★ 为什么是字符白名单，而不是精确格式 `^U\d{8}-[0-9a-f]{4}$`
 *   （当前生成逻辑确实是那个形状，见 `flows.mjs` 的 `openBatch` 与
 *   `paths.mjs` 的 `dateStamp()`／`fingerprint()`）：
 *   安全上两者等价 —— 白名单已经挡掉一切路径分隔符（`/`、`\`）与 `..`；
 *   但白名单对**格式演化免疫**：将来把指纹从 4 位改成 6 位、或日期换写法时，
 *   精确正则会**误拒合法批次**（用户的回滚直接失效），白名单不会。
 * @type {RegExp}
 */
export const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 判断一个批次 id 是否可用于拼路径。
 * @param {unknown} value 待判值
 * @returns {boolean} 是否合法
 */
export function isBatchId(value) {
  return typeof value === 'string' && BATCH_ID_PATTERN.test(value)
}

/**
 * 变更日志路径（回滚入口）。
 *
 * ⚠️ **这是一处安全边界**：`batchId` 来自请求（RPC 参数 / 斜杠命令的 args），
 *   属**不可信输入**。早先这里直接 `${stateRoot}/changes/${batchId}.json`，
 *   于是 `batchId=../../x` 能读到工作区外的任意 `.json`，并把它当作变更日志执行
 *   —— 回滚随后按日志里的绝对路径删除／覆盖文件（外部测评 #1321 的 F1，
 *   交付 D-20261025-001）。**校验必须在这里**，因为它是拼路径的唯一入口。
 * @param {string} stateRoot 状态目录（绝对路径）
 * @param {string} batchId 批次 id
 * @returns {string} 日志文件绝对路径
 * @throws {Error} 批次 id 不合白名单时（调用方应转成可读的业务错误，而不是让它冒泡）
 */
export function journalPath(stateRoot, batchId) {
  if (!isBatchId(batchId)) {
    throw new Error(`批次号不合法（只允许字母/数字/下划线/连字符，1-64 位）：${JSON.stringify(batchId)}`)
  }
  return `${stateRoot}/changes/${batchId}.json`
}

/** 造一个已就位的变更日志（读旧日志用于回滚）。 */
export async function openJournal(stateRoot, batchId, meta) {
  const journal = new ChangeJournal(journalPath(stateRoot, batchId))
  if (meta !== undefined) {
    journal.batchId = batchId
    journal.intent = meta.intent
    journal.workspace = meta.workspace
    journal.entries = []
  }
  return journal
}
