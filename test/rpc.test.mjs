/**
 * rpc.test.mjs —— RPC 端点的**注册时机**与**路径口径**。
 *
 * 为什么单开一份：此前 147 项用例全绿，而真机上点菜单报
 * `transport failure for /api/dsh-learn-skills: HTTP 404`。
 * 原因不是某段逻辑写错，而是**这条路径从来没被测过**：
 * 注册只在 `apply()` 那一刻试一次，而 `connection` 服务那时**常常还没就绪**
 * （它属于 Web 运行时那一层，本插件只 inject userQuestions/commands）——
 * 于是插件安静地放弃注册，菜单永远 404，斜杠命令却照常可用。
 *
 * 本文件钉死三件事：
 *   ① **时机**：`connection` 未就绪时必须"挂到就绪之后"，**不许**当场放弃；
 *   ② **路径**：注册的 path 必须带 `/api/` 前缀（复刻宿主断言，见 HOST_RULE）；
 *   ③ **信封**：菜单真正会打到的那条路，返回形状符合客户端契约。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { METHODS, RPC_ENDPOINT, registerLearnRpc } from '../plugin-src/host/rpc.mjs'

/**
 * 宿主的路径判据复刻。
 *
 * 源码原文（本机检出）：
 *   · `packages/client/connection/src/rpc-host.ts:266-275` `endpointFromPath()`
 *   · `packages/client/connection/src/rpc-host.ts:292-295` `assertFetchRoute()`
 * 合起来的规则：路由 path 必须形如 `/api/<segment…>`，且每段只允许 `[A-Za-z0-9_$.-]`。
 * ⚠️ 同文件 `rpc.ts:117` 的类型注释写作 "Absolute path below `/api`"（读起来像
 * `/dsh-learn-skills`）—— 那句是误导，实机按断言走。
 */
const HOST_CHANNEL = '/api'
const HOST_SEGMENT = /^[A-Za-z0-9_$.-]+$/u

function hostAcceptsRoute(path) {
  if (typeof path !== 'string' || !path.startsWith(`${HOST_CHANNEL}/`)) return false
  const segments = path.slice(HOST_CHANNEL.length + 1).split('/')
  return segments.every(segment => segment !== '' && HOST_SEGMENT.test(segment))
}

