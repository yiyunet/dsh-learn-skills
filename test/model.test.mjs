/**
 * model.test.mjs —— 「由模型生成后续提问」这一层的真实行为测试。
 *
 * 覆盖策略刻意**两条路都走**：
 *   · 成功路径：给一个假的 `ctx.llm`，让 `generateQuestion` 真的跑完一次流
 *     （拼块 → 解析 → 校验），证明模型通道本来就通 —— 只测降级会让这条通道
 *     长期处于"没测过"的状态，那正是它上线后最可能坏的地方。
 *   · 降级路径：缺服务 / 输出非法 / 流以 error 终止，全部要返回 `ok: false`
 *     而不是抛错（提问流程的确定性不能被一次网络抖动带走）。
 *
 * ⚠️ 这里不 mock `node:fs`，也不碰网络：`llm` 是**注入的假对象**，
 *    这正是把 I/O 收成单一函数（`generateQuestion`）换来的可测性。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_OPTIONS, MIN_OPTIONS, QUESTION_TIMEOUT_MS, TOPIC_POOL,
  buildMessages, buildSemanticMessages, buildThemeMapMessages, collectStream, describeFinish,
  extractJsonArray, extractJsonObject, generateQuestion, generateSemanticSuggestions, generateThemeMap,
  parseQuestionSpec, parseThreePart, readLlm, readModelRoute, renderHistory, renderKnownProfile,
  validateQuestionSpec, validateSemanticSuggestions,
} from '../plugin-src/host/model.mjs'
import { extractTopicMap, renderTopicMapSection } from '../plugin-src/host/preset.mjs'

/** 一个"能用"的假宿主：默认模型 + 假 llm（按脚本吐块）。 */
function fakeCtx(chunks, options = {}) {
  return {
    get: name => {
      if (name === 'agentDefaultModel') {
        return options.noModel === true
          ? undefined
          : { currentSelection: () => options.selection ?? { provider: 'deepseek-official', model: 'deepseek-flash' } }
      }
      if (name === 'llm') {
        if (options.noLlm === true) return undefined
        return {
          stream: () => (async function* generate() {
            for (const chunk of chunks ?? []) yield chunk
          })(),
        }
      }
      return undefined
    },
  }
}

/** 一个合法的模型输出。 */
const GOOD_JSON = JSON.stringify({
  topic: 'interests',
  question: '大学英语里，你最想先拿下哪一块？',
  detail: '选一个最影响你成绩的部分。',
  options: [
    { label: '听力', description: '四六级听力占比高' },
    { label: '阅读长难句', description: '阅读是拿分主力' },
    { label: '写作模板', description: '短期提分最快' },
  ],
})

/** 把一段文本包成宿主流式块（含终止块）。 */
const textChunks = (text, reason = { kind: 'stop' }) => [
  { type: 'text-delta', index: 0, text: text.slice(0, 10) },
  { type: 'text-delta', index: 0, text: text.slice(10) },
  { type: 'finish', reason },
]

describe('parseThreePart —— 三参数（职业/面向/期望）的解析', () => {
  it('全角竖线分隔：三段各归其位', () => {
    const parsed = parseThreePart('大学生 ｜ 面向大学英语 ｜ 更快更牢地掌握这门学科')
    assert.equal(parsed.vocation, '大学生')
    assert.equal(parsed.audience, '面向大学英语')
    assert.equal(parsed.expectation, '更快更牢地掌握这门学科')
    assert.equal(parsed.parts, 3)
  })

  it('半角斜杠与换行、分号都能当分隔符', () => {
    for (const raw of [
      '跨境电商运营 / 亚马逊北美站 Listing / 把转化率做上去',
      '跨境电商运营\n亚马逊北美站 Listing\n把转化率做上去',
      '跨境电商运营；亚马逊北美站 Listing；把转化率做上去',
      '跨境电商运营|亚马逊北美站 Listing|把转化率做上去',
    ]) {
      const parsed = parseThreePart(raw)
      assert.equal(parsed.vocation, '跨境电商运营', `分隔符未生效：${raw}`)
      assert.equal(parsed.audience, '亚马逊北美站 Listing')
      assert.equal(parsed.expectation, '把转化率做上去')
    }
  })

  it('★ 只填一段时**只当职业**，其余保持未知 —— 不替用户拆段', () => {
    const parsed = parseThreePart('大学生')
    assert.equal(parsed.vocation, '大学生')
    assert.equal(parsed.audience, null, '不得把一个词硬拆成"面向对象"')
    assert.equal(parsed.expectation, null)
    assert.equal(parsed.parts, 1)
  })

  it('空输入 → 三段全 null', () => {
    for (const raw of ['', '   ', null, undefined]) {
      const parsed = parseThreePart(raw)
      assert.equal(parsed.vocation, null)
      assert.equal(parsed.audience, null)
      assert.equal(parsed.expectation, null)
      assert.equal(parsed.parts, 0)
    }
  })
})

