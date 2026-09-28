/**
 * envelope.mjs —— 把宿主 RPC 信封摊平成界面好用的形状（**纯函数、零依赖**）。
 *
 * ── 为什么单独成模块 ──────────────────────────────────────────────────────
 * 它是客户端半侧唯一会被"真机行为"证伪的一段逻辑，而 `impl.mjs` 依赖 React、
 * 在 node 里无法直接测。抽出来之后 `test/envelope.test.mjs` 就能把它钉死 ——
 * 这正是本文件诞生前缺失的那道闸：原实现是一个**空壳**（注释说"拆成值/失败两种
 * 结果"，代码却只是 `return result`），于是真机上：
 *   · 失败 ⇒ 界面只显示兜底文案「执行失败」，真实 code/message 全部丢掉；
 *   · 成功 ⇒ 界面各面板读 `payload.preview` 等字段，而真值在 `payload.value` 里，
 *     于是**渲染为空**。
 *
 * ── 契约（宿主源码实证，不是我猜的）────────────────────────────────────────
 * `@deepseek-ai/dsh-client-connection` 的 `createWebConnectionRpc().call()`：
 *   `packages/client/connection/src/client/rpc.ts:59` —— **直接 `return full.result`**。
 * 也就是说：
 *   · 成功     ⇒ **resolve** `{ ok: true, value: <真值> }`
 *   · 业务失败 ⇒ **也 resolve**（不抛）`{ ok: false, error: { code, message, details } }`
 *   · 只有传输失败（`:52`）、rpcId 不匹配（`:56`）、信封非法（`:73-101`）才 `throw`
 * 而界面代码读的是 `payload.message` / `payload.code` / `payload.preview` ——
 * 全都比真值浅一层。本函数就是把这一层摊平。
 *
 * @module dsh-learn-skills/client-envelope
 */

/**
 * 摊平一个 RPC 结果信封。
 * @param {unknown} result `ctx.connection.rpc.call()` 的返回值
 * @returns {{ ok: boolean } & Record<string, unknown>} 摊平后的对象（`ok` 永远保留）
 */
export function unwrapEnvelope(result) {
  if (result === undefined || result === null) {
    return { ok: false, code: 'empty', message: '宿主没有返回结果' }
  }
  if (typeof result !== 'object') {
    return { ok: true, value: result }
  }
  if (result.ok === false) {
    const error = result.error ?? {}
    return {
      ok: false,
      code: error.code ?? result.code ?? 'error',
      message: error.message ?? result.message ?? '未知错误',
      details: error.details ?? result.details ?? {},
    }
  }
  if (result.ok === true) {
    const value = result.value
    // 对象就地摊平（界面按字段直读）；非对象（字符串/数组/标量）保留在 value 里。
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ...value, ok: true }
    }
    return { ok: true, value }
  }
  return result
}

export default unwrapEnvelope
