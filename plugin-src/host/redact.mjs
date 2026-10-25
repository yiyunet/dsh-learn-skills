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

/**
 * 敏感值模式。每条都对应一类真实泄漏形态。
 *
 * ★ 2026-10-25 按当前业界凭据形态清单做了一次全面复核（交付 D-20261025-001）：
 *   外部测评指出原表只覆盖 6 类厂商前缀、**无身份证规则**、路径只打家目录形式。
 *   现按 **代码托管 / 云 / AI / 支付与电商 / 通讯 / PII** 分组补齐，取向不变：
 *   **宁可多打码，不可漏一条**。
 *
 * ⚠️ 顺序有讲究：**具体的在前、宽泛的在后**。例如 `sk-ant-` 必须先于通用 `sk-`
 *   （否则被吞掉一半），webhook URL 必须先于 `email`（URL 里可能带 `@`）。
 */
const VALUE_PATTERNS = [
  // PEM 私钥 / 证书：整块打掉（**含正文**——只打头尾会留下密钥材料本身，
  // 那等于什么都没做）。用 `[\s\S]*?` 非贪婪匹配到结束标记。
  { name: 'pem', pattern: /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/gu },
  // URL 里的 userinfo（http://user:pass@host）—— 连接串的主要泄漏点在这里，
  // 所以不需要再单独加一条"数据库连接串"规则（那会导致过度打码）。
  { name: 'url-userinfo', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/giu, replace: (_m, scheme) => `${scheme}${MASK}@` },
  // 通讯平台 webhook：Slack / Discord / 飞书 / 钉钉。这类 URL 本身就是凭据
  // （谁拿到谁就能往群里发消息），必须整条打掉。
  {
    name: 'webhook-url',
    pattern: /https?:\/\/(?:hooks\.slack\.com\/services\/[A-Za-z0-9/]+|(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+|open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+|oapi\.dingtalk\.com\/robot\/send\?access_token=[A-Za-z0-9]+|qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9-]+|[A-Za-z0-9-]+\.webhook\.office\.com\/webhookb2\/[A-Za-z0-9@/_.-]+)/gu,
  },
  // Telegram Bot token：`<8~10 位数字>:<35 位>`，整条打掉
  { name: 'telegram-bot', pattern: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![\w-])/gu },
  // 常见凭证键值对：key: value / key=value / "key": "value"
  // （键名表已扩充 access_key / refresh_token / id_token / app_secret 等真实写法）
  {
    name: 'credential-pair',
    pattern: /(["']?)((?:api[_-]?key|apikey|secret|secret[_-]?key|client[_-]?secret|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|session[_-]?token|password|passwd|pwd|credential|private[_-]?key|app[_-]?secret|app[_-]?key|cookie|session[_-]?id|signature|salt|token)(?:["']?))\s*[:=]\s*(["']?)([^\s"',;]{4,})\3/giu,
    replace: (_m, quote1, key, quote2) => `${quote1}${key}${quote1}: ${quote2}${MASK}${quote2}`,
  },
  // Bearer / Basic 认证头
  { name: 'auth-header', pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{12,}=*/gu, replace: (_m, scheme) => `${scheme} ${MASK}` },
  // ══ 令牌结尾断言：用 `(?![A-Za-z0-9_-])`，不要用 `\b` ══════════════════════
  //
  // `\b` 判断的是"word 字符 ↔ 非 word 字符"的交替。当令牌**以 `-` 或 `_` 结尾**时，
  // 它后面的空格同样是"非 word 字符"，两者之间根本不存在 boundary —— 整条正则匹配失败，
  // 密钥原样漏出。实测就栽在这上面：一条合法的 39 字符 GCP key（`AIza` + 35 位 base64url，
  // 末位恰好是 `-`）在测评样本里完全没被打码。
  //
  // 凡**字母表含 `-`/`_`** 的令牌（GCP base64url、glpat-、sk-、xox-、JWT 三段、github_pat_）
  // 都会中这个招，所以它们的结尾统一用 `(?![A-Za-z0-9_-])`：语义是"令牌到此为止，
  // 后面不能再接令牌字符"，与 word 定义无关，且不比 `\b` 更松（不会新增漏报）。
  //
  // 反过来，**纯字母数字**的定长令牌（AKIA/ASIA/LTAI）保留 `\b` 才对：它们不会以 `-`
  // 结尾，那里的 `-` 是正常分隔符，改成否定前瞻反而会把 `AKIA…-desc` 这种写法漏掉。
  // ── 代码托管 ────────────────────────────────────────────────────────────
  // ghp_/gho_/ghu_/ghs_/ghr_（经典 PAT 与各类 App token）＋ github_pat_（fine-grained）
  { name: 'vendor-github', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})(?![A-Za-z0-9_-])/gu },
  { name: 'vendor-gitlab', pattern: /\bglpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gu },
  // ── 云厂商 ──────────────────────────────────────────────────────────────
  // AWS 长期（AKIA）/ 临时（ASIA）；GCP API key（AIza）；阿里云 AccessKey（LTAI）
  { name: 'vendor-cloud', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])|\bLTAI[A-Za-z0-9]{12,}\b/gu },
  // ── AI 厂商 ─────────────────────────────────────────────────────────────
  // `sk-ant-` 必须在通用 `sk-` **之前**，否则会被后者匹配掉一半
  { name: 'vendor-ai', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])|\bsk-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/gu },
  // ── 支付 / 电商 SaaS ────────────────────────────────────────────────────
  // Stripe（sk_/rk_ × live/test）；Shopify（shpat_/shpca_/shppa_/shpss_）
  { name: 'vendor-payment', pattern: /\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|shp(?:at|ca|pa|ss)_[A-Za-z0-9]{16,})\b/gu },
  // 通讯类：Slack bot/user token 等
  { name: 'vendor-slack', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_-])/gu },
  { name: 'vendor-npm', pattern: /\bnpm_[A-Za-z0-9]{20,}\b/gu },
  // JWT（三段点分 base64url）
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/gu },
  // ── 个人信息（PII）──────────────────────────────────────────────────────
  // 中国大陆身份证号（18 位，末位可为 X）：用"出生日期段合法"收紧，压低误伤
  { name: 'id-card-cn', pattern: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/gu },
  // 银行卡号：**只认人类书写形态**（4 位一组 + 空格/连字符），
  // 避免把任意长数字（版本号、统计值）打成马赛克 —— 那会让报告失去可读性。
  { name: 'bank-card', pattern: /(?<!\d)(?:\d{4}[ -]){3}\d{4}(?:[ -]?\d{1,3})?(?!\d)/gu },
  // 中国大陆手机号（体检报告不该带个人信息）
  { name: 'phone-cn', pattern: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu },
  // 邮箱
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu },
]

