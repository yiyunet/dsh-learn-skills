/**
 * paths.mjs —— 工作区布局、路径校验、稳定 ID 生成（纯函数，无 I/O）。
 *
 * 全部为纯函数，因为这里承载了本插件最容易出错、也最需要被测试的三件事：
 *   ① 用户输入（预设名字）**绝不**直接拼进路径 —— 显示名与内部 id 分离；
 *   ② 所有落盘路径必须落在工作区根之内（穿越防护）；
 *   ③ 知识节点的 id 一经分配不再复用。
 *
 * @module dsh-learn-skills/paths
 */

import { sep } from 'node:path'

/** 预设 id 的合法形状（与 DSH agent-presets 的 PRESET_ID 同规则：这将成为目录名）。 */
export const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u

/** 预设 id 长度上限（目录名 + 展示用）。 */
export const PRESET_ID_MAX = 48

/** 节点 id 的形状：LN-<date>-<seq>，稳定且可读。 */
export const NODE_ID = /^LN-(\d{8})-(\d{3})$/u

/** 候选 id 的形状：C-<batch>-<seq>。 */
export const CANDIDATE_ID = /^C-(\d{8})-(\d{3})-(\d{2})$/u

/** 系统保留名：不给用户占用，避免与本插件自身生成的目录/文件撞名。 */
export const RESERVED_PRESET_IDS = new Set([
  'standard', 'minimal', 'ptc', 'cordis', 'code', 'custom', 'default',
])

/** 文件名里禁止出现的字符（含 Windows 保留字符与不可见字符）。 */
const ILLEGAL_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f]/u

/** 路径分隔符归一化：把两种分隔符都当成 `/` 之后再判段。 */
export function normalizeSlashes(path) {
  return String(path).replace(/\\/gu, '/').replace(/\/+/gu, '/')
}

/**
 * 工作区相对路径 → 绝对路径，并保证结果落在工作区根**之内**。
 *
 * 这是本插件唯一允许拼路径的入口：任何写操作都必须先经过它。
 * @param {string} workspaceRoot 工作区根（绝对路径）
 * @param {string} relative 相对路径（`/` 分隔，允许空串表示根本身）
 * @returns {string} 绝对路径
 * @throws {Error} 相对路径越界（`..`）或工作区根不是绝对路径时
 */
export function resolveInside(workspaceRoot, relative = '') {
  const root = normalizeSlashes(workspaceRoot)
  if (!/^([a-zA-Z]:\/|\/)/u.test(root)) {
    throw new Error(`工作区根必须是绝对路径：${workspaceRoot}`)
  }
  const cleanRoot = root.replace(/\/$/u, '')
  const rel = normalizeSlashes(relative).replace(/^\/+/u, '')
  if (rel === '') return cleanRoot
  const segments = []
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw new Error(`路径越界（含 ..）：${relative}`)
    }
    segments.push(segment)
  }
  return segments.length === 0 ? cleanRoot : `${cleanRoot}/${segments.join('/')}`
}

/**
 * 判断两个绝对路径是否指向同一处（大小写不敏感，为 Windows 准备）。
 * @param {string} left 绝对路径
 * @param {string} right 绝对路径
 * @returns {boolean} 是否同路径
 */
export function samePath(left, right) {
  const a = normalizeSlashes(left).replace(/\/$/u, '').toLowerCase()
  const b = normalizeSlashes(right).replace(/\/$/u, '').toLowerCase()
  return a === b
}

