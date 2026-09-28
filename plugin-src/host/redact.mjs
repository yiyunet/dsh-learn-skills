/**
 * redact.mjs —— 脱敏（纯函数）。
 *
 * 体检报告、基线快照、日志三处都必须先过这里。设计取向：
 *   **宁可多打码，不可漏一条**。打码会损失可读性，泄漏不会 —— 代价不对等。
 *
 * 只做"模式识别 + 替换"，不做语义判断：语义判断需要读懂内容，而读懂内容正是
 * 本插件要被禁止对被检查文件做的事。
 *
 * @module dsh-learn-skills/redact
 */

/** 打码占位符。固定的，便于报告读者一眼认出"这里原本有秘密"。 */
export const MASK = '«已脱敏»'

/** 敏感值模式。每条都对应一类真实泄漏形态。 */
const VALUE_PATTERNS = [
  // PEM 私钥 / 证书：整块打掉（**含正文**——只打头尾会留下密钥材料本身，
  // 那等于什么都没做）。用 `[\s\S]*?` 非贪婪匹配到结束标记。
  { name: 'pem', pattern: /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/gu },
  // URL 里的 userinfo（http://user:pass@host）
  { name: 'url-userinfo', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/giu, replace: (_m, scheme) => `${scheme}${MASK}@` },
  // 常见凭证键值对：key: value / key=value / "key": "value"
  {
    name: 'credential-pair',
    pattern: /(["']?)((?:api[_-]?key|apikey|secret|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|pwd|credential|private[_-]?key|app[_-]?secret|cookie|session[_-]?id|signature|salt|token)(?:["']?))\s*[:=]\s*(["']?)([^\s"',;]{4,})\3/giu,
    replace: (_m, quote1, key, quote2) => `${quote1}${key}${quote1}: ${quote2}${MASK}${quote2}`,
  },
  // Bearer / Basic 认证头
  { name: 'auth-header', pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{12,}=*/gu, replace: (_m, scheme) => `${scheme} ${MASK}` },
  // 常见厂商令牌形态：sk-xxx / ghp_xxx / npm_xxx / xoxb-xxx / AKIAxxx
  { name: 'vendor-token', pattern: /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/gu },
  // JWT（三段点分 base64url）
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu },
  // 中国大陆手机号（体检报告不该带个人信息）
  { name: 'phone-cn', pattern: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu },
  // 邮箱
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu },
]

/** 本机绝对路径模式：把用户名从路径里抹掉，保留结构（报告要能读懂）。 */
const ABSOLUTE_PATH_PATTERNS = [
  { name: 'win-home', pattern: /([A-Za-z]:\\+Users\\+)([^\\/\s"']+)/gu, replace: (_m, prefix) => `${prefix}${MASK}` },
  { name: 'win-home-fwd', pattern: /([A-Za-z]:\/+Users\/+)([^/\s"']+)/gu, replace: (_m, prefix) => `${prefix}${MASK}` },
  { name: 'posix-home', pattern: /(\/(?:home|Users)\/)([^/\s"']+)/gu, replace: (_m, prefix) => `${prefix}${MASK}` },
]

/**
 * 脱敏一段文本。
 * @param {string} text 原文
 * @param {{ absolutePaths?: boolean, maxBytes?: number }} [options] 选项
 * @returns {{ text: string, hits: { rule: string, count: number }[] }} 脱敏结果与命中统计
 */
export function redact(text, options = {}) {
  const source = String(text ?? '')
  const cap = options.maxBytes ?? 200000
  const truncated = source.length > cap
  let output = truncated ? `${source.slice(0, cap)}\n«内容超长已截断，原文 ${source.length} 字符»` : source
  const hits = []
  for (const rule of VALUE_PATTERNS) {
    let count = 0
    output = output.replace(rule.pattern, (...args) => {
      count += 1
      return rule.replace === undefined ? MASK : rule.replace(...args)
    })
    if (count > 0) hits.push({ rule: rule.name, count })
  }
  if (options.absolutePaths !== false) {
    for (const rule of ABSOLUTE_PATH_PATTERNS) {
      let count = 0
      output = output.replace(rule.pattern, (...args) => {
        count += 1
        return rule.replace(...args)
      })
      if (count > 0) hits.push({ rule: rule.name, count })
    }
  }
  return { text: output, hits }
}

/**
 * 递归脱敏一个 JSON-ish 结构（快照/日志用）。
 * @param {unknown} value 任意值
 * @param {{ depth?: number }} [options] 选项
 * @returns {unknown} 脱敏后的副本
 */
export function redactValue(value, options = {}) {
  const depth = options.depth ?? 0
  if (depth > 12) return MASK
  if (typeof value === 'string') return redact(value, { absolutePaths: false }).text
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => redactValue(item, { depth: depth + 1 }))
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (/^(api[_-]?key|secret|token|password|credential|cookie|authorization)$/iu.test(key)) {
      out[key] = MASK
      continue
    }
    out[key] = redactValue(item, { depth: depth + 1 })
  }
  return out
}

/** 报告里的固定声明：把"脱敏过"这件事写在纸面上，而不是让读者猜。 */
export const REDACTION_NOTICE = `本报告在生成时已对以下模式做脱敏处理：私钥块、凭证键值对、授权头、常见厂商令牌、JWT、邮箱、手机号${'、'}本机绝对路径中的用户名段。`