describe('extractJsonObject —— 从模型输出里抠 JSON', () => {
  it('裸 JSON 直接解析', () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 })
  })

  it('markdown 代码围栏被剥掉', () => {
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 })
    assert.deepEqual(extractJsonObject('```\n{"a":1}\n```'), { a: 1 })
  })

  it('JSON 前后的客套话被裁掉', () => {
    assert.deepEqual(extractJsonObject('好的，这是结果：\n{"a":1}\n希望有帮助。'), { a: 1 })
  })

  it('非对象 / 解析不了 → null（不猜）', () => {
    assert.equal(extractJsonObject('[1,2]'), null)
    assert.equal(extractJsonObject('完全不是 JSON'), null)
    assert.equal(extractJsonObject(''), null)
  })
})

describe('validateQuestionSpec —— 模型输出是不可信输入，必须严格校验', () => {
  const spec = extra => ({
    topic: 'interests',
    question: '题目？',
    options: [
      { label: 'A' }, { label: 'B' }, { label: 'C' },
    ],
    ...extra,
  })

  it('合法输出通过，并保住 description', () => {
    const result = validateQuestionSpec(spec({
      options: [{ label: 'A', description: '理由 A' }, { label: 'B' }, { label: 'C' }],
    }))
    assert.equal(result.ok, true)
    assert.equal(result.spec.topic, 'interests')
    assert.equal(result.spec.options.length, 3)
    assert.equal(result.spec.options[0].description, '理由 A')
  })

  it('★ topic 不在允许范围内 → 拒（不替它改成默认值）', () => {
    assert.equal(validateQuestionSpec(spec({ topic: 'hobby' })).ok, false)
    assert.equal(validateQuestionSpec(spec({ topic: '' })).ok, false)
    for (const topic of TOPIC_POOL) {
      assert.equal(validateQuestionSpec(spec({ topic })).ok, true, `${topic} 应当被接受`)
    }
  })

  it('题面为空 / 过长 → 拒', () => {
    assert.equal(validateQuestionSpec(spec({ question: '   ' })).ok, false)
    assert.equal(validateQuestionSpec(spec({ question: 'x'.repeat(201) })).ok, false)
  })

  it('★ 保留词不得混进候选（导航项由程序追加，重复了用户在界面上会看到两遍）', () => {
    const result = validateQuestionSpec(spec({
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: '暂不填写' }],
    }))
    assert.equal(result.ok, true)
    assert.ok(!result.spec.options.some(option => option.label === '暂不填写'),
      '保留词必须被剔除')
  })

  it('重复候选被去重；有效候选不足则整题判不合格', () => {
    const deduped = validateQuestionSpec(spec({ options: [{ label: 'A' }, { label: 'A' }, { label: 'B' }, { label: 'C' }] }))
    assert.equal(deduped.ok, true)
    assert.equal(deduped.spec.options.length, 3)

    const tooFew = validateQuestionSpec(spec({ options: [{ label: 'A' }, { label: 'B' }] }))
    assert.equal(tooFew.ok, false, `少于 ${MIN_OPTIONS} 个候选必须判不合格`)

    const empty = validateQuestionSpec(spec({ options: [] }))
    assert.equal(empty.ok, false)
  })

  it('候选过多时截到上限', () => {
    const many = Array.from({ length: MAX_OPTIONS + 4 }, (_, index) => ({ label: `选项${index}` }))
    const result = validateQuestionSpec(spec({ options: many }))
    assert.equal(result.ok, true)
    assert.equal(result.spec.options.length, MAX_OPTIONS)
  })

  it('options 不是数组 → 拒', () => {
    assert.equal(validateQuestionSpec(spec({ options: 'A,B,C' })).ok, false)
    assert.equal(validateQuestionSpec(spec({ options: undefined })).ok, false)
  })
})