/** 工作区相对路径（写进报告用，避免把本机绝对路径带出去）。 */
export function toRelative(workspaceRoot, absolute) {
  const root = normalizeSlashes(workspaceRoot).replace(/\/$/u, '')
  const target = normalizeSlashes(absolute)
  if (!target.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return target
  return target.slice(root.length + 1)
}

/** 当前自然日（本地时区）`YYYYMMDD`。 */
export function dateStamp(now = new Date()) {
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/** 当前自然日 `YYYY-MM-DD`。 */
export function isoDate(now = new Date()) {
  const stamp = dateStamp(now)
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
}

/** ISO 时间戳（秒精度足够，避免无意义的抖动）。 */
export function isoTimestamp(now = new Date()) {
  return `${isoDate(now)}T${now.toTimeString().slice(0, 8)}`
}

/**
 * 知识节点 id 分配器（无状态：由调用方给出已用集合）。
 * 已用集合一旦分配即不得回收 —— 归档的节点仍占号。
 * @param {string} date `YYYYMMDD`
 * @param {Iterable<string>} used 已占用的节点 id
 * @returns {string} 下一个 `LN-<date>-<seq>`
 */
export function nextNodeId(date, used) {
  let max = 0
  for (const id of used) {
    const match = NODE_ID.exec(String(id))
    if (match === null) continue
    max = Math.max(max, Number(match[2]))
  }
  return `LN-${date}-${String(max + 1).padStart(3, '0')}`
}

/** 本批次的候选 id。批次号是稳定锚点：同一批重跑得到同一组 id。 */
export function candidateId(batchId, index) {
  return `C-${batchId}-${String(index + 1).padStart(2, '0')}`
}

/**
 * 内容指纹（FNV-1a 32 位，十六进制）。用于：
 *   · 判断"内容实际变化才递增版本"；
 *   · 识别重复处理的同一段消息。
 * 不是密码学哈希 —— 用途只是变更检测，碰撞概率在本地规模下可忽略。
 * @param {string} text 内容
 * @returns {string} 8 位十六进制指纹
 */
export function fingerprint(text) {
  let hash = 0x811c9dc5
  const source = String(text ?? '')
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 预设显示名校验。**只校验，不转换** —— 静默改名会让用户以为已经创建成功。
 * @param {string} raw 用户输入的名字
 * @param {{ used?: Iterable<string>, reserved?: Iterable<string> }} [options]
 * @returns {{ ok: true, name: string } | { ok: false, code: string, message: string }}
 */
export function validatePresetName(raw, options = {}) {
  const name = String(raw ?? '').trim()
  if (name === '') {
    return { ok: false, code: 'EMPTY', message: '名字不能为空。' }
  }
  if (name.length > 32) {
    return { ok: false, code: 'TOO_LONG', message: `名字最长 32 个字符（当前 ${name.length}）。` }
  }
  // 控制字符与路径分隔符一律拒绝：显示名不进路径，但也不该让用户以为它可以
  // 拿去做目录名 —— 提前说清楚比事后猜安全。
  if (ILLEGAL_NAME.test(name)) {
    return {
      ok: false,
      code: 'ILLEGAL_CHARS',
      message: '名字里不能出现 < > : " / \\ | ? * 或不可见字符。',
    }
  }
  if (/^[.\s]+$/u.test(name)) {
    return { ok: false, code: 'ILLEGAL_CHARS', message: '名字不能只由点或空白组成。' }
  }
  const used = new Set([...options.used ?? []].map(item => String(item)))
  const reserved = new Set([...options.reserved ?? RESERVED_PRESET_IDS].map(item => String(item)))
  if (used.has(name)) {
    return {
      ok: false,
      code: 'DUPLICATE',
      message: `已有同名预设「${name}」。请换一个名字 —— 本插件不会覆盖也不会替你改名。`,
    }
  }
  if (reserved.has(name)) {
    return {
      ok: false,
      code: 'RESERVED',
      message: `「${name}」是宿主内置名，换个名字以免与内置预设混淆。`,
    }
  }
  return { ok: true, name }
}

/**
 * 显示名 → 内部稳定 id（目录名与 preset id 都用它）。
 *
 * 中文名会得到空的 slug（CJK 无 ASCII 字母数字），此时退回 `learn-<指纹>`，
 * 既稳定又与用户输入脱钩 —— 这正是"显示名与内部 id 分离"的落点。
 * @param {string} name 已通过 {@link validatePresetName} 的显示名
 * @param {Iterable<string>} usedIds 已占用的 id
 * @returns {string} 合法且唯一的预设 id
 */
export function presetIdFromName(name, usedIds = []) {
  const used = new Set([...usedIds].map(item => String(item)))
  const ascii = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, PRESET_ID_MAX)
  const base = PRESET_ID.test(ascii) ? ascii : `learn-${fingerprint(name).slice(0, 6)}`
  if (!used.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  throw new Error(`无法为「${name}」分配预设 id：候选耗尽`)
}

/** 把值规整为字符串数组（容忍 undefined / 单值）。 */
export function asArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value.map(item => String(item)) : [String(value)]
}

/** 相对路径的目录部分（`/` 分隔；无目录时返回空串）。 */
export function dirOf(relativePath) {
  const normalized = normalizeSlashes(relativePath)
  const index = normalized.lastIndexOf('/')
  return index === -1 ? '' : normalized.slice(0, index)
}

/** 相对路径的文件名部分。 */
export function baseOf(relativePath) {
  const normalized = normalizeSlashes(relativePath)
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

/** 本机路径展示用（报告里只带工作区相对路径；绝对路径仅在诊断字段出现）。 */
export function displayPath(absolute) {
  return normalizeSlashes(absolute).split(sep === '\\' ? '\\' : '/').join('/')
}
