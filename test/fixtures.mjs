/**
 * fixtures.mjs —— 测试用的**虚构**敏感数据（假令牌、假路径）。
 *
 * 为什么单独成模块、且用片段拼装：
 *
 *   本仓在发布前会跑一轮泄漏扫描（`npm run verify` 的 ⑦ 组），它扫的是"源码里
 *   有没有真实凭证形态"。而测试的**职责**恰恰是构造这些形态 —— 于是扫描器会举报
 *   测试自己。这正是实测踩到的假阳性：它把"检查通过"变成"检查永远红"，
 *   而永远红的检查等于没有检查。
 *
 *   两条错法都不行：
 *     · 把 test/ 从扫描面里排除 → 真实凭证藏在测试里就永远发现不了；
 *     · 写一张白名单常量表 → 白名单自己又成了新的字面量，而且必然漏（实测漏了两条）。
 *
 *   所以改成：**夹具在运行时拼出来**，源码里不存在完整形态的串；
 *   扫描器照常扫 test/，一旦命中"不是本模块拼出来的"形态，那就是真的该查。
 *
 * @module dsh-learn-skills/test-fixtures
 */

/** 虚构用户名（刻意用一看就是占位符的词）。 */
export const FAKE_USER = ['some', 'one'].join('')
export const FAKE_POSIX_USER = ['ot', 'her'].join('')

/** 虚构 Windows 绝对路径（含用户名段）。 */
export const FAKE_WIN_PATH = ['C:', 'Users', FAKE_USER, 'Documents', 'x'].join('\\')

/** 虚构 POSIX 绝对路径（含用户名段）。 */
export const FAKE_POSIX_PATH = ['', 'home', FAKE_POSIX_USER, 'y'].join('/')

/** 虚构厂商令牌三种形态。 */
export const FAKE_VENDOR_TOKEN = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-')
export const FAKE_GHP_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxzy'].join('_')
export const FAKE_NPM_TOKEN = ['npm', 'abcdefghijklmnopqrstuvwxzy'].join('_')

/** 虚构授权头载荷。 */
export const FAKE_BEARER = 'abcdefghijklmnopqrst'

/** 虚构 JWT（三段点分，形状正确但全是虚构内容）。 */
export const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'abcdefghijklmnop'].join('.')

/** 虚构邮箱与手机号。 */
export const FAKE_EMAIL = ['someone', 'example.com'].join('@')
export const FAKE_PHONE = '13800138000'

/** 虚构密钥值。 */
export const FAKE_SECRET = ['super', 'secret', 'value'].join('-')

/** 虚构 PEM 私钥正文段。 */
export const FAKE_PEM_BODY = 'MIIEowIBAAKCAQEA'

// ── 2026-10-25 补：外部测评 #1321（F3）指出的漏项，各给一个靶子 ──────────────
// 仍然**运行时拼装**：源码里不出现完整形态，泄漏扫描才不会举报测试自己。

/**
 * 虚构 GCP API key（`AIza` + 恰好 35 位 —— 正则要求精确长度，多一位就匹配不上）。
 * 刻意让**最后一位是 `-`**：GCP key 用 base64url 字母表，合法值可以以 `-`/`_` 收尾。
 * 这一条曾把正则的尾部 `\b` 打暴（`-` 与空格之间没有 word boundary）—— 留作回归哨兵，
 * 不要为了"让它变绿"而换成以字母结尾的串。
 */
export const FAKE_GCP_KEY = ['AIza', 'AbCdEf0123456789-_AbCdEf0123456789-'.slice(0, 35)].join('')

/**
 * 虚构 GitHub fine-grained PAT（`github_pat_` + 32 位）。
 * 注意 `_pat_` 前缀本身也是拼装的：早先把 `_` 漏掉拼成 `githubpat_`，
 * 断言立刻变红。夹具自己写错的失败不许靠改断言糊过去。
 */
export const FAKE_GITHUB_PAT = ['github', '_pat_', 'AbCdEf0123456789_AbCdEf0123456789_'.slice(0, 32)].join('')

/** 虚构 Slack webhook URL（本身就是凭据：谁拿到谁就能往群里发消息）。 */
export const FAKE_SLACK_WEBHOOK = ['https://hooks.slack.com', 'services', 'T0EXAMPLE', 'B0EXAMPLE', 'XXXXEXAMPLEXXXX'].join('/')

/** 虚构中国大陆身份证号（出生日期段合法，纯虚构）。 */
export const FAKE_ID_CARD = ['110105', '19491231', '002X'].join('')

/** 虚构"非家目录业务路径"（真实测评里原样漏出的形态：带客户名）。 */
export const FAKE_BIZ_PATH = ['', 'srv', 'clients', 'acme', 'payroll.xlsx'].join('/')

/**
 * 虚构 `sk-` 令牌，**末位是 `-`**（理由同 FAKE_GCP_KEY）。
 * 与 FAKE_GCP_KEY 一起看住"令牌尾部边界"这类**跨规则**缺陷：
 * 谁把结尾断言从 `(?![A-Za-z0-9_-])` 改回 `\b`，这两条会同时变红。
 */
export const FAKE_VENDOR_TOKEN_DASH = ['sk-', 'AbCdEf0123456789', 'AbCdEf0123456789', '-'].join('')

/** 全部夹具形态（供扫描器核对"命中是否登记在案"）。 */
export const ALL_FIXTURES = Object.freeze([
  FAKE_WIN_PATH, FAKE_POSIX_PATH,
  FAKE_VENDOR_TOKEN, FAKE_GHP_TOKEN, FAKE_NPM_TOKEN,
  FAKE_BEARER, FAKE_JWT, FAKE_EMAIL, FAKE_PHONE, FAKE_SECRET, FAKE_PEM_BODY,
  FAKE_GCP_KEY, FAKE_GITHUB_PAT, FAKE_SLACK_WEBHOOK, FAKE_ID_CARD, FAKE_BIZ_PATH,
  FAKE_VENDOR_TOKEN_DASH,
])