describe('parseQuestionSpec —— 解析 + 校验的合体', () => {
  it('围栏包着的合法 JSON 能一路通过', () => {
    const result = parseQuestionSpec(`\`\`\`json\n${GOOD_JSON}\n\`\`\``)
    assert.equal(result.ok, true)
    assert.equal(result.spec.topic, 'interests')
  })

  it('解析不出 JSON 时给出**可读原因**（要进日志，不能只说"失败"）', () => {
    const result = parseQuestionSpec('我觉得你可以先学听力。')
    assert.equal(result.ok, false)
    assert.match(result.reason, /JSON/u)
  })
})

describe('buildMessages —— 提示词必须把已知信息与轮次都带进去', () => {
  const built = buildMessages({
    answers: { name: '小书童', vocation: '大学生', audience: '面向大学英语', expectation: '更快掌握' },
    unknown: ['goal'],
    round: 4,
    total: 7,
    usedTopics: ['name', 'vocation', 'interests'],
  })

  it('system 里写入轮次与"只能出一题"', () => {
    assert.match(built.system, /第 4 \/ 7 轮/u)
    assert.match(built.system, /只能出一题/u)
    assert.match(built.system, /还剩 3 轮/u, '剩余轮次要告诉模型，否则它不知道还该省着问什么')
  })

  it('system 里列全话题池与保留词约束', () => {
    for (const topic of TOPIC_POOL) assert.match(built.system, new RegExp(topic, 'u'))
    assert.match(built.system, /不要使用这些保留词/u)
  })

  it('user 消息里带已知信息、明确未填项、已问过的话题', () => {
    const text = built.messages[0].content[0].text
    assert.match(text, /大学生/u)
    assert.match(text, /面向大学英语/u)
    // ★ 2026-09（方案 B）：画像与约束一律转成**中文标签**再给模型。
    //   早先直接倒英文键名（`- vocation：…`），等于让模型自己翻译一遍 ——
    //   改成中文标签是"出题更有目的性"的前置条件之一。
    assert.match(text, /明确表示不填.*学习目标/u, '未知项要用中文标签')
    // ⚠️ `usedTopics` 的翻译在**编排层**（flows / preset 的 modelQuestion）完成，
    //    `buildMessages` 收到什么就写什么 —— 这里传的就是原始话题名，
    //    所以断言按原样匹配（中文标签那条由 preset 的 modelQuestion 负责）。
    assert.match(text, /已经问过的话题.*interests/u, '已问话题要原样带进提示词')
  })

  it('什么都不知道时不假装知道', () => {
    const empty = buildMessages({ answers: {}, unknown: [], round: 3, total: 7, usedTopics: [] })
    assert.match(empty.messages[0].content[0].text, /还没有任何已知信息/u)
  })

  it('消息形状符合宿主 RequestUserInput 契约', () => {
    assert.equal(built.messages[0].role, 'user')
    assert.deepEqual(built.messages[0].content[0].type, 'text')
    assert.equal(typeof built.messages[0].content[0].text, 'string')
  })
})

describe('readModelRoute / readLlm —— 缺能力时如实报缺，不猜', () => {
  it('缺 agentDefaultModel → ok:false 且原因可读', () => {
    const route = readModelRoute(fakeCtx([], { noModel: true }))
    assert.equal(route.ok, false)
    assert.match(route.reason, /agentDefaultModel/u)
  })

  it('provider/model 为空 → 视为未配置', () => {
    const route = readModelRoute(fakeCtx([], { selection: { provider: '', model: 'x' } }))
    assert.equal(route.ok, false)
    assert.match(route.reason, /未配置/u)
  })

  it('正常选区 → 带出三个字段', () => {
    const route = readModelRoute(fakeCtx([], { selection: { provider: 'p', model: 'm', reasoningEffort: 'low' } }))
    assert.deepEqual(route, { ok: true, provider: 'p', model: 'm', reasoningEffort: 'low' })
  })

  it('★ 形状不像 llm 的对象（版本漂移）→ 返 null 而不是硬用', () => {
    assert.equal(readLlm({ get: () => ({}) }), null)
    assert.equal(readLlm({ get: () => undefined }), null)
    const real = readLlm(fakeCtx([]))
    assert.equal(typeof real?.stream, 'function')
  })
})