/**
 * 绝对路径模式。
 *
 * 取向：**打掉"是谁的"，保留"是什么"**。体检报告的价值在于指出"哪个文件有问题"，
 * 所以**文件名**要留着；而用户名、客户名、项目名属于不该出现在可分享报告里的东西。
 *
 * ★ 顺序是"兜底在前、精确在后"，而且这两层**不是重复劳动**：
 *   · 兜底先跑，把整条路径一次吃干净（避免先用精确规则打用户名、再被兜底打目录，
 *     叠出 `/«已脱敏»/«已脱敏»` 这种看着像 bug 的输出）；
 *   · 精确规则在后当**保险**：万一兜底的复杂正则在某个边角没命中，
 *     用户名那一层仍然会被打掉（例如单级路径兜底不处理）。
 */
const ABSOLUTE_PATH_PATTERNS = [
  // ★★ 第一层：兜底收口 —— `absolutePaths` 为真 ⇒ **任意**绝对路径都要打码。
  //   （外部测评 #1321 的 F3 建议原话："`absolutePaths: true` 时任意绝对路径都打码"）
  //
  //   为什么必须有这一层：只认"家目录"和"几个已知业务根"是不够的 ——
  //   `<盘符>:\Users\<用户>\Proj\<客户名>\a.md` 只会被打掉**用户名**，
  //   `Proj` 与客户名照样留在报告里：打了"是谁的机器"，没打"是谁的项目"。
  //   而路径里泄漏客户名/项目名才是可分享报告真正的风险（测评样本 `/srv/clients/acme/…`）。
  //
  //   代价：报告里不再有目录结构。这是刻意的取舍，不是遗漏（文件名仍在，
  //   读者知道该去查哪个文件，只是不知道它在这台机器的哪一层目录下）。
  {
    name: 'abs-posix-any',
    // `(?<![\w:/])` 挡掉 URL：`https://x/a/b` 里第一个 `/` 前是 `:`、第二个前是 `/`，
    // 而 `/a/b` 里 `/` 前是字母 —— 都不成立 ⇒ URL 不会被当成路径打码。
    // `(?:…\/)+` 要求**至少两级**：单层的 `/div`、`/learn rollback` 不会命中，
    // 免得误伤 HTML 片段与命令写法。`/etc/passwd` 这类单级路径因此**不**打码 ——
    // 它不含用户名/客户名，泄漏价值低于"把命令文本打成马赛克"的代价。
    pattern: /(?<![\w:/])\/(?:[^\s"'<>|*?\n\\/:]+\/)+([^\s"'<>|*?\n\\/:]+)/gu,
    replace: (_m, base) => `/${MASK}/${base}`,
  },
  {
    name: 'abs-win-any',
    // `(?<!\w)` 只允许盘符出现在行首或分隔符之后：`http:` 里的 `p:`、`node:fs` 里的 `s:`
    // 前一个字符是字母 ⇒ 不算盘符。
    pattern: /(?<!\w)([A-Za-z]:[\\/])(?:[^\s"'<>|*?\n\\/:]+[\\/])+([^\s"'<>|*?\n\\/:]+)/gu,
    replace: (_m, root, base) => `${root}${MASK}\\${base}`,
  },
  // ── 第二层：精确规则（兜底漏掉时的保险，正常路径下已被第一层吃掉）────────
  { name: 'win-home', pattern: /([A-Za-z]:\\+Users\\+)([^\\/\s"']+)/gu, replace: (_m, prefix) => `${prefix}${MASK}` },
  { name: 'win-home-fwd', pattern: /([A-Za-z]:\/+Users\/+)([^/\s"']+)/gu, replace: (_m, prefix) => `${prefix}${MASK}` },
  { name: 'posix-home', pattern: /(\/(?:home|Users)\/)([^/\s"']+)/gu, replace: (_m, prefix) => `${prefix}${MASK}` },
  // 非家目录的"业务数据根"下的整条路径链打码（测评样本 `/srv/clients/acme/payroll.xlsx`）。
  // 刻意**不含 `/opt`** —— macOS(Apple Silicon) 的 `/opt/homebrew` 太常见。
  {
    name: 'biz-root',
    pattern: /(\/(?:srv|data|mnt|media|private|var\/lib)\/)(?:[^\s"'/:]+\/?)+/gu,
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
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
    // 键名本身是"这个字段放的是秘密"的强信号 —— 命中就整值替换，不看内容形态。
    if (/^(?:api[_-]?key|apikey|secret|secret[_-]?key|token|access[_-]?token|refresh[_-]?token|access[_-]?key|password|passwd|pwd|credential|cookie|authorization|app[_-]?secret|client[_-]?secret|private[_-]?key)$/iu.test(key)) {
      out[key] = MASK
      continue
    }
    out[key] = redactValue(item, { depth: depth + 1 })
  }
  return out
}

/** 报告里的固定声明：把"脱敏过"这件事写在纸面上，而不是让读者猜。 */
export const REDACTION_NOTICE = '本报告在生成时已对以下模式做脱敏处理：'
  + '私钥/证书块、凭证键值对（含 access/refresh/id token、app secret）、授权头、URL 中的口令、'
  + '通讯平台 webhook（Slack / Discord / 飞书 / 钉钉 / 企业微信 / Teams）与 Telegram Bot token、'
  + '代码托管令牌（GitHub ghp_/gho_/ghu_/ghs_/ghr_/github_pat_、GitLab glpat-）、'
  + '云厂商密钥（AWS AKIA/ASIA、GCP AIza、阿里云 LTAI）、AI 厂商密钥（sk-、sk-ant-）、'
  + '支付与电商令牌（Stripe、Shopify）、Slack token、npm token、JWT、'
  + '身份证号、银行卡号、手机号、邮箱，以及绝对路径的目录链（**文件名保留**，便于定位文件）。'
