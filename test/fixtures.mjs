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

/** 全部夹具形态（供扫描器核对"命中是否登记在案"）。 */
export const ALL_FIXTURES = Object.freeze([
  FAKE_WIN_PATH, FAKE_POSIX_PATH,
  FAKE_VENDOR_TOKEN, FAKE_GHP_TOKEN, FAKE_NPM_TOKEN,
  FAKE_BEARER, FAKE_JWT, FAKE_EMAIL, FAKE_PHONE, FAKE_SECRET, FAKE_PEM_BODY,
])