describe('collectStream / describeFinish —— 汇总一次流', () => {
  it('只拼 text-delta，丢弃 reasoning-delta（推理过程不是答案）', async () => {
    const { text, finish } = await collectStream((async function* generate() {
      yield { type: 'reasoning-delta', index: 0, text: '我先想想……' }
      yield { type: 'text-delta', index: 1, text: '{"a"' }
      yield { type: 'text-delta', index: 1, text: ':1}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    assert.equal(text, '{"a":1}')
    assert.deepEqual(finish, { kind: 'stop' })
  })

  it('终止原因：error 与 aborted 都要说清', () => {
    assert.match(describeFinish({ kind: 'error', failure: { code: 'RATE_LIMIT' } }), /RATE_LIMIT/u)
    assert.match(describeFinish({ kind: 'aborted' }), /中止/u)
    assert.equal(describeFinish({ kind: 'stop' }), null)
    assert.equal(describeFinish(null), null)
  })
})

describe('generateQuestion —— 成功路径：模型通道真的能跑通', () => {
  it('★ 一次正常的模型调用：解析出题目并标 source=model', async () => {
    const result = await generateQuestion({
      ctx: fakeCtx(textChunks(GOOD_JSON)),
      answers: { vocation: '大学生', audience: '面向大学英语' },
      round: 3,
      total: 7,
      usedTopics: ['name', 'vocation'],
    })
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`)
    assert.equal(result.source, 'model')
    assert.equal(result.spec.topic, 'interests')
    assert.equal(result.spec.options.length, 3)
  })

  it('围栏包裹的输出也能过', async () => {
    const result = await generateQuestion({
      ctx: fakeCtx(textChunks('```json\n' + GOOD_JSON + '\n```')),
      answers: {},
      round: 5,
      total: 7,
      usedTopics: [],
    })
    assert.equal(result.ok, true)
  })
})

describe('generateQuestion —— 降级路径：永不抛错，一律 ok:false', () => {
  const base = { answers: {}, round: 3, total: 7, usedTopics: [] }

  it('缺 llm 服务', async () => {
    const result = await generateQuestion({ ...base, ctx: fakeCtx([], { noLlm: true }) })
    assert.equal(result.ok, false)
    assert.match(result.reason, /llm/u)
  })

  it('缺默认模型', async () => {
    const result = await generateQuestion({ ...base, ctx: fakeCtx([], { noModel: true }) })
    assert.equal(result.ok, false)
  })

  it('流以 error 终止', async () => {
    const result = await generateQuestion({
      ...base,
      ctx: fakeCtx(textChunks(GOOD_JSON, { kind: 'error', failure: { code: 'RATE_LIMIT' } })),
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /RATE_LIMIT/u)
  })

  it('输出不是合法题目', async () => {
    const result = await generateQuestion({ ...base, ctx: fakeCtx(textChunks('今天天气不错。')) })
    assert.equal(result.ok, false)
    assert.match(result.reason, /不合格|JSON/u)
  })

  it('流本身抛错 → 归一成 ok:false（不冒泡）', async () => {
    const ctx = {
      get: name => (name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : name === 'llm'
          ? { stream: () => (async function* generate() { throw new Error('socket hang up') })() }
          : undefined),
    }
    const result = await generateQuestion({ ...base, ctx })
    assert.equal(result.ok, false)
    assert.match(result.reason, /socket hang up/u)
  })

  it('★ 已经取消的信号 → 立刻返回，不发起调用', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await generateQuestion({ ...base, ctx: fakeCtx(textChunks(GOOD_JSON)), signal: controller.signal })
    assert.equal(result.ok, false)
    assert.match(result.reason, /取消/u)
  })

  it('超时上限是一个明确的正数（真机等待时间可预期）', () => {
    assert.ok(Number.isInteger(QUESTION_TIMEOUT_MS) && QUESTION_TIMEOUT_MS > 0)
  })
})

// ── 方案 B（2026-09）：上下文补齐 + 让模型参与编排 ────────────────────────────

describe('方案 B · 维度池补上两个"能改变助手行为"的黑洞', () => {
  it('★ trust / judge 在池子里 —— 它们直接决定预设正文怎么写', () => {
    assert.ok(TOPIC_POOL.includes('trust'), '缺 trust：预设里写着"结论附来源"，却从没问过他认什么依据')
    assert.ok(TOPIC_POOL.includes('judge'), '缺 judge：职责写着"最稳最快最省"，却从没问过他自己怎么排序')
  })
})

describe('renderKnownProfile —— 画像必须说人话（中文标签、剔除未填）', () => {
  it('★ 内部键名转成中文标签（旧版直接倒英文键名，模型得自己翻译）', () => {
    const lines = renderKnownProfile({ vocation: '跨境电商运营', audience: '面向 Listing' })
    assert.match(lines.join('\n'), /职业\/身份：跨境电商运营/u)
    assert.match(lines.join('\n'), /面向什么（人群或事情）：面向 Listing/u)
  })

  it('数组值拼成顿号分隔；空值/未知标记不进画像', () => {
    const lines = renderKnownProfile({ interests: ['A', 'B'], goal: null, unknown_goal: true })
    assert.match(lines.join('\n'), /关注方向：A、B/u)
    assert.ok(!lines.some(line => line.includes('goal')), `未填项不得进画像：${lines.join('|')}`)
    assert.ok(!lines.some(line => line.includes('unknown_')), 'unknown_ 是标记位，不是画像内容')
  })
})

describe('renderHistory —— 让模型看得见"上文"（旧版是彻底的无状态冷启动）', () => {
  it('★ 每轮都要有题面与他的回答', () => {
    const text = renderHistory([
      { round: 3, header: '第 3 题 · 关注方向', question: '哪些方向你关注？', raw: '平台政策与合规', source: 'model' },
    ]).join('\n')
    assert.match(text, /第 3 轮/u)
    assert.match(text, /问：哪些方向你关注？/u)
    assert.match(text, /答：平台政策与合规/u)
  })

  it('跳过与兜底题如实标注，不装成正常作答', () => {
    const text = renderHistory([
      { round: 5, question: '卡在哪？', raw: '', source: 'fallback' },
    ]).join('\n')
    assert.match(text, /（未作答\/跳过）/u)
    assert.match(text, /系统兜底题/u)
  })
})

describe('buildMessages —— 方案 B：把历史与预设正文草稿一起交给模型', () => {
  const built = buildMessages({
    answers: { name: '小书童', vocation: '大学生' },
    round: 4,
    total: 7,
    usedTopics: ['vocation'],
    history: [{ round: 3, question: '哪些方向你关注？', raw: '平台政策', source: 'model' }],
    bodyDraft: '# 小书童\n\n## 职责边界\n- 取舍口径：待定',
    doneAllowed: true,
  })

  it('★ 提示词里出现问答历史 —— 这是"接着上文"的机制落点', () => {
    assert.match(built.messages[0].content[0].text, /问答历史/u)
    assert.match(built.messages[0].content[0].text, /哪些方向你关注？/u)
  })

  it('★ 提示词里出现预设正文草稿 —— 模型据此判断"哪一句还是套话"', () => {
    assert.match(built.messages[0].content[0].text, /预设正文草稿/u)
    assert.match(built.messages[0].content[0].text, /取舍口径：待定/u)
  })

  it('★ 目的性判据被写进 system（不写出来，模型就会退回"填空"）', () => {
    assert.match(built.system, /消除「助手该怎么表现」的歧义/u)
    assert.match(built.system, /废题/u)
  })

  it('允许收尾时才出现 done 形状，否则明说第几轮起才允许', () => {
    assert.match(built.system, /"done":true/u)
    const early = buildMessages({ answers: {}, round: 3, total: 7, doneAllowed: false })
    assert.ok(!/"done":true/u.test(early.system), '未到最小轮数就不该告诉模型可以收尾')
  })
})

describe('validateQuestionSpec —— 提前收尾的信号要能被严格识别', () => {
  it('done:true → 接受，并带出 reason', () => {
    const result = validateQuestionSpec({ done: true, reason: '画像已能写出具体正文' })
    assert.equal(result.ok, true)
    assert.equal(result.done, true)
    assert.match(result.reason, /画像/u)
  })

  it('对照组：没有 done 标记时仍然必须是一道合法题（不能把 done 当万能后门）', () => {
    assert.equal(validateQuestionSpec({ reason: '想说点什么' }).ok, false)
    assert.equal(validateQuestionSpec({ done: false, topic: 'goal', question: 'x', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }).ok, true)
  })

  it('done 不是布尔真值时不算收尾', () => {
    const result = validateQuestionSpec({ done: 'yes', topic: 'goal' })
    assert.equal(result.ok, false, 'done 只认布尔 true，字符串不算')
  })
})

describe('generateQuestion —— 提前收尾要如实上报给编排层', () => {
  const base = { answers: {}, round: 4, total: 7, usedTopics: [], doneAllowed: true }
  const textChunks = text => [{ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'stop' } }]
  const fakeCtx = chunks => ({
    get: name => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      : name === 'llm'
        ? { stream: () => (async function* generate() { for (const chunk of chunks) yield chunk })() }
        : undefined),
  })

  it('★ 模型说"够了" → done:true 且带 reason（由 flows 的护栏决定认不认）', async () => {
    const result = await generateQuestion({ ...base, ctx: fakeCtx(textChunks('{"done":true,"reason":"已经能写出具体正文"}')) })
    assert.equal(result.ok, true)
    assert.equal(result.done, true)
    assert.match(result.reason, /具体正文/u)
  })

  it('对照组：正常一题仍然返回 spec（收尾能力不能污染正常路径）', async () => {
    const payload = '{"topic":"judge","question":"更稳/更快/更省，你怎么排？","options":[{"label":"先稳"},{"label":"先快"},{"label":"先省"}]}'
    const result = await generateQuestion({ ...base, ctx: fakeCtx(textChunks(payload)) })
    assert.equal(result.ok, true)
    assert.equal(result.done, undefined)
    assert.equal(result.spec.topic, 'judge')
  })
})

// ── 方案 B-1：语义增强（双轨并存 + 冲突标记）──────────────────────────────

describe('extractJsonArray —— 语义增强要的是数组，不是对象', () => {
  it('★ 裸数组能解析（复用 extractJsonObject 会永远失败，而且失败得很安静）', () => {
    const parsed = extractJsonArray('[{"id":"C-1","type":"fact"}]')
    assert.ok(Array.isArray(parsed))
    assert.equal(parsed[0].id, 'C-1')
  })

  it('围栏与前后客套话被裁掉', () => {
    const parsed = extractJsonArray('好的，结果如下：\n```json\n[{"id":"C-1","type":"fact"}]\n```\n以上。')
    assert.ok(Array.isArray(parsed))
    assert.equal(parsed.length, 1)
  })

  it('对照组：对象不是数组 → null（不能把对象当数组吞掉）', () => {
    assert.equal(extractJsonArray('{"id":"C-1"}'), null)
    assert.equal(extractJsonArray('今天天气不错'), null)
  })
})

describe('buildSemanticMessages —— 提示词必须写明"你是提议者，不是裁决者"', () => {
  const built = buildSemanticMessages({
    candidates: [{ id: 'C-1', title: '亚马逊广告', summary: 'ACOS 要控在 25% 以内' }],
    nodes: [{ id: 'LN-20260920-001', title: '北美站合规', tags: ['AMZ'] }],
  })

  it('★ 角色边界写进 system：是建议不是裁决、不确定就用保守值', () => {
    assert.match(built.system, /建议/u)
    assert.match(built.system, /不是裁决/u)
    assert.match(built.system, /unclassified/u)
  })

  it('★ 双轨语义写进 system：基线会并存展示、不一致会被人重点看', () => {
    assert.match(built.system, /基线/u)
    assert.match(built.system, /并存/u)
  })

  it('user 消息里同时带候选与已有节点（关系只能指向节点 id）', () => {
    const text = built.messages[0].content[0].text
    assert.match(text, /C-1/u)
    assert.match(text, /LN-20260920-001/u)
    assert.match(text, /关系只能指向这里的 id/u)
  })

  it('对照：知识库没有节点时如实说明"只能判 new"，不假装有关系可判', () => {
    const empty = buildSemanticMessages({ candidates: [{ id: 'C-1', title: 'x', summary: 'y' }], nodes: [] })
    assert.match(empty.messages[0].content[0].text, /还没有节点/u)
  })
})

describe('validateSemanticSuggestions —— 模型输出是不可信输入', () => {
  const ids = new Set(['C-1', 'C-2'])

  it('★ 合法输出通过，并保住 why', () => {
    const result = validateSemanticSuggestions(
      '[{"id":"C-1","type":"fact","relations":[{"id":"LN-1","relation":"supplement","why":"同属北美站"}],"why":"陈述句"}]',
      ids,
    )
    assert.equal(result.ok, true)
    assert.equal(result.suggestions.length, 1)
    assert.equal(result.suggestions[0].type, 'fact')
    assert.equal(result.suggestions[0].relations[0].confidence, 'model')
    assert.match(result.suggestions[0].relations[0].why, /北美站/u)
  })

  it('★ 编造的候选 id 一律丢弃（只认我们问过的那批）', () => {
    const result = validateSemanticSuggestions('[{"id":"WRONG","type":"fact"},{"id":"C-1","type":"fact"}]', ids)
    assert.equal(result.suggestions.length, 1)
    assert.equal(result.suggestions[0].id, 'C-1')
  })

  it('★ 非法的 type / relation 被丢弃，不做"替它改成默认值"', () => {
    const result = validateSemanticSuggestions(
      '[{"id":"C-1","type":"hobby","relations":[{"id":"LN-1","relation":"whatever"}]},{"id":"C-2","type":"fact"}]',
      ids,
    )
    assert.equal(result.suggestions.length, 1, 'type 与 relation 全非法的条目没有信息量，应丢弃')
    assert.equal(result.suggestions[0].id, 'C-2')
  })

  it('容忍常见的 { suggestions: [...] } 包装', () => {
    const result = validateSemanticSuggestions('{"suggestions":[{"id":"C-1","type":"fact"}]}', ids)
    assert.equal(result.ok, true)
    assert.equal(result.suggestions.length, 1)
  })

  it('对照组：一坨非 JSON 文本 → 明确失败，不猜', () => {
    const result = validateSemanticSuggestions('我觉得这条是事实吧', ids)
    assert.equal(result.ok, false)
    assert.match(result.reason, /JSON/u)
  })
})

describe('generateSemanticSuggestions —— 批量、预算、降级（永不抛错）', () => {
  const candidates = [
    { id: 'C-1', title: '广告', summary: 'ACOS' },
    { id: 'C-2', title: '合规', summary: 'FCC' },
  ]
  const semanticCtx = chunks => ({
    get: name => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      : name === 'llm'
        ? { stream: () => (async function* generate() { for (const chunk of chunks) yield chunk })() }
        : undefined),
  })
  const okChunks = text => [{ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'stop' } }]

  it('缺宿主上下文 → ok:false，且不抛（调用方回退基线轨）', async () => {
    const result = await generateSemanticSuggestions({ candidates, nodes: [] })
    assert.equal(result.ok, false)
    assert.match(result.reason, /上下文/u)
  })

  it('缺模型路由 → ok:false + 可读原因，不猜一个模型名', async () => {
    const result = await generateSemanticSuggestions({ ctx: { get: () => undefined }, candidates, nodes: [] })
    assert.equal(result.ok, false)
    assert.ok(typeof result.reason === 'string' && result.reason !== '')
  })

  it('候选为空 → ok:true 且零调用（不该为"没东西"去烧一次 token）', async () => {
    const result = await generateSemanticSuggestions({ ctx: semanticCtx([]), candidates: [], nodes: [] })
    assert.equal(result.ok, true)
    assert.equal(result.calls, 0)
  })

  it('★ 正常路径：一批（2 条候选 ≤ 批大小）只调一次，产出建议', async () => {
    const payload = '[{"id":"C-1","type":"fact"},{"id":"C-2","type":"procedure"}]'
    const result = await generateSemanticSuggestions({ ctx: semanticCtx(okChunks(payload)), candidates, nodes: [] })
    assert.equal(result.ok, true)
    assert.equal(result.calls, 1, '批大小为 8，2 条候选只该调一次 —— 这是成本控制的命门')
    assert.equal(result.suggestions.length, 2)
  })

  it('★ 输出不合格 → ok:false 但**继续尝试后续批次**，不是整体失败', async () => {
    const result = await generateSemanticSuggestions({
      ctx: semanticCtx(okChunks('这不是 JSON')),
      candidates,
      nodes: [],
      batchSize: 1,
    })
    assert.equal(result.ok, false)
    assert.equal(result.calls, 2, '两条候选各一批，都该被尝试')
    assert.match(result.reason, /JSON|不合格/u)
  })
})

// ── 主题地图（2026-09-28）：补上"初始预设只搭空架子"那一环 ──────────────────

describe('extractTopicMap —— 解析模型输出的 markdown 主题地图', () => {
  const sample = [
    '### AI/大模型应用实践',
    '- 建议主题：把企业流程拆成可自动化的步骤｜起手问题：哪三个环节最费人力？',
    '- 建议主题：大模型在客服场景的落地｜起手问题：现在的客服工单里哪类占比最高？',
    '### 数据处理与分析',
    '- 建议主题：指标口径统一｜起手问题：同一指标在两张表里对不上时以哪个为准？',
  ].join('\n')

  it('★ 正常结构能解析出方向与条目', () => {
    const parsed = extractTopicMap(sample)
    assert.equal(parsed.directions.length, 2)
    assert.equal(parsed.total, 3)
    assert.equal(parsed.directions[0].direction, 'AI/大模型应用实践')
  })

  it('★ 容错：`##` 与 `*` 前缀也认（解析窄会让整块地图白生成）', () => {
    const parsed = extractTopicMap('## 方向甲\n* 条目一\n- 条目二')
    assert.equal(parsed.directions.length, 1)
    assert.equal(parsed.total, 2)
  })

  it('跳过"标题类"假方向（模型常加一个总标题）', () => {
    const parsed = extractTopicMap('## 主题地图\n### 真方向\n- 条目')
    assert.equal(parsed.directions.length, 1)
    assert.equal(parsed.directions[0].direction, '真方向')
  })

  it('对照组：一堆散文 → 空地图，不猜', () => {
    const parsed = extractTopicMap('我觉得你可以先学学看，慢慢来。')
    assert.equal(parsed.directions.length, 0)
    assert.equal(parsed.total, 0)
  })

  it('没有条目的方向被丢弃（空壳方向不算地图）', () => {
    const parsed = extractTopicMap('### 只有标题\n### 有内容\n- 条目')
    assert.equal(parsed.directions.length, 1)
    assert.equal(parsed.directions[0].direction, '有内容')
  })
})

describe('renderTopicMapSection —— 主题地图必须与人话边界一起落盘', () => {
  it('★ 输出含"不是知识结论"的边界声明（防止被读成知识）', () => {
    const lines = renderTopicMapSection(extractTopicMap('### 方向甲\n- 条目一'))
    const text = lines.join('\n')
    assert.match(text, /## 主题地图/u)
    assert.match(text, /不是知识结论/u)
    assert.match(text, /方向甲/u)
  })

  it('对照组：空地图 → 不产生任何行（框架保持旧骨架）', () => {
    assert.deepEqual(renderTopicMapSection({ directions: [], total: 0 }), [])
    assert.deepEqual(renderTopicMapSection(null), [])
  })
})

describe('generateThemeMap —— 生成函数同样"永不抛错"', () => {
  const textChunks = text => [{ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'stop' } }]
  const mapCtx = chunks => ({
    get: name => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      : name === 'llm'
        ? { stream: () => (async function* generate() { for (const chunk of chunks) yield chunk })() }
        : undefined),
  })

  it('正常路径：返回原文（由编排层去解析）', async () => {
    const result = await generateThemeMap({ ctx: mapCtx(textChunks('### 方向\n- 条目')), answers: {} })
    assert.equal(result.ok, true)
    assert.match(result.text, /### 方向/u)
  })

  it('缺宿主上下文 → ok:false，不抛', async () => {
    const result = await generateThemeMap({ answers: {} })
    assert.equal(result.ok, false)
    assert.match(result.reason, /上下文/u)
  })

  it('模型输出为空也算失败，不假装成功', async () => {
    const result = await generateThemeMap({ ctx: mapCtx(textChunks('   ')), answers: {} })
    assert.equal(result.ok, false)
    assert.match(result.reason, /空输出/u)
  })
})

describe('buildThemeMapMessages —— 边界必须写死在提示词里', () => {
  const built = buildThemeMapMessages({
    answers: { name: '小书童', vocation: '运营', interests: ['方向甲', '方向乙'] },
    history: [{ round: 3, question: '关注哪些方向？', raw: '方向甲', source: 'model' }],
  })

  it('★ 明确禁止编造知识、明确不要 JSON', () => {
    assert.match(built.system, /不要编造/u)
    assert.match(built.system, /不要.*JSON/u)
  })

  it('user 消息带方向清单与访谈原话', () => {
    const text = built.messages[0].content[0].text
    assert.match(text, /方向甲/u)
    assert.match(text, /关注哪些方向？/u)
  })
})