/** 造一个 connection 桩：记录注册/释放，并按宿主判据决定接受或抛错。 */
function stubConnection({ accept = hostAcceptsRoute } = {}) {
  const routes = new Map()
  return {
    routes,
    fetch: {
      register(route) {
        if (accept(route.path) === false) {
          throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
        }
        if (routes.has(route.path)) throw new Error(`already registered: ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
}

/** 造一个最小 ctx：`get('connection')` 与 `connection` 属性按传入给。 */
function stubCtx({ connection, inject } = {}) {
  const warnings = []
  const ctx = {
    logger: { info() {}, warn: message => warnings.push(String(message)) },
    warnings,
    get: name => (name === 'connection' ? connection : undefined),
  }
  if (connection !== undefined) ctx.connection = connection
  if (inject !== undefined) ctx.inject = inject
  return ctx
}

/** 造 deps 桩：flows 只实现 status；诊断出口把行收进数组，供断言。 */
function stubDeps(overrides = {}) {
  const lines = []
  return {
    lines,
    deps: {
      flows: () => ({ status: async () => ({ ok: true, workspace: 'D:/ws' }) }),
      version: 'test',
      diagnose: line => lines.push(line),
      ...overrides,
    },
  }
}

const ROUTE_PATH = `${HOST_CHANNEL}/${RPC_ENDPOINT}`

describe('registerLearnRpc —— 注册时机（本轮 404 的根因）', () => {
  it('① connection 已就绪：当场注册到 /api/<endpoint>', () => {
    const connection = stubConnection()
    const { deps } = stubDeps()

    const rpc = registerLearnRpc(stubCtx({ connection }), deps)

    assert.equal(rpc.state.route, ROUTE_PATH)
    assert.equal(rpc.state.deferred, false)
    const route = connection.routes.get(ROUTE_PATH)
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
  })

  it('★ ② connection 未就绪：不放弃，挂到它就绪之后再注册', () => {
    const connection = stubConnection()
    const pending = []
    const fiber = { disposed: false, dispose() { this.disposed = true } }
    const ctx = stubCtx({
      inject: (names, callback) => {
        pending.push({ names, callback })
        return fiber
      },
    })
    const { deps, lines } = stubDeps()

    const rpc = registerLearnRpc(ctx, deps)

    // 未就绪时不许假装成功
    assert.equal(rpc.state.route, null)
    assert.equal(rpc.state.deferred, true)
    assert.equal(connection.routes.size, 0)
    // 必须挂到 connection 上，而不是无声返回
    assert.equal(pending.length, 1)
    assert.deepEqual(pending[0].names, ['connection'])
    assert.ok(lines.some(line => line.includes('connection 未就绪')), '诊断出口要留痕')

    // 宿主稍后激活 connection 时回调这里
    pending[0].callback(stubCtx({ connection }))

    assert.equal(rpc.state.route, ROUTE_PATH, '服务就绪后必须真的注册')
    assert.equal(rpc.state.deferred, false)
    assert.equal(connection.routes.size, 1)
    assert.deepEqual(connection.routes.get(ROUTE_PATH).methods, ['POST'])

    // 重复触发（重载/重连）不该抛"已占用"，也不该重复注册
    pending[0].callback(stubCtx({ connection }))
    assert.equal(connection.routes.size, 1)
  })

  it('③ 宿主既无 connection 也无 ctx.inject：如实记录原因，不抛', () => {
    const { deps, lines } = stubDeps()
    const ctx = stubCtx()

    const rpc = registerLearnRpc(ctx, deps)

    assert.equal(rpc.state.route, null)
    assert.equal(rpc.state.deferred, false)
    assert.match(String(rpc.state.reason), /既无 connection 也无 ctx\.inject/u)
    assert.ok(lines.some(line => line.includes('既无 connection')), '诊断出口要留痕')
    assert.equal(ctx.warnings.length, 1, '要有一条 warn，不能静默')
  })

  it('④ 注册失败（路由已被占用等）：两条路径都记原因，不静默、不抛', () => {
    const failing = {
      routes: new Map(),
      fetch: { register() { throw new Error('route taken') } },
    }
    const { deps, lines } = stubDeps()

    const rpc = registerLearnRpc(stubCtx({ connection: failing }), deps)

    assert.equal(rpc.state.route, null)
    assert.match(String(rpc.state.reason), /两种路径都注册失败/u)
    assert.ok(lines.some(line => line.includes('RPC 注册失败')), '每条路径的失败原因都要留痕')
    assert.equal(failing.routes.size, 0)
  })
})

describe('registerLearnRpc —— 路径口径', () => {
  it('第一形态合法，第二形态在宿主上必被拒（它只为兼容别的 DSH 版本）', () => {
    assert.equal(hostAcceptsRoute(ROUTE_PATH), true)
    assert.equal(hostAcceptsRoute(`/${RPC_ENDPOINT}`), false)
    assert.equal(hostAcceptsRoute(`/api/${RPC_ENDPOINT}/${RPC_ENDPOINT}`), true, '多段也合法')
    assert.equal(hostAcceptsRoute(`/api/${RPC_ENDPOINT}/x y`), false, '段里有空格不合法')
  })

  it('注册实际落点必须能被宿主判据接受', () => {
    const connection = stubConnection()
    const { deps } = stubDeps()
    const rpc = registerLearnRpc(stubCtx({ connection }), deps)

    assert.equal(hostAcceptsRoute(rpc.state.route), true)
  })
})

describe('registerLearnRpc —— 释放', () => {
  it('dispose 释放路由，并拆除延迟注册的挂接', () => {
    const connection = stubConnection()
    const fiber = { disposed: false, dispose() { this.disposed = true } }
    const pending = []
    const ctx = stubCtx({
      inject: (names, callback) => {
        pending.push(callback)
        return fiber
      },
    })
    const { deps } = stubDeps()
    const rpc = registerLearnRpc(ctx, deps)

    pending[0](stubCtx({ connection }))
    assert.equal(connection.routes.size, 1)

    rpc.dispose()
    assert.equal(connection.routes.size, 0, '路由必须被释放')
    assert.equal(fiber.disposed, true, '挂接也必须被拆除')
  })

  it('当场注册的路径：dispose 也不抛（没有 fiber 可拆）', () => {
    const connection = stubConnection()
    const { deps } = stubDeps()
    const rpc = registerLearnRpc(stubCtx({ connection }), deps)

    assert.doesNotThrow(() => rpc.dispose())
    assert.equal(connection.routes.size, 0)
  })
})

describe('RPC 信封契约 —— 菜单真正会打到的那条路', () => {
  /** 取到已注册路由并打一发。 */
  async function call(payload) {
    const connection = stubConnection()
    const { deps } = stubDeps()
    const rpc = registerLearnRpc(stubCtx({ connection }), deps)
    const route = connection.routes.get(rpc.state.route)
    const response = await route.fetch(new Request(`http://127.0.0.1:3080${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    return { response, body: await response.json() }
  }

  it('未知 method → ok:false + unknown-method，且 details 是对象', async () => {
    const { body } = await call({ rpcId: 'r1', payload: { method: 'nope' } })

    assert.equal(body.type, 'server-response')
    assert.equal(body.rpcId, 'r1')
    assert.equal(body.result.ok, false)
    assert.equal(body.result.error.code, 'unknown-method')
    assert.equal(typeof body.result.error.details, 'object', 'details 缺了会被客户端判为非法响应')
    assert.deepEqual(body.result.error.details.available, METHODS)
  })

  it('status → ok:true，值来自 flows', async () => {
    const { body } = await call({ rpcId: 'r2', payload: { method: 'status' } })

    assert.equal(body.result.ok, true)
    assert.deepEqual(body.result.value, { ok: true, workspace: 'D:/ws' })
  })

  it('报文体不是 JSON → 400，且不抛', async () => {
    const connection = stubConnection()
    const { deps } = stubDeps()
    const rpc = registerLearnRpc(stubCtx({ connection }), deps)
    const route = connection.routes.get(rpc.state.route)
    const response = await route.fetch(new Request(`http://127.0.0.1:3080${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    }))

    assert.equal(response.status, 400)
  })
})
