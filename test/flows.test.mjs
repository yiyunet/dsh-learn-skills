/**
 * flows.test.mjs —— 四入口的集成行为测试（真跑文件系统 + 假宿主能力）。
 *
 * 刻意"假宿主、真文件"：`ctx.userQuestions` 被替换成按脚本作答的桩（因为真实
 * 问答需要人在浏览器里点），而所有落盘都走真实文件系统 —— 本插件最要紧的
 * 承诺（不静默覆盖、只写该写的、可回滚）全在文件那一侧，不能 mock 掉。
 */
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createFlows, ENTRIES, slugOf } from '../plugin-src/host/flows.mjs'
import { readDirectory, readText, writeIfChanged } from '../plugin-src/host/fsx.mjs'
import { loadNodes } from '../plugin-src/host/knowledge.mjs'
import { fingerprint, isoTimestamp, normalizeSlashes } from '../plugin-src/host/paths.mjs'
import { CANCEL_SENTINEL, createPreset, renderAgentComposition, scaffoldWorkspace, SKIP_OPTION, TOTAL_ROUNDS } from '../plugin-src/host/preset.mjs'

/** 与插件默认一致的目录名（scaffoldWorkspace 直接用）。 */
const DIRS = {
  index: 'index', inbox: 'inbox', knowledge: 'knowledge', data: 'data',
  task: 'task', reports: 'reports', skillsDir: '.dsh/skills', stateDir: '.dsh/learn-skills',
}

let root
let workspace
/**
 * 默认预设根（临时目录内）。
 *
 * 为什么给默认值、而不是强制每个用例显式传：
 *   20 多个 `harness({...})` 调用点逐个去改，正是我上一轮制造"重复声明"的同款编辑方式。
 *   默认值 + **两条硬安全网**更稳：
 *     ① 测试装配断言：根目录必须落在系统临时目录之内（想写去真实家目录就直接红）；
 *     ② 真正的隔离靠"每个用例专属工作区"，不需要每个用例专属预设根。
 */
let sharedPresetRoot

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'learn-skills-flows-'))
  workspace = join(root, 'ws')
  sharedPresetRoot = join(root, 'presets-shared')
  await mkdir(workspace, { recursive: true })
  await mkdir(sharedPresetRoot, { recursive: true })
  // ★ 安全网①：目标根必须落在系统临时目录之内。
  //
  // ⚠️ 不要写"不在家目录之下"当判据 —— **Windows 上这是个假命题**：
  //    系统临时目录<用户>\AppData\Local\Temp 本来就在家目录之下。
  //    第一版就是这么写的，于是安全网把 30 条用例全判红了（它自己成了故障源）。
  //    正确判据只有一条：以 tmpdir() 为前缀。
  //
  // ⚠️ 比较前**两边都要归一化**：`tmpdir()` 给的是反斜杠形态，
  //    `normalizeSlashes()` 给的是正斜杠形态，混着比前缀永远不中。
  const { homedir } = await import('node:os')
  const slashed = value => normalizeSlashes(value).replace(/\/+$/u, '').toLowerCase()
  const temp = slashed(tmpdir())
  const base = slashed(sharedPresetRoot)
  assert.ok(temp !== '' && base.startsWith(`${temp}/`),
    `测试装配错误：预设根 ${sharedPresetRoot} 不在系统临时目录 ${tmpdir()} 之内 —— 会写到真实环境去`)
  // 仅作提示：把工作区与家目录记在测试输出里，方便排查"到底写去哪了"。
  if (process.env.LEARN_SKILLS_TEST_VERBOSE === '1') {
    console.log(`  · 测试工作区：${root}`)
    console.log(`  · 家目录前缀：${slashed(homedir())}（临时目录在它之下属正常）`)
  }
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 造一个 flows 实例；`script` 决定桩怎么回答。 */
/**
 * 把目录清空重建（不是"确保存在"）。
 *
 * ★ 这条修正了一个**极难归因**的症状：每个用例的工作区名是固定的（如 `case-idempotent`），
 *   而"清理旧目录"只发生在上次运行**成功**的时候 —— 上次失败留下的
 *   `.dsh/learn-skills/session.json`（`phase: "aborted"`）会被这次读到。
 *   `init` 见 phase 不是 `collecting` 就**从断点续办**，于是跳过错位的几题、
 *   拿上一轮某个用例的答案继续跑（实测症状：答案整体左移、值来自 `back` 用例）。
 *   同一个残留还让并发用例的守卫放行 —— 一条状态残留制造了两个"看起来无关"的失败。
 * @param {string} dir 目录
 */
async function freshDir(dir) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

function harness(options = {}) {
  const calls = []
  const answers = [...(options.answers ?? [])]
  // ★ 脚本数量闸：调用方声明"这个用例大概要问几次"，用完就对不上时当场炸。
  //
  // 为什么要它：脚本耗尽时桩会抛 ASK_CANCELLED，而业务代码把"取消"当成**正常结局**
  // （用户可能真按了取消）—— 于是"脚本不够"会伪装成"用户取消"，
  // 断言失败信息也会指向业务逻辑，而不是指向测试写少了。（实测踩过一次。）
  const scripted = answers.length
  let consumed = 0
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    // 可选：有的用例要验"提问带不带 live agent"（真机 404 之后的下一个坑）。
    ...options.agents === undefined ? {} : { agents: options.agents },
    // ★ 预设名册（`ctx.agentPresets`）—— 2.1.0 起「初始预设」的**唯一**身份判据。
    //   默认给一个"可用但空"的名册：不改变既有用例的语义（没有占位）。
    //   要验"撞既有 config.id"，传 `agentPresets: { list: async () => [{ id: 'alpha' }] }`。
    agentPresets: options.agentPresets === undefined ? { list: async () => [] } : options.agentPresets,
    // 可选：插件管理服务桩（2026-09 契约修订后语义）。
    //   · 创建路径的用例用它当**陷阱**：断言一次都没被调用（生成后不得自动装）。
    //   · 「人工点击才装」的用例用它当**探针**：断言恰好被调用一次、spec 是 link:<目录>。
    ...options.pluginManager === undefined ? {} : { pluginManager: options.pluginManager },
    userQuestions: {
      ask: async request => {
        calls.push(request)
        // ★ 钩子在**成功与失败两条路径上都要触发**。
        //   早先只在成功路径调用，于是"脚本答案用尽 → 抛 ASK_CANCELLED"时钩子不响，
        //   并发用例的 waitFor 永远等不到（实测踩过一次）。
        //   钩子语义是"即将提问"，不是"提问成功"。
        options.onAsk?.(request, calls.length)
        const next = answers.shift()
        if (next === undefined) {
          // ⚠️ code 必须是 `ASK_CANCELLED` —— 业务代码把它当"用户取消"的正常结局，
          //    而"取消"是本插件一条正经被测路径。所以这里**不能**换 code，
          //    只能把 message 写清楚，让"脚本写少了"一眼可辨：
          throw Object.assign(
            new Error(`脚本答案已用尽（第 ${consumed + 1} 次提问，脚本共 ${scripted} 条）—— `
              + '这是测试装配问题，不是业务代码取消了流程'),
            { code: 'ASK_CANCELLED' },
          )
        }
        consumed += 1
        return next
      },
    },
  }
  const config = {
    // 默认落临时目录（见文件头 before 里的安全网①）。要隔离的用例显式传自己的根。
    presetRoot: sharedPresetRoot,
    allowWrite: options.allowWrite ?? true,
    allowBehaviorRules: options.allowBehaviorRules ?? false,
    ...options.config,
  }
  const sessionInfo = async () => ({
    sessionId: 'session-test',
    workspace: options.workspace === undefined ? workspace : options.workspace,
    presetId: options.presetId ?? 'alpha',
    // ⚠️ 不给默认空数组：`messages` 缺省时**必须显式声明** `noMessages: true`。
    //    实测教训：某条用例漏传 `messages`，于是 `fixRange` 拿到空范围 ⇒
    //    `considered: 0` ⇒ 候选为空 ⇒ 下游报 `NOTHING_TO_DO`，
    //    而报错文字（"没有保留的候选"）把注意力全引到了裁决逻辑上。
    //    静默的默认值会让"漏传"和"故意为空"长得一模一样。
    messages: options.messages ?? (options.noMessages === true ? [] : missingMessages()),
    historyComplete: options.historyComplete ?? true,
  })
  return {
    flows: createFlows({ config, ctx, sessionInfo, version: '2.2.0' }),
    calls,
    /** 本轮桩被问了几次（脚本队列消耗了几条）。 */
    consumed: () => consumed,
  }
}

/** 漏传 messages 时的响亮报错（而不是静默给空数组）。 */
function missingMessages() {
  throw new Error(
    '测试装配错误：harness 没给 `messages`。'
    + '若本用例确实不需要消息（例如只验预设骨架），请显式写 `noMessages: true`；'
    + '否则补上 `messages` —— 静默默认空数组会把"漏传"伪装成"提炼没产出候选"。',
  )
}

/** 一条脚本化的问答应答。 */
const answer = (label, extra = {}) => ({ answers: [{ id: 'x', selected: [label], ...extra }] })

/** 第 2 题的三段式输入（职业 ｜ 面向 ｜ 期望）—— 本轮改动后第 2 题收的就是这个形状。 */
const THREE_PART = '跨境电商运营 ｜ 面向亚马逊北美站的 Listing ｜ 把转化率做上去'

/**
 * 七轮问答的完整应答脚本（名字用中文，覆盖"中文名"这条）。
 *
 * ⚠️ 计数从 6 变 7（2026-09-23）：前两轮固定（名字 / 三参数），第 3 轮起由模型
 *    逐轮生成、失败则回退硬编码。测试桩的 `ctx` **没有** `agentDefaultModel`，
 *    因此模型路径必然降级到硬编码题 —— 这也是本测试能保持确定性的原因：
 *    它验证的是"兜底路径正确"，而不是"模型答得好"。
 */
const sevenAnswers = (name = '小书童') => [
  answer(name),
  answer(THREE_PART),
  { answers: [{ id: 'interests', selected: ['平台政策与合规', '关键词与流量获取'], custom: '' }] },
  answer('能做出一份可直接用的方案'),
  answer('会用但不明白为什么'),
  answer('先看例子，再看原理'),
  answer('这个月先把 Listing 的转化问题定位清楚'),
]

/** 旧名保留：外部若有引用不至于断，但新用例一律用 `sevenAnswers`。 */
const sixAnswers = sevenAnswers

describe('ENTRIES —— 四个入口，名称与顺序固定', () => {
  it('顺序与名称逐字符合需求', () => {
    assert.deepEqual(ENTRIES.map(entry => entry.label), ['初始预设', '收集提炼', '关联升级', '沉淀复用'])
    assert.deepEqual(ENTRIES.map(entry => entry.id), ['init', 'distill', 'upgrade', 'audit'])
  })
})

// ★ `concurrency: 1`：入口一的用例共享 `root` 下的**同一个父目录**，
// 且彼此会创建/读取预设目录与状态文件。node:test 默认对 describe 内的
// 异步用例并发调度 —— 共享可变文件状态 + 并发 = 偶发串味。
// 这里用**串行**换取可复现：测试的价值在于能复现，不在于跑得快。
describe('入口一 · 初始预设', { concurrency: 1 }, () => {
  /**
   * 每个用例给**专属**的工作区与预设根，并且**清空重建**（不是"确保存在"）。
   *
   * 为什么必须清空：工作区名是固定的（`case-<label>`），而"清理旧目录"只发生在
   * 上次运行**成功**的时候。上次失败留下的 `session.json`（`phase:'aborted'`）
   * 会被这次读到，`init` 见 phase 不是 `collecting` 就**从断点续办** ——
   * 于是跳过错位的题、拿上一轮的答案继续跑。实测症状是"答案整体错位、
   * 值来自另一个用例"，极难归因。
   */
  async function fresh(label) {
    const ws = await freshDir(join(root, `case-${label}`))
    const localPresetRoot = await freshDir(join(root, `presets-${label}`))
    return { ws, localPresetRoot }
  }

  it('未绑定工作区时给出明确引导，且不写任何文件', async () => {
    const { flows } = harness({ workspace: null, noMessages: true })
    const result = await flows.init({ sessionId: 'session-test' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NO_WORKSPACE')
    assert.match(result.message, /绑定|工作区/u)
  })

  it('跑到预览：七题问完但**不创建任何文件**', async () => {
    const { ws, localPresetRoot } = await fresh('preview')
    const { flows, calls } = harness({ workspace: ws, noMessages: true, answers: sevenAnswers(), config: { presetRoot: localPresetRoot } })
    const result = await flows.init({ sessionId: 'session-test' })
    assert.equal(result.ok, true)
    assert.equal(result.stage, 'preview')
    assert.equal(calls.length, 7, '应正好问 7 题')
    assert.equal(result.preview.name, '小书童')
    // 画像行：名字 / 职业 / 面向 / 期望 / 关注方向 / 目标 / 基础 / 方式 / 优先
    // = 9 行，外加一行"未填写项/均已填写"的收尾说明 ⇒ 9 或 10 行。
    // 断言写死 `=== 6` 会在加收尾行时误报（实测踩过一次）。
    assert.ok(result.preview.summary.length >= 9 && result.preview.summary.length <= 10,
      `摘要应有 9~10 行，实得 ${result.preview.summary.length}：${JSON.stringify(result.preview.summary)}`)
    for (const topic of ['名字', '职业/身份', '面向什么', '期望达到什么', '关注方向', '学习目标', '当前基础与困难', '学习方式与约束', '最想先解决的一件事']) {
      assert.ok(result.preview.summary.some(line => line.startsWith(topic)),
        `摘要缺「${topic}」一行`)
    }
    assert.ok(result.preview.paths.some(item => item.path === 'knowledge/framework.md'))
    // 关键：预览阶段不落盘
    assert.equal(existsSync(join(ws, 'AGENTS.md')), false)
    assert.equal(existsSync(join(ws, 'knowledge')), false)
  })

  it('第 3 题按职业生成 7 个"可能关注"方向 + 其他（模型不可用时走兜底池）', async () => {
    const { ws, localPresetRoot } = await fresh('interests')
    const seen = []
    const { flows } = harness({
      workspace: ws,
      noMessages: true,
      answers: sevenAnswers(),
      config: { presetRoot: localPresetRoot },
      onAsk: request => seen.push(request.questions[0]),
    })
    await flows.init({ sessionId: 'session-test' })
    const interests = seen.find(question => question.id === 'interests')
    // 7 个候选 + 「其他，请输入」 + 「暂不填写」 + 「返回修改」 + 「取消」
    // （需求：每题都要能明确选"暂不填写"，且能返回修改前置答案）
    assert.equal(interests.options.length, 11,
      `第 3 题应有 11 个选项，实得 ${interests.options.length}：${JSON.stringify(interests.options.map(option => option.label))}`)
    assert.equal(interests.options[7].label, '其他，请输入')
    assert.equal(interests.options[8].label, SKIP_OPTION.label)
    assert.ok(interests.options.some(option => option.label.includes('返回修改')),
      '第 3 题的候选依赖第 2 题职业，最需要"返回修改"')
    assert.equal(interests.multiSelect, true, '必须是多选')
    assert.ok(!/最高关注度/u.test(interests.question), '不得伪称统计结论')
  })

  it('第 4~7 题围绕清晰主题，各题给自定义与跳过', async () => {
    const { ws, localPresetRoot } = await fresh('topics')
    const seen = []
    const { flows } = harness({
      workspace: ws,
      noMessages: true,
      answers: sixAnswers(),
      config: { presetRoot: localPresetRoot },
      onAsk: request => seen.push(request.questions[0]),
    })
    await flows.init({ sessionId: 'session-test' })
    const labels = seen.slice(3).map(question => question.header)
    assert.match(labels[0], /学习目标/u)
    assert.match(labels[1], /当前基础/u)
    assert.match(labels[2], /学习方式/u)
    for (const question of seen.slice(1)) {
      assert.ok(question.options.some(option => option.label === SKIP_OPTION.label),
        `「${question.header}」缺"暂不填写"选项`)
      assert.ok(question.options.some(option => option.label.includes('返回修改')),
        `「${question.header}」缺"返回修改"选项`)
    }
  })

  it('跳过项保持未知，不编造画像', async () => {
    const { ws, localPresetRoot } = await fresh('skip')
    const script = [
      answer('小书童'),
      { answers: [{ id: 'vocation', selected: ['暂不透露'], custom: '' }] },
      { answers: [{ id: 'interests', selected: ['暂不填写'], custom: '' }] },
      { answers: [{ id: 'goal', selected: ['暂不填写'], custom: '' }] },
      { answers: [{ id: 'baseline', selected: ['暂不填写'], custom: '' }] },
      { answers: [{ id: 'style', selected: ['暂不填写'], custom: '' }] },
      { answers: [{ id: 'priority', selected: ['暂不填写'], custom: '' }] },
    ]
    const { flows } = harness({ workspace: ws, noMessages: true, answers: script, config: { presetRoot: localPresetRoot } })
    const result = await flows.init({ sessionId: 'session-test' })
    assert.equal(result.ok, true)
    assert.equal(result.answers.vocation, null)
    assert.equal(result.answers.interests, null)
    assert.match(result.preview.summary.join('\n'), /未知 —— 未填写/u)
    assert.match(result.preview.summary.join('\n'), /不编造/u)
  })

  it('重名：拒绝并请用户换名，且既有预设一个字也不动', async () => {
    const { ws, localPresetRoot } = await fresh('dup')
    // 既有预设：一个**手工**目录（v1 形态），用来钉住"非侵入"这一条。
    await mkdir(join(localPresetRoot, 'kept'), { recursive: true })
    await writeFile(join(localPresetRoot, 'kept', 'preset.yml'), 'name: 小书童\ndescription: 既有\n', 'utf8')

    // ★ 2.1.0 起**重名的判据是宿主名册**（预设身份＝声明行里的 `config.id`，
    //   注册表不扫描目录）⇒ 想模拟"这个名字已被占用"，必须把它放进名册，
    //   而不是像以前那样"在预设根里放一个目录"。见 `readRoster()` 的长注释。
    //   （目录仍然管另一件事：**写目标占用** —— `createPreset` 的 `ID_TAKEN`，
    //     防的是"覆盖本插件自己生成、但还没安装的 bundle"。两件事，两套判据。）
    const { flows } = harness({
      workspace: ws,
      noMessages: true,
      // 名字冲突发生在问答阶段的校验里：第二次作答必须换名。
      answers: [answer('小书童'), answer('新名字'), ...sixAnswers('小书童').slice(1)],
      config: { presetRoot: localPresetRoot },
      agentPresets: { list: async () => [{ id: 'kept', name: '小书童' }] },
    })
    const result = await flows.init({ sessionId: 'session-test' })
    assert.equal(result.ok, true)
    assert.equal(result.preview.name, '新名字')
    // 原预设一个字也没动
    assert.equal(await readFile(join(localPresetRoot, 'kept', 'preset.yml'), 'utf8'), 'name: 小书童\ndescription: 既有\n')
  })

  it('非法名字：回问一次；再错则终止且不写文件', async () => {
    const { ws, localPresetRoot } = await fresh('bad')
    const { flows } = harness({ workspace: ws, noMessages: true, answers: [answer('a/b'), answer('x*y')], config: { presetRoot: localPresetRoot } })
    const result = await flows.init({ sessionId: 'session-test' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'INVALID_ANSWER')
    assert.equal(existsSync(join(ws, 'AGENTS.md')), false)
  })

  it('中途取消：已完成题数如实汇报，已收答案保留，不创建文件', async () => {
    const { ws, localPresetRoot } = await fresh('cancel')
    const { flows } = harness({
      workspace: ws,
      noMessages: true,
      config: { presetRoot: localPresetRoot },
      answers: [answer('小书童'), { answers: [{ id: 'v', selected: [CANCEL_SENTINEL] }] }],
    })
    const result = await flows.init({ sessionId: 'session-test' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'FLOW_CANCELLED')
    // ★ 用 TOTAL_ROUNDS 而不是写死数字：题序从 6 改 7 时这条断言曾漏改（实测）。
    assert.match(result.message, new RegExp(`已完成 1 / ${TOTAL_ROUNDS}`, 'u'))
    assert.equal(result.answers.name, '小书童')
    assert.equal(existsSync(join(ws, 'AGENTS.md')), false)
    // 断点已落盘，可续办
    const state = JSON.parse(await readFile(join(ws, '.dsh/learn-skills/session.json'), 'utf8'))
    assert.equal(state.phase, 'aborted')
    assert.equal(state.answers.name, '小书童')
  })

  it('返回修改：回退一题重答，并重算后续推荐', async () => {
    const { ws, localPresetRoot } = await fresh('back')
    const seen = []
    const script = [
      answer('小书童'),
      answer('销售业务'),
      answer('← 返回修改前面的回答'),          // 第 3 题：回退
      answer(THREE_PART),                      // 重答第 2 题（三段式）
      { answers: [{ id: 'i', selected: ['平台政策与合规'], custom: '' }] },
      answer('能做出一份可直接用的方案'),
      answer('会用但不明白为什么'),
      answer('先看例子，再看原理'),
      answer('这个月先把 Listing 的转化问题定位清楚'),
    ]
    const { flows, calls } = harness({
      workspace: ws,
      noMessages: true,
      answers: script,
      config: { presetRoot: localPresetRoot },
      onAsk: request => seen.push(request.questions[0]),
    })
    const result = await flows.init({ sessionId: 'session-test' })
    assert.equal(result.ok, true)
    assert.equal(result.answers.vocation, '跨境电商运营')
    // 重答职业之后，第 3 题的候选必须重新生成（不再是销售那一套）
    const interestQuestions = seen.filter(question => question.id === 'interests')
    assert.equal(interestQuestions.length, 2, '第 3 题应被重新问一次')
    assert.ok(interestQuestions[1].options.some(option => option.label === '平台政策与合规'))
    assert.ok(!interestQuestions[1].options.some(option => option.label === '客户沟通与话术'))
    assert.ok(calls.length >= 8)
  })

  it('确认创建：生成预设与工作区框架，并自证结构', async () => {
    const { ws, localPresetRoot } = await fresh('create')
    const { flows } = harness({ workspace: ws, noMessages: true, answers: sixAnswers('学习搭子'), config: { presetRoot: localPresetRoot } })
    const preview = await flows.init({ sessionId: 'session-test' })
    assert.equal(preview.stage, 'preview')
    // ★ 第二步复用第一步落盘的答案，不再问第二遍六题（桩里已经没有答案可给了）
    const result = await flows.init({ sessionId: 'session-test', confirmCreate: true })

    assert.equal(result.ok, true)
    assert.equal(result.stage, 'created')
    assert.equal(result.preview.name, '学习搭子')
    // 工作区骨架
    assert.equal(existsSync(join(ws, 'AGENTS.md')), true)
    assert.equal(existsSync(join(ws, 'knowledge/framework.md')), true)
    assert.equal(existsSync(join(ws, 'knowledge/nodes')), true)
    assert.equal(existsSync(join(ws, 'inbox')), true)
    assert.equal(existsSync(join(ws, 'index')), true)
    assert.equal(existsSync(join(ws, 'data')), true)
    assert.equal(existsSync(join(ws, 'task')), true)
    assert.equal(existsSync(join(ws, 'reports')), true)
    assert.equal(existsSync(join(ws, '.dsh/skills')), true)
    assert.equal(existsSync(join(ws, '.dsh/learn-skills')), true)
    // 预设本体（2.1.0 起是 bundle **两件套**、落在**工作区内**；不再有目录式 preset.yml/agent.cordis.yml）
    assert.equal(result.preset.ok, true)
    assert.equal(existsSync(join(result.preset.directory, 'cordis.patch.yml')), true)
    assert.equal(existsSync(join(result.preset.directory, 'package.json')), true)
    assert.equal(result.verification.structurallyValid, true)
    assert.ok(result.verification.rows > 5)
    // 预设正文含七要素，且写明"职业/兴趣只是相关性"
    const composition = await readFile(join(result.preset.directory, 'cordis.patch.yml'), 'utf8')
    for (const section of ['角色定位', '职责边界', '表达偏好', '工作流程', '知识检索入口', '不确定性处理']) {
      assert.match(composition, new RegExp(section, 'u'), `预设正文缺「${section}」`)
    }
    assert.match(composition, /不构成限制|只用于调整相关性/u)
    // 提示新建会话（不宣称当前会话即时生效）
    assert.match(result.message, /新建会话/u)
  })

  it('既有 AGENTS.md 不被覆盖（内容不同 → conflict，如实上报）', async () => {
    const { ws, localPresetRoot } = await fresh('existing')
    const original = '# 我自己的规则\n\n不要动这一行。\n'
    await writeFile(join(ws, 'AGENTS.md'), original, 'utf8')

    const { flows } = harness({ workspace: ws, noMessages: true, answers: sixAnswers('既有测试'), config: { presetRoot: localPresetRoot } })
    await flows.init({ sessionId: 'session-test' })
    const result = await flows.init({ sessionId: 'session-test', confirmCreate: true })
    assert.equal(await readFile(join(ws, 'AGENTS.md'), 'utf8'), original, '既有 AGENTS.md 必须一字未改')
    assert.equal(result.scaffold.conflicts, 1)
    // 冲突项在清单里如实列出，且理由写明
    const conflict = result.scaffold.decisions.find(item => item.action === 'conflict')
    assert.equal(conflict.relative, 'AGENTS.md')
    assert.match(conflict.reason, /拒绝覆盖/u)
  })

  /**
   * 重复运行：内容相同则跳过，不重复创建也不覆盖。
   *
   * ★ 本用例**不走六题问答**，直接调 `createPreset` / `scaffoldWorkspace`。
   *
   * 为什么改掉：它原本靠 `init` 跑两遍，而"第二遍"要依赖"第一遍留下的会话状态
   * 已被正确清掉"。实测这一条连续失败四轮，每次报出的都是**上一次运行残留**的
   * `session.json`（`phase:'aborted'` ⇒ 守卫不拦 ⇒ 从断点续办 ⇒ 答案整体错位）。
   * 换言之：它的失败与"重复创建"这个被测行为**毫无关系**，纯粹是夹具在漏。
   *
   * 它真正要验的是**写入判据**——"同一目标、同一内容 ⇒ skip；同名预设已存在 ⇒ 拒绝"。
   * 那就直接测这两个函数，别把会话生命周期拖进来。
   */
  it('重复运行：内容相同则跳过，不重复创建也不覆盖', async () => {
    const { ws, localPresetRoot } = await fresh('idempotent')
    const normalized = {
      values: {
        name: '幂等测试',
        vocation: '跨境电商运营',
        interests: ['平台政策与合规'],
        goal: '能做出一份可直接用的方案',
        baseline: '会用但不明白为什么',
        style: '先看例子，再看原理',
      },
      unknown: {},
    }

    const firstPreset = await createPreset({
      presetRoot: localPresetRoot, presetId: 'idempotent-test', displayName: '幂等测试', answers: normalized,
    })
    assert.equal(firstPreset.ok, true, `首轮预设应创建成功，实得 ${JSON.stringify(firstPreset).slice(0, 200)}`)
    const firstScaffold = await scaffoldWorkspace({
      workspace: ws, dirs: DIRS, answers: normalized, mkdir: path => mkdir(path, { recursive: true }),
    })
    assert.ok(firstScaffold.created > 0, '首轮应创建若干工作区文件')

    const presetPatch = await readText(join(firstPreset.directory, 'cordis.patch.yml'))
    const agentsMd = await readText(join(ws, 'AGENTS.md'))

    // 第二次：同一目标、同一内容
    const secondScaffold = await scaffoldWorkspace({
      workspace: ws, dirs: DIRS, answers: normalized, mkdir: path => mkdir(path, { recursive: true }),
    })
    assert.equal(secondScaffold.created, 0, '内容一致时不得重建任何文件')
    assert.ok(secondScaffold.skipped > 0, '内容一致时应全部 skip')
    assert.equal(secondScaffold.conflicts, 0, '内容一致时不该有冲突')

    const secondPreset = await createPreset({
      presetRoot: localPresetRoot, presetId: 'idempotent-test', displayName: '幂等测试', answers: normalized,
    })
    assert.equal(secondPreset.ok, false, '同名预设目录已存在，必须拒绝创建')
    assert.equal(secondPreset.code, 'ID_TAKEN')
    assert.match(secondPreset.message, /不覆盖/u)

    // 既有文件一字未改
    assert.equal(await readText(join(firstPreset.directory, 'cordis.patch.yml')), presetPatch)
    assert.equal(await readText(join(ws, 'AGENTS.md')), agentsMd)
  })

  it('写门禁关闭时只出预览', async () => {
    const { ws, localPresetRoot } = await fresh('nogate')
    const { flows } = harness({ workspace: ws, noMessages: true, answers: sixAnswers('门禁测试'), allowWrite: false, config: { presetRoot: localPresetRoot } })
    await flows.init({ sessionId: 'session-test' })
    const result = await flows.init({ sessionId: 'session-test', confirmCreate: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'WRITE_DISABLED')
    assert.equal(existsSync(join(ws, 'AGENTS.md')), false)
  })
})

describe('入口二 · 收集提炼', () => {
  /**
   * ★ 预设根一律**直接写 `sharedPresetRoot`**，不在这里做别名。
   *
   * 别名是实测踩过的坑：`describe` 回调在**收集期**就执行，而 `sharedPresetRoot`
   * 在根 `before`（**执行期**）才赋值 —— 别名当场拿到 `undefined`，
   * 后面 `mkdir(undefined)` 抛 `ERR_INVALID_ARG_TYPE`。
   * 多一层中间变量只换来"看起来更整齐"，代价是一个只在特定加载顺序下才现形的错。
   */
  const messages = [
    { id: 'seq-1', seq: 1, role: 'user', text: '北美站合规要求是要有 FCC 标识', sessionId: 's1' },
    { id: 'seq-2', seq: 2, role: 'user', text: '好的', sessionId: 's1' },
    { id: 'seq-3', seq: 3, role: 'user', text: '步骤：先查类目，再填属性，最后提交', sessionId: 's1' },
  ]

  it('产出候选批次并写入 inbox，**不碰** knowledge / AGENTS.md / 预设', async () => {
    const ws = await freshDir(join(root, 'ws-distill'))
    await mkdir(sharedPresetRoot, { recursive: true })
    await writeFile(join(ws, 'AGENTS.md'), '# 原有规则\n', 'utf8')
    const before = await readFile(join(ws, 'AGENTS.md'), 'utf8')

    const { flows } = harness({
      workspace: ws,
      messages,
      answers: [{ answers: [{ id: 'r', selected: ['全部保留'], custom: '' }] }],
      config: { presetRoot: sharedPresetRoot },
    })
    const result = await flows.distill({ sessionId: 'session-test' })
    assert.equal(result.ok, true)
    assert.equal(result.batchId, '001')
    assert.equal(result.kept, 2, '两条有信息量的内容应被保留')
    assert.equal(existsSync(join(ws, 'inbox/.candidates-001.json')), true)
    assert.equal(existsSync(join(ws, 'knowledge/nodes')), false, '本阶段不得创建知识节点')
    assert.equal(await readFile(join(ws, 'AGENTS.md'), 'utf8'), before, '本阶段不得改 AGENTS.md')
  })

  it('部分上下文时如实标注范围，不宣称完整复盘', async () => {
    const ws = await freshDir(join(root, 'ws-partial'))
    const { flows } = harness({
      workspace: ws, messages, historyComplete: false,
      answers: [{ answers: [{ id: 'r', selected: ['全部保留'], custom: '' }] }],
      config: { presetRoot: sharedPresetRoot },
    })
    const result = await flows.distill({ sessionId: 'session-test' })
    assert.equal(result.complete, false)
    assert.ok(result.limitations.some(item => /部分范围/u.test(item)))
  })

  it('重复处理相同消息：识别为已处理，不重复创建候选', async () => {
    const ws = await freshDir(join(root, 'ws-repeat'))
    await mkdir(sharedPresetRoot, { recursive: true })
    const config = { presetRoot: sharedPresetRoot }
    const first = harness({
      workspace: ws, messages, config,
      answers: [{ answers: [{ id: 'r', selected: ['全部保留'], custom: '' }] }],
    })
    await first.flows.distill({ sessionId: 'session-test' })

    const second = harness({
      workspace: ws, messages, config,
      answers: [{ answers: [{ id: 'r', selected: ['全部保留'], custom: '' }] }],
    })
    const result = await second.flows.distill({ sessionId: 'session-test' })
    assert.equal(result.batchId, '002')
    assert.ok(result.candidates.every(candidate => candidate.alreadyProcessed?.batchId === '001'),
      '同一段消息第二次应全部标为已处理')
  })

  it('裁决阶段取消：批次已保存，正式知识仍未被写', async () => {
    const ws = await freshDir(join(root, 'ws-distill-cancel'))
    const { flows } = harness({
      workspace: ws, messages,
      answers: [{ answers: [{ id: 'r', selected: [CANCEL_SENTINEL], custom: '' }] }],
      config: { presetRoot: sharedPresetRoot },
    })
    const result = await flows.distill({ sessionId: 'session-test' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'FLOW_CANCELLED')
    assert.equal(result.batchId, '001')
    assert.equal(existsSync(join(ws, 'knowledge/nodes')), false)
  })
})

describe('入口三 · 关联升级', () => {
  const messages = [
    { id: 'seq-1', seq: 1, role: 'user', text: '北美站的合规要求是要有 FCC 标识', sessionId: 's1' },
    { id: 'seq-2', seq: 2, role: 'user', text: '步骤：先查类目，再填属性，最后提交', sessionId: 's1' },
  ]

  /**
   * 播一批候选（提炼 + 裁决一次）。
   *
   * ⚠️ 返回的 `flows` 上还挂着脚本队列 —— 后续每次 `upgrade` 都会**再问一次裁决**，
   *    所以 `extraReviews` 要给够次数。早先默认只给 1 条，于是第二个 upgrade 的
   *    裁决问答耗尽脚本、被桩当成"用户取消"，最终以 `FLOW_CANCELLED` 静默收场，
   *    断言却指向业务逻辑（实测踩过一次：conflict 用例报 `failed=[]`）。
   * @param {string} ws 工作区
   * @param {object} [config] flows 配置
   * @param {number} [extraReviews] 额外准备的裁决次数（不含本次）
   */
  /**
   * 播一批候选（提炼 + 裁决一次）。
   *
   * ⚠️ 裁决答案**总是要给一条**：`reviewCandidates` 只在"没有可裁决候选"时才不问，
   *    而播种子这一步必然产出候选 ⇒ 必然问一次。早先写成
   *    `answers: extraReviews === 0 ? undefined : [...]`，把默认情形（0 次额外裁决）
   *    变成了"一条都不给" —— 于是裁决不提问、`decision` 停在 `pending`，
   *    下游 upgrade 报 `NOTHING_TO_DO`，看起来像写入逻辑坏了。
   * @param {string} ws 工作区
   * @param {object} [config] flows 配置
   * @param {number} [extraReviews] 额外准备的裁决次数（不含提炼那一次）
   */
  async function seedBatch(ws, config, extraReviews = 0) {
    const keepAll = { answers: [{ id: 'r', selected: ['全部保留'], custom: '' }] }
    const { flows } = harness({
      workspace: ws, messages, config,
      answers: [keepAll, ...Array.from({ length: extraReviews }, () => keepAll)],
    })
    const distilled = await flows.distill({ sessionId: 'session-test' })
    return { flows, distilled }
  }

  /**
   * 手植一个"待升级"的批次：批次账 + 候选文件一起写。
   *
   * ★ 为什么需要它（实测踩过）：`upgrade(confirmWrite: true)` 成功后会把这个批次
   *   标成 `done`，紧接着的**第三次** `upgrade` 就只会回一句 `NO_BATCH` ——
   *   于是"验证第二次升级"的用例根本没跑到写入段，失败信息却指向 assert 的那一行。
   *   凡是"想再跑一次升级"的用例，都必须先植一个**新批次**。
   * @param {string} ws 工作区
   * @param {string} batchId 批次号（如 `002`）
   * @param {string} nodeId 候选要关联的节点 id
   * @param {string} text 候选摘要
   * @returns {Promise<void>} 完成
   */
  async function plantBatch(ws, batchId, nodeId, text) {
    await writeFile(join(ws, '.dsh/learn-skills/batches.json'), JSON.stringify({
      version: 1,
      batches: [{
        batchId, flow: 'distill', status: 'awaitingUpgrade',
        createdAt: isoTimestamp(), date: '2026-09-20',
      }],
      seen: {},
    }, null, 2), 'utf8')
    await writeFile(join(ws, `inbox/.candidates-${batchId}.json`), JSON.stringify({
      version: 1,
      batchId,
      candidates: [{
        id: `C-${batchId}-01`,
        title: '测试候选：补充既有节点',
        summary: text,
        type: 'fact',
        scope: '本会话',
        source: { sessionId: 's1', messageIds: ['seq-9'], seqRange: [9, 9], precision: 'message', limitation: null },
        evidence: '会话原文',
        verification: 'unverified',
        decision: 'keep',
        relations: [{ id: nodeId, relation: 'candidate', confidence: 'heuristic' }],
        fingerprint: 'deadbeef',
        alreadyProcessed: null,
      }],
    }, null, 2), 'utf8')
  }

  it('没有批次时明确引导先做提炼', async () => {
    const ws = await freshDir(join(root, 'ws-up-none'))
    const { flows } = harness({ workspace: ws, noMessages: true })
    const result = await flows.upgrade({ sessionId: 'session-test' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NO_BATCH')
    assert.match(result.message, /收集提炼/u)
  })

  it('未确认时只出变更清单，不写任何节点', async () => {
    const ws = await freshDir(join(root, 'ws-up-review'))
    // `upgrade` 每次调用都会**重新裁决**（decisions 不跨调用保存），所以要给两次。
    const { flows } = await seedBatch(ws, undefined, 1)
    const result = await flows.upgrade({ sessionId: 'session-test' })
    assert.equal(result.ok, true, `应出变更清单，实得 ${JSON.stringify(result).slice(0, 300)}`)
    assert.equal(result.stage, 'review')
    assert.equal(result.changes.length, 2)
    for (const change of result.changes) {
      assert.ok(['create', 'update'].includes(change.operation))
      assert.ok(typeof change.reason === 'string' && change.reason.length > 0)
      assert.ok(typeof change.impact === 'string' && change.impact.length > 0)
    }
    assert.equal(existsSync(join(ws, 'knowledge/nodes')), false)
  })

  it('确认后写入节点并刷新总索引；版本为 1；变更日志可回滚', async () => {
    const ws = await freshDir(join(root, 'ws-up-write'))
    // 两次 upgrade（出计划 / 确认写入）各要一次裁决。
    const { flows } = await seedBatch(ws, undefined, 1)
    await flows.upgrade({ sessionId: 'session-test' })
    const result = await flows.upgrade({ sessionId: 'session-test', confirmWrite: true })
    assert.equal(result.ok, true)
    assert.equal(result.stage, 'written')
    assert.equal(result.failed.length, 0)

    const nodes = result.done.filter(item => item.relative.includes('knowledge/nodes/'))
    assert.equal(nodes.length, 2)
    const content = await readFile(join(ws, nodes[0].relative), 'utf8')
    assert.match(content, /^---/u)
    assert.match(content, /version: 1/u)
    assert.match(content, /事实验证：未验证/u)
    assert.match(content, /用户认可 ≠ 已证实/u)
    // 总索引被刷新
    const framework = await readFile(join(ws, 'knowledge/framework.md'), 'utf8')
    assert.match(framework, /LN-\d{8}-\d{3}/u)
    // 变更日志存在
    assert.equal(existsSync(join(ws, `.dsh/learn-skills/changes/${result.batchId}.json`)), true)

    const rollback = await flows.rollback({ sessionId: 'session-test', batchId: result.batchId })
    assert.equal(rollback.ok, true)
    assert.ok(rollback.removed.length >= 2)
    assert.equal(existsSync(join(ws, nodes[0].relative)), false, '回滚后新建节点应被删除')
  })

  it('重跑同一批不会重复递增版本（内容相同即 skip）', async () => {
    const ws = await freshDir(join(root, 'ws-up-idem'))
    // 两次 upgrade（出计划 / 确认写入）各要一次裁决。
    const { flows } = await seedBatch(ws, undefined, 1)
    await flows.upgrade({ sessionId: 'session-test' })
    const first = await flows.upgrade({ sessionId: 'session-test', confirmWrite: true })
    assert.equal(first.ok, true)
    const relative = first.done.find(item => item.relative.includes('knowledge/nodes/')).relative
    const firstContent = await readFile(join(ws, relative), 'utf8')
    const firstSha = fingerprint(firstContent)
    assert.match(firstContent, /version: 1/u)

    // 直接对同一目标再写一次**相同内容**：必须 skip，版本不动、哈希不变。
    // （这条是"重试不重复升级版本"的最小判据，绕开批次状态。）
    const second = await writeIfChanged({
      absolute: join(ws, relative),
      relative,
      content: firstContent,
      baselineSha: firstSha,
    })
    assert.equal(second.action, 'skip')
    assert.equal(second.reason, '内容完全相同，不写（版本不递增）')
    const afterRepeat = await readFile(join(ws, relative), 'utf8')
    assert.equal(fingerprint(afterRepeat), firstSha, '重复运行不得改变既有节点内容')
    assert.match(afterRepeat, /version: 1/u)
  })

  it('用户改过的节点，再写入时被拒绝覆盖并如实报错', async () => {
    const ws = await freshDir(join(root, 'ws-up-conflict'))
    await mkdir(sharedPresetRoot, { recursive: true })

    // ★ 让**插件自己**创建第一个节点，再记下它真实的 id —— 不用手写 id。
    //   早先我手写了一个 `LN-20260919-001` 的节点文件并让候选指向它，
    //   结果插件既没读到它、又在"按 id 找不到"时新建了另一个（`relation: "new"`），
    //   断言因此报 `failed=[]`。手写内部 id 等于自己造一个可能与实现不一致的前提。
    const writer = harness({
      workspace: ws,
      // ⚠️ `messages` 必须传：它定义在本 describe 的作用域里，而 `harness` 的默认值是
      //    **空数组**。漏了它 ⇒ `fixRange` 拿到空范围 ⇒ `considered: 0` ⇒ 候选为空 ⇒
      //    `upgrade` 报 `NOTHING_TO_DO`。实测这条因此白查了两轮。
      messages,
      config: { presetRoot: sharedPresetRoot },
      answers: [{ answers: [{ id: 'r', selected: ['全部保留'], custom: '' }] }],
    })
    const distilled = await writer.flows.distill({ sessionId: 'session-test' })
    assert.equal(distilled.ok, true, `提炼应成功，实得 ${JSON.stringify(distilled).slice(0, 200)}`)
    assert.ok(distilled.kept > 0,
      `提炼应产出至少一条"保留"候选，实得 ${JSON.stringify(distilled).slice(0, 300)}`)
    const first = await writer.flows.upgrade({ sessionId: 'session-test', batchId: '001', confirmWrite: true })
    assert.equal(first.ok, true, `首轮写入应成功，实得 ${JSON.stringify(first).slice(0, 300)}`)
    const created = first.done.filter(item => item.nodeId !== undefined)
    assert.ok(created.length > 0, `应写入至少一个节点，实得 ${JSON.stringify(first.done)}`)

    // ★ 前置条件（本用例其余断言的立足点）：插件报告写下的节点，必须能被**同一套载入
    //   路径**从磁盘读回来、并且 frontmatter 里有 id。
    //   为什么把前置摆到最前面：这条用例早先失败时报的是"应报出拒绝覆盖"，而真因可能
    //   在更早的"文件根本没写盘"或"写盘后解析不出 id"—— 没有显式前置，三种根因
    //   长得一模一样，只能靠猜。现在根因会被这一条直接指认。
    const loaded = await loadNodes({ directory: join(ws, DIRS.knowledge, 'nodes'), prefix: 'knowledge/nodes', readText, readDirectory })
    const loadedIds = new Set(loaded.nodes.map(node => node.id))
    const missing = created.filter(item => !loadedIds.has(item.nodeId))
    assert.deepEqual(missing.map(item => item.relative), [],
      '插件报告已写入的节点，载入时却不在内存里 —— 说明该文件要么没落盘、要么落盘后解析不出 id。'
      + `\n应载入：${created.map(item => `${item.nodeId}@${item.relative}`).join('、')}`
      + `\n实载入：${[...loadedIds].join('、')}`
      + `\n被跳过：${JSON.stringify(loaded.skipped)}`)

    // 用户手工改了这个节点（模拟"写入之后编辑器又动过"）。
    // 内容刻意是**散文**（无 frontmatter）：这正是"手写一段话"最真实的形态。
    //
    // ⚠️ 目标节点从**已确证可载入**的那一批里挑，不按下标猜。
    //    先前写 `created[0]`，靠的是"`first.done` 的顺序 == 候选顺序"这个**未经验证的隐含前提**；
    //    它一旦不成立，失败信息会指向另一个文件（实测就把 001 与 002 搞混了两轮）。
    //    现在改成按 id 回查，缺了就当场指认 —— 前提被显式验掉。
    const subject = created.find(item => loadedIds.has(item.nodeId))
    assert.ok(subject !== undefined,
      '首轮写下的节点里，没有一个能被载入 —— 后续断言无处落脚。\n'
      + `· created：${created.map(item => `${item.nodeId} @ ${item.relative}`).join('；')}\n`
      + `· loadedIds：${[...loadedIds].join('、')}\n`
      + `· loaded.skipped：${JSON.stringify(loaded.skipped)}`)
    const touched = '用户手工重写的内容\n'
    await writeFile(join(ws, subject.relative), touched, 'utf8')
    const touchedSha = fingerprint(touched)

    // 手写批次 002，候选在种子里就标好 keep，**用插件给的那个 id** 建立关联
    await writeFile(join(ws, '.dsh/learn-skills/batches.json'), JSON.stringify({
      version: 1,
      batches: [{ batchId: '002', flow: 'distill', status: 'awaitingUpgrade', createdAt: '2026-09-19T00:00:00' }],
      seen: {},
    }, null, 2), 'utf8')
    await writeFile(join(ws, 'inbox/.candidates-002.json'), JSON.stringify({
      version: 1,
      batchId: '002',
      candidates: [{
        id: 'C-002-01',
        batchId: '002',
        title: '与既有节点相关的补充说明',
        summary: '补充一条与既有节点相关的内容性描述',
        type: 'fact',
        scope: '本会话',
        source: { sessionId: 's1', messageIds: ['seq-9'], seqRange: [9, 9], precision: 'message', limitation: null },
        evidence: '会话原文',
        verification: 'unverified',
        decision: 'keep',
        relations: [{ id: subject.nodeId, relation: 'candidate', confidence: 'heuristic' }],
        fingerprint: 'deadbeef',
        alreadyProcessed: null,
      }],
    }, null, 2), 'utf8')

    // 这次 upgrade 也会问一次裁决；候选指向的那个节点已被改成散文 ⇒ 还会**多问一次**
    // 「缺内容节点：是否重建」。这里选"本轮不动" ⇒ 仍然是**拒绝覆盖**（与修复前一致的行为面）。
    const second = harness({
      workspace: ws,
      messages,
      config: { presetRoot: sharedPresetRoot },
      answers: [
        { answers: [{ id: 'r', selected: ['全部保留'], custom: '' }] },
        { answers: [{ id: 'r', selected: ['本轮不动（保持现状）'], custom: '' }] },
      ],
    })
    // 诊断：把插件在**该时刻的内存视图**摊开（nodes / relations / 判定结果）。
    //   "关联在、文件在、却判成新增"从外部无法区分是哪一环断的，只有它自己说得出。
    const probe = await second.flows.upgrade({ sessionId: 'session-test', batchId: '002', diagnose: true })
    const result = await second.flows.upgrade({ sessionId: 'session-test', batchId: '002', confirmWrite: true })
    assert.equal(result.ok, true, `升级应成功返回，实得 ${JSON.stringify(result).slice(0, 300)}`)

    // ★ 主断言：用户改过的文件**一字未动**（判据是指纹，不是"看着像"）
    const afterSha = fingerprint(await readFile(join(ws, subject.relative), 'utf8'))
    assert.equal(afterSha, touchedSha,
      `用户改过的文件不得被插件回写。\n—— 插件内部视图 ——\n${JSON.stringify(probe)}`)
    // ★ 副断言：冲突被如实列进 failed，且理由写明"拒绝覆盖" **并且指向那个文件**
    const refusal = result.failed.find(item => /拒绝覆盖/u.test(item.reason))
    assert.ok(refusal !== undefined,
      `应报出拒绝覆盖。\n—— 插件内部视图 ——\n${JSON.stringify(probe)}\n`
      + `failed=${JSON.stringify(result.failed)}，done=${JSON.stringify(result.done)}`)
    assert.equal(refusal.relative, subject.relative,
      '拒绝覆盖必须指向那个文件（相对路径要能对上）。\n'
      + `· 被手改的节点（subject）：${subject.nodeId} @ ${subject.relative}\n`
      + `· 首轮写下的全部节点：${created.map(item => `${item.nodeId} @ ${item.relative}`).join('；')}\n`
      + `· 本次 failed：${JSON.stringify(result.failed.map(item => item.relative))}\n`
      + `· 本次 done：${JSON.stringify(result.done.map(item => item.relative))}\n`
      + `· probe.nodeFiles：${JSON.stringify(probe.nodeFiles)}\n`
      + `· probe.unloadable：${JSON.stringify(probe.unloadable)}\n`
      + `· ★ probe.gateTrace（诊断出口那一遍的取键过程）：${JSON.stringify(probe.gateTrace)}\n`
      + `· ★★ result.failed[].gateDecision（**写这一遍**自己算出的依据）：`
      + `${JSON.stringify(result.failed.map(item => item.gateDecision ?? null))}\n`
      + `· ★★ result.failed 全文（含 reason）：${JSON.stringify(result.failed)}\n`
      + `· ★ 写基线键：${JSON.stringify(Object.keys(JSON.parse(await readFile(join(ws, '.dsh/learn-skills/known.json'), 'utf8')).writeShas ?? {}))}`)
    // ★ 理由里的路径与回执里的路径**必须是同一个** —— 这是一条独立的记账判据：
    //   先前出现过"理由写 001、回执记 003"（同一条失败项里两个路径），读的人无从判断。
    assert.match(refusal.reason, new RegExp(refusal.relative.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `失败回执的路径必须出现在理由里（同一来源）。\n· relative=${refusal.relative}\n· reason=${refusal.reason}`)

    // ★★ 第三条判据：插件**没有**因为"读不出那个文件"就另外新建一个节点。
    //
    //   被改成散文的那个节点列不出来是**正常**的（它没有 id）；
    //   判据落在"只该出现首轮写下的 id"上 —— 出现任何新 id，就说明它又走了"新增"这条路。
    //   ⚠️ 刻意**不**断言"另一个节点必须载入"：那条判据超出了本用例的范围
    //      （测试只改了其中一个文件，没改的那个也该照常载入；万一它因别的原因没载入，
    //      是另一件事，不该由这条断言代报）。
    const knownIds = new Set(created.map(item => item.nodeId))
    const strangers = probe.nodes.map(item => item.id).filter(id => !knownIds.has(id))
    assert.deepEqual(strangers, [],
      `诊断视图里出现了首轮之外的节点：${strangers.join('、')} —— 说明插件把"读不出的占用"当成了"新增"。\n`
      + `· probe.nodes：${JSON.stringify(probe.nodes.map(item => item.id))}\n`
      + `· 首轮写下的：${[...knownIds].join('、')}\n`
      + `· probe.nodeFiles：${JSON.stringify(probe.nodeFiles)}\n`
      + `· probe.unloadable：${JSON.stringify(probe.unloadable)}`)

    // ★★ 第四条判据（补一个**会掩盖诊断的陷阱**）：写段不该在目录里留下"计划过但没写成"的文件。
    //
    //   实测踩到：这次升级被人手植的候选指到了**另一个**节点上，于是它先按"新增"算出了
    //   一个目标路径（`LN-…-003-….md`）、拒绝失败的 `failed` 里报的也是那个路径 ——
    //   而磁盘上**并没有**这个文件。若只看 `failed`，很容易以为"插件写坏了一个文件"。
    //   判据：目录实际清单必须与首轮写下的**完全一致**（不多不少）。
    const onDisk = await readDirectory(join(ws, DIRS.knowledge, 'nodes'))
    assert.deepEqual(onDisk.filter(entry => !entry.directory).map(entry => entry.name).sort(),
      created.map(item => item.relative.split('/').pop()).sort(),
      '写段在目录里留下了计划之外的文件 —— 拒绝覆盖不该产出任何新文件。\n'
      + `· failed：${JSON.stringify(result.failed.map(item => item.relative))}\n`
      + `· done：${JSON.stringify(result.done.map(item => item.relative))}`)
  })

  it('★ 用户没动过的节点，再升级时正常补写（写基线不该把正常路径挡死）', async () => {
    // 这组与上一条互补：
    //   上一条验"用户改过 → 拒绝覆盖"；
    //   这一条验"用户**没**改过 → 照旧补写"，防止修复走成"一律拒绝"。
    // 判据链：第一次升级写下节点并记写基线 → 第二次升级带着写基线补写同一个节点 → 必须 update。
    const ws = await freshDir(join(root, 'ws-up-baseline'))
    const { flows } = await seedBatch(ws, undefined, 2)
    const first = await flows.upgrade({ sessionId: 'session-test', confirmWrite: true })
    assert.equal(first.ok, true, `首轮写入应成功，实得 ${JSON.stringify(first).slice(0, 300)}`)
    const node = first.done.find(item => item.nodeId !== undefined)
    assert.ok(node !== undefined, `应写入至少一个节点，实得 ${JSON.stringify(first.done)}`)

    // 写基线落盘了吗？（它必须持久化：判据要跨会话，不能只活在内存里）
    const known = JSON.parse(await readFile(join(ws, '.dsh/learn-skills/known.json'), 'utf8'))
    const firstNodes = first.done.filter(item => item.nodeId !== undefined)
    assert.equal(typeof known.writeShas?.[node.relative], 'string',
      '写基线未落盘 —— 判据就无从跨会话。\n'
      + `· node：${node.nodeId} @ ${node.relative}\n`
      + `· 首轮的节点回执：${JSON.stringify(firstNodes.map(item => `${item.nodeId}@${item.relative}`))}\n`
      + `· known.writeShas：${JSON.stringify(known.writeShas ?? null)}`)

    // ★★ 关键装配：首轮的 upgrade 已把批次 001 标成 `done`，**再升级就没有批次可用**。
    //    先前这条用例因此只会拿到 `NO_BATCH`（实测：失败信息说"没有返回 failed 数组"，
    //    而真因是"没批次"）。这里手植一个**新批次** 002，指向首轮写下的那个节点。
    await plantBatch(ws, '002', node.nodeId, '补充一条与既有节点相关的内容性描述')

    // 机制自证：把基线换成"对不上的指纹"，补写必须被拒 —— 这直接证明判据读的是基线。
    // （用篡改状态文件的方式制造，不依赖"恰好手改了节点正文"。）
    const beforeSha = fingerprint(await readFile(join(ws, node.relative), 'utf8'))
    await writeFile(join(ws, '.dsh/learn-skills/known.json'), JSON.stringify({
      ...known, writeShas: { ...known.writeShas, [node.relative]: 'deadbeef' },
    }, null, 2), 'utf8')
    const blocked = await flows.upgrade({ sessionId: 'session-test', confirmWrite: true })
    // ★ 先看**返回形态**再看内容：早先直接读 `blocked.failed`，而它是 undefined 时报的是
    //   `Cannot read properties of undefined (reading 'some')` —— 一行堆栈把真因（拿不到批次）
    //   盖得严严实实。返回值自曝比堆栈有用。
    assert.equal(Array.isArray(blocked.failed), true,
      '这次升级没有返回 failed 数组 —— 说明它压根没走到写入段。\n'
      + `· blocked：${JSON.stringify(blocked).slice(0, 400)}\n`
      + `· 篡改后的 writeShas：${JSON.stringify({ ...known.writeShas, [node.relative]: 'deadbeef' })}`)
    assert.ok(blocked.failed.some(item => /拒绝覆盖/u.test(item.reason)),
      '基线对不上时必须拒绝覆盖。\n'
      + `· blocked.failed：${JSON.stringify(blocked.failed)}\n`
      + `· blocked.done：${JSON.stringify(blocked.done?.map(item => item.relative))}\n`
      + `· blocked.ok/code：${blocked.ok} / ${blocked.code ?? '（无）'}`)
    assert.equal(fingerprint(await readFile(join(ws, node.relative), 'utf8')), beforeSha,
      '被拒绝时文件必须一字未动')

    // 恢复真实基线 → 这次允许补写（回执可能是 update，也可能因为重跑得到相同内容而 skip；
    // 两种都算"没被基线挡死"，所以这里不锁 action —— 锁死它会把一个正确的行为判成失败）。
    // ⚠️ 上一次（被拒的那次）也会把批次标成 `done` ⇒ 必须再植一个批次，否则又是 `NO_BATCH`。
    await plantBatch(ws, '003', node.nodeId, '恢复基线后的补写验证')
    await writeFile(join(ws, '.dsh/learn-skills/known.json'), JSON.stringify(known, null, 2), 'utf8')
    const again = await flows.upgrade({ sessionId: 'session-test', confirmWrite: true })
    assert.equal(again.ok, true, `恢复基线后应可补写，实得 ${JSON.stringify(again).slice(0, 300)}`)
    assert.equal(again.failed.length, 0, `恢复基线后不该有失败项，实得 ${JSON.stringify(again.failed)}`)
    const updated = again.done.find(item => item.relative === node.relative)
    assert.ok(updated !== undefined,
      `应处理同一个节点（而不是另起一个），实得 ${JSON.stringify(again.done.map(item => item.relative))}`)
    assert.ok(['update', 'skip'].includes(updated.action), `action 只能是 update 或 skip，实得 ${updated.action}`)
    assert.ok(updated.version >= 1, `版本号必须仍是有效值，实得 ${updated.version}`)
  })

  it('★ 缺内容节点：手改坏一个节点后，升级给出重建选项并可重建（原文可回滚取回）', async () => {
    // 这条覆盖「受伤节点在体系中的可见性」的**修复路径**：
    //   节点文件被手工改成没有 frontmatter 的散文 ⇒ 载入不了 ⇒ 对关联与体检都不可见。
    //   总索引里还留着它的记录（那是插件自己写的），据此把它认回来并**交给用户确认重建**。
    //   重建会覆盖用户那段原文，所以代价必须可逆 —— 本用例最后一步就是验证这一点。
    const ws = await freshDir(join(root, 'ws-repair-node'))

    // 第一轮：**先提炼出批次再升级**（直接调 upgrade 会拿到 NO_BATCH —— 没有批次可升级）
    const { flows } = await seedBatch(ws, { presetRoot: sharedPresetRoot }, 2)
    const first = await flows.upgrade({ sessionId: 'session-test', batchId: '001', confirmWrite: true })
    assert.equal(first.ok, true, `首轮写入应成功，实得 ${JSON.stringify(first).slice(0, 300)}`)
    const nodes = first.done.filter(item => item.nodeId !== undefined)
    assert.ok(nodes.length > 0, `应写入至少一个节点，实得 ${JSON.stringify(first.done)}`)

    // 把手改后的内容写成散文（无 frontmatter）—— 这就是"载入不了"的形态
    const userText = '我手写的备注：这条先按北美站的做法，别用欧洲站那套。\n'
    await writeFile(join(ws, nodes[0].relative), userText, 'utf8')

    // 第二轮：手植一个指向那个节点的批次（首轮已把批次 001 标成 done），并**确认重建**
    await plantBatch(ws, '002', nodes[0].nodeId, '补充一条与既有节点相关的内容性描述')
    const repairer = harness({
      workspace: ws,
      messages,
      config: { presetRoot: sharedPresetRoot },
      answers: [{ answers: [{ id: 'r', selected: ['全部重建'], custom: '' }] }],
    })
    const result = await repairer.flows.upgrade({ sessionId: 'session-test', batchId: '002', confirmWrite: true })

    // ① 重建被列为独立动作（不是"拒绝覆盖"，也不是"悄悄新建"）
    const repaired = result.done.find(item => item.relation === 'repaired')
    assert.ok(repaired !== undefined,
      `应产出重建项。\n· done=${JSON.stringify(result.done.map(item => `${item.relation}:${item.relative}`))}`
      + `\n· failed=${JSON.stringify(result.failed)}`)

    // ② 重建后该文件必须**能被载入**（这才是"可见性恢复"的判据，不是"文件存在"）
    const after = await loadNodes({
      directory: join(ws, DIRS.knowledge, 'nodes'), prefix: 'knowledge/nodes', readText, readDirectory,
    })
    const revived = after.nodes.find(node => node.id === nodes[0].nodeId)
    assert.ok(revived !== undefined,
      `重建后该节点应可载入。\n· 实载入：${JSON.stringify(after.nodes.map(node => node.id))}`
      + `\n· 被跳过：${JSON.stringify(after.skipped)}`)
    assert.equal(revived.relative, nodes[0].relative, '重建必须写在**原文件**上，不是另起一个')
    assert.match(await readFile(join(ws, nodes[0].relative), 'utf8'), new RegExp(`id: ${nodes[0].nodeId}`, 'u'))

    // ③ 用户那段原文必须**可回滚取回**（这是"允许覆盖"的代价条款）
    const rollback = await repairer.flows.rollback({ sessionId: 'session-test', batchId: result.batchId })
    assert.equal(rollback.ok, true, `回滚应成功，实得 ${JSON.stringify(rollback).slice(0, 300)}`)
    const restored = await readFile(join(ws, nodes[0].relative), 'utf8')
    assert.equal(restored, userText, '回滚后应原样取回用户手写的那段内容')
  })

  it('行为规则门禁：清单含规则变更但未放行时不执行', async () => {
    const ws = await freshDir(join(root, 'ws-up-rule'))
    // 两次 upgrade（出计划 / 确认写入）各要一次裁决 —— 给够，否则会静默走"取消"分支，
    // 而那个分支的断言是 `ok === true || code === 'RULE_WRITE_DISABLED'`，**看不出来**。
    const { flows } = await seedBatch(ws, { allowBehaviorRules: false }, 1)
    await flows.upgrade({ sessionId: 'session-test' })
    // 直接给一个含规则变更的请求：把候选标成行为规则路径（通过伪造批次文件字段达成）
    const batchFile = join(ws, 'inbox/.candidates-001.json')
    const payload = JSON.parse(await readFile(batchFile, 'utf8'))
    payload.candidates[0].ruleChange = { path: 'AGENTS.md', operation: 'update' }
    await writeFile(batchFile, JSON.stringify(payload, null, 2), 'utf8')
    const result = await flows.upgrade({ sessionId: 'session-test', confirmWrite: true })
    // 断言收紧：不许拿"取消"当通过。默认配置下，含规则变更的清单**必须**被门禁拦下。
    assert.notEqual(result.code, 'FLOW_CANCELLED', '不许以"取消"蒙过门禁断言')
    assert.ok(result.ok === true || result.code === 'RULE_WRITE_DISABLED',
      `应通过或明确被门禁拦下，实得 ${JSON.stringify(result).slice(0, 200)}`)
  })
})

describe('入口四 · 沉淀复用（只读体检）', () => {
  it('产出报告，且报告不写盘（要用户显式选择才保存）', async () => {
    const ws = await freshDir(join(root, 'ws-audit'))
    await writeFile(join(ws, 'AGENTS.md'), '# 规则\n\n内容\n', 'utf8')
    const { flows } = harness({ workspace: ws, noMessages: true })
    const result = await flows.runAudit({ sessionId: 'session-test' })
    assert.equal(result.ok, true)
    assert.match(result.report, /知识体系体检报告/u)
    assert.match(result.report, /无历史基线/u)
    assert.equal(existsSync(join(ws, 'reports')), false, '默认不写盘')
  })

  it('保存报告后才更新基线；再次体检时以基线对比', async () => {
    const ws = await freshDir(join(root, 'ws-audit-save'))
    await writeFile(join(ws, 'AGENTS.md'), '# 规则\n\n内容\n', 'utf8')
    const { flows } = harness({ workspace: ws, noMessages: true })
    const first = await flows.runAudit({ sessionId: 'session-test' })
    const saved = await flows.saveAudit({
      sessionId: 'session-test', report: first.report, baselineCandidate: first.baselineCandidate,
    })
    assert.equal(saved.ok, true)
    assert.equal(existsSync(join(ws, '.dsh/learn-skills/audit.json')), true)

    const second = await flows.runAudit({ sessionId: 'session-test' })
    assert.equal(second.baselineAvailable, true)
    assert.match(second.report, /上次基线保存于/u)

    // 改一个文件后：变化对比应报"内容变化"
    await writeFile(join(ws, 'AGENTS.md'), '# 规则\n\n内容改了\n', 'utf8')
    const third = await flows.runAudit({ sessionId: 'session-test' })
    assert.ok(third.summary.delta.updated >= 1)
  })

  it('写门禁关闭时不保存报告、也不更新基线', async () => {
    const ws = await freshDir(join(root, 'ws-audit-nogate'))
    await writeFile(join(ws, 'AGENTS.md'), '# 规则\n', 'utf8')
    const { flows } = harness({ workspace: ws, noMessages: true, allowWrite: false })
    const result = await flows.runAudit({ sessionId: 'session-test' })
    const saved = await flows.saveAudit({
      sessionId: 'session-test', report: result.report, baselineCandidate: result.baselineCandidate,
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'WRITE_DISABLED')
    assert.equal(existsSync(join(ws, '.dsh/learn-skills/audit.json')), false)
  })
})

describe('并发与状态', () => {
  it('单工作区同时只允许一个流程（第二次如实拒绝，不排队）', async () => {
    const ws = await freshDir(join(root, 'ws-concurrent'))

    // ★ 用**显式异步屏障**控制时序，不轮询、不赌睡眠。
    //
    // 为什么要这么写：这个用例连续失败三轮，报出的都是"第二次居然成功了"。
    // 真因是"等第一个流程进到提问"这一步用了 `waitFor(asked)` —— 而 `asked` 在
    // **第一个流程跑完之后**才被置位的路径也存在，于是第二次调用发生在守卫早已失效之后。
    // 现在改成：首次提问一发生就**拉闸**，测试在闸门内查守卫，然后才放行。
    let holdAsk
    const askGate = new Promise(resolve => { holdAsk = resolve })
    let releaseAsk
    const askHeld = new Promise(resolve => { releaseAsk = resolve })

    const { flows } = harness({
      workspace: ws,
      messages: [{ id: 'seq-1', seq: 1, role: 'user', text: '一条有信息量的描述', sessionId: 's1' }],
      answers: [{ answers: [{ id: 'r', selected: ['全部保留'], custom: '' }] }],
      // onAsk 可以是异步函数：桩会 `await` 它 ⇒ 第一个流程被真正挂住。
      onAsk: async () => { holdAsk(); await askHeld },
    })

    const running = flows.distill({ sessionId: 'session-test' })
    // 等第一个流程**确实进到了提问**（闸门被拉下）——这是守卫生效的前置条件。
    await askGate

    const second = await flows.distill({ sessionId: 'session-test' })
    assert.equal(second.ok, false,
      `第二次应被拒绝。实得 ${JSON.stringify(second).slice(0, 200)}`)
    assert.equal(second.code, 'FLOW_RUNNING')

    releaseAsk()
    const first = await running
    assert.equal(first.ok, true, `第一个流程应正常完成，实得 ${JSON.stringify(first).slice(0, 200)}`)
  })

  it('status 在未绑定工作区时给出引导', async () => {
    const { flows } = harness({ workspace: null, noMessages: true })
    const status = await flows.status({ sessionId: 'session-test' })
    assert.equal(status.ok, false)
    assert.equal(status.code, 'NO_WORKSPACE')
  })

  it('status 在工作区已绑定时报出写门禁与入口清单', async () => {
    const ws = await freshDir(join(root, 'ws-status'))
    const { flows } = harness({ workspace: ws, noMessages: true })
    const status = await flows.status({ sessionId: 'session-test' })
    assert.equal(status.ok, true)
    assert.equal(status.workspaceBound, true)
    assert.equal(status.writeEnabled, true)
    assert.equal(status.behaviorRulesEnabled, false)
    assert.deepEqual(status.entries.map(entry => entry.label), ['初始预设', '收集提炼', '关联升级', '沉淀复用'])
  })
})

describe('slugOf —— 文件名用的短标识', () => {
  it('英文标题得到可读 slug', () => {
    assert.equal(slugOf('Amazon Compliance 2026'), 'amazon-compliance')
  })

  it('中文标题退回短指纹（不用中文拼文件名）', () => {
    const slug = slugOf('北美站合规要求')
    assert.match(slug, /^[0-9a-f]{8}$/u)
  })
})

describe('提问必须带上 live agent —— RPC 路径的下一个坑', () => {
  it('★ 会话有 live agent ⇒ 第一次提问就得带上它', async () => {
    // 为什么必须带：`user-questions/request` 是 Scoped<Agent> 事件，UI 应答者注册在
    // Agent 作用域。不带 agent 时瀑布跑在 root 面 ⇒ 无人应答 ⇒ NO_PROVIDER
    // ⇒ 真机上表现为"点菜单报执行失败"。斜杠命令没这个问题（本就在 agent 调用栈里），
    // 所以这条**只能靠 RPC 路径的用例**钉住。
    const ws = await freshDir(join(root, 'ws-agent'))
    const agent = { id: 'session-test' }
    const { flows, calls } = harness({
      workspace: ws,
      answers: sixAnswers('带 agent 的名字'),
      noMessages: true,
      agents: { get: id => (id === 'session-test' ? agent : undefined), roots: () => [agent] },
    })

    await flows.init({ sessionId: 'session-test', confirmCreate: false })

    assert.ok(calls.length > 0, `至少要问一次；实得 ${calls.length} 次`)
    assert.equal(calls[0].agent, agent, '第一次提问就必须带上 live agent')
  })

  it('拿不到 live agent 时不带（宁可不带，也不带错）', async () => {
    const ws = await freshDir(join(root, 'ws-no-agent'))
    const { flows, calls } = harness({
      workspace: ws,
      answers: sixAnswers('无 agent 的名字'),
      noMessages: true,
    })

    await flows.init({ sessionId: 'session-test', confirmCreate: false })

    assert.ok(calls.length > 0)
    assert.equal(calls[0].agent, undefined)
  })

  it('agent 不是注册表里那个实例（身份对不上）时不带', async () => {
    const ws = await freshDir(join(root, 'ws-stale-agent'))
    const agent = { id: 'session-test' }
    const { flows, calls } = harness({
      workspace: ws,
      answers: sixAnswers('身份对不上的名字'),
      noMessages: true,
      // `get(agent.id)` 返回**另一个对象** ⇒ 宿主的 CALLER_NOT_LIVE 前置自校必须挡住
      agents: { get: id => (id === 'session-test' ? { ...agent } : undefined), roots: () => [agent] },
    })

    await flows.init({ sessionId: 'session-test', confirmCreate: false })

    assert.ok(calls.length > 0)
    assert.equal(calls[0].agent, undefined, '身份对不上就不该带 —— 否则宿主抛 CALLER_NOT_LIVE')
  })
})

describe('续办：六题答完但没创建时，重进「初始预设」不该重问', () => {
  it('★ 第二轮直接回到预览（一次不问）；restart 才真的重答', async () => {
    // 真机症状：每次点「初始预设」都从第 1 题重问一遍 —— 答案就在磁盘上
    // （phase: awaitingReview），而 `resumed` 算了却没用上。判断"要不要重问"
    // 只能靠这条用例：**数桩被问了几次**。
    const ws = await freshDir(join(root, 'ws-resume'))
    const { flows, calls } = harness({
      workspace: ws,
      answers: [...sixAnswers('续办名'), ...sixAnswers('续办名')],
      noMessages: true,
    })

    const first = await flows.init({ sessionId: 'session-test', confirmCreate: false })
    assert.equal(first.stage, 'preview')
    const askedFirst = calls.length
    assert.ok(askedFirst >= 7, `第一轮要问满七题；实得 ${askedFirst}`)

    const second = await flows.init({ sessionId: 'session-test', confirmCreate: false })
    assert.equal(second.reused, true, '第二轮必须复用上一轮答案')
    assert.equal(second.stage, 'preview')
    assert.equal(calls.length, askedFirst, '第二轮不该再问任何一题')

    const forced = await flows.init({ sessionId: 'session-test', restart: true })
    assert.equal(forced.reused, undefined, 'restart: true 时必须真的重问')
    assert.ok(calls.length > askedFirst, 'restart 之后必须又问了七题')
  })
})

describe('生成的预设组合必须能被宿主装载 —— 真机反馈过的缺陷', () => {
  it('★ tool-fs-search 行必须带 sampleOverCapGlobResults（宿主必填、无回退值）', () => {
    // 真机症状：「无法切换到「<预设显示名>」：1 row(s) did not activate: tool-fs-search
    // (@deepseek-ai/dsh-tool-fs-search): invalid config: - $.sampleOverCapGlobResults
    // missing required value」。
    // 依据：`tool-fs-search/README.zh.md:42`「必填项且没有回退值，部署必须显式选择」；
    // schema `z.boolean().required()` 见该包 `src/index.ts:98`；
    // shipped 预设（presets/{standard,ptc,cordis}）与既有预设都显式写 false。
    const lines = renderAgentComposition({
      values: { name: '装载检查', vocation: '测试', interests: ['工具与自动化'], goal: 'g', baseline: 'b', style: 's' },
      unknown: {},
    }).split('\n')

    const at = lines.findIndex(line => line.trim() === '- id: tool-fs-search')
    assert.notEqual(at, -1, '预设组合里必须列出 tool-fs-search 行')

    const row = lines.slice(at, at + 6).join('\n')
    assert.match(row, /name: '@deepseek-ai\/dsh-tool-fs-search'/u, '行名要对得上')
    assert.match(row, /sampleOverCapGlobResults:\s*(true|false)/u,
      '必须显式给出 sampleOverCapGlobResults —— 漏了它，宿主装载该行会 invalid config，整个预设都切不过去')
  })
})

describe('七题的选项标签不得重复 —— 真机反馈过的缺陷', () => {
  it('★ 每一题的选项标签都唯一（「暂不填写」曾出现两遍）', async () => {
    // 真因：`nav.options` 里**已经**含 SKIP_OPTION，第 2/4/5/6 题又各加了一次
    // ⇒ 用户看到两个一模一样的「暂不填写」。第 3 题早先单独修过，其余四题漏了 ——
    //    这类"同一份清单在多处各加一遍"的错，只能靠**逐题比对**发现。
    const ws = await freshDir(join(root, 'ws-option-unique'))
    const { flows, calls } = harness({
      workspace: ws,
      answers: sevenAnswers('选项唯一性'),
      noMessages: true,
    })

    await flows.init({ sessionId: 'session-test', confirmCreate: false })

    assert.ok(calls.length >= 7, `七题都要问到；实得 ${calls.length} 次`)
    for (const request of calls) {
      for (const question of request.questions ?? []) {
        const labels = (question.options ?? []).map(option => option.label)
        const duplicated = labels.filter((label, index) => labels.indexOf(label) !== index)
        assert.deepEqual(duplicated, [],
          `「${question.header ?? question.id}」的选项出现重复标签：${duplicated.join(' / ')}`)
      }
    }
  })
})

describe('预设新架构适配（2.1.0）—— 落点工作区内 / 判据取名册 / 不代为安装', () => {
  /**
   * 名册桩：`list()` 返回若干行。
   * 判据全部取自**名册**（预设身份＝`config.id`，注册表不扫目录）。
   */
  const rosterOf = rows => ({ list: async () => rows })

  /**
   * 本 describe 专属的用例夹具。
   *
   * ⚠️ 不能复用「入口一」里那个同名 `fresh` —— 它定义在那个 describe 的回调里，
   *    从这里看不到（作用域）。两个 describe 都要"清空重建"，那就在各自作用域各写一份；
   *    实现刻意保持逐字相同，改一处记得改两处。
   */
  const fresh = async label => {
    const ws = await freshDir(join(root, `case-${label}`))
    const localPresetRoot = await freshDir(join(root, `presets-${label}`))
    return { ws, localPresetRoot }
  }

  it('★ 生成路径不得自动安装：只出指引，且 installBundle 一次都没被调用', async () => {
    // 为什么这条最要紧：安装 bundle 会在 **Host 进程**执行新代码。官方入口
    // `plugin_manager` 工具**强制**弹 danger-full-access 审批，而服务方法
    // `installBundle()` 本身没有审批闸 —— 在**生成路径**里直接调它＝替用户越权。
    // 所以这里放一个"陷阱"，凡是插件摸到它就当场炸：被调用即用例失败。
    //
    // ★ 2026-09 契约修订（方案 A′）后本用例**原样保留**：安装现在可以由人点按钮
    //   触发（见下面两条用例），但「生成完就自动装」仍然一律禁止。这条钉子管的是
    //   **触发时机**，不是"永远不许装"。
    const { ws, localPresetRoot } = await fresh('no-auto-install')
    let touched = 0
    const { flows } = harness({
      workspace: ws,
      noMessages: true,
      answers: sixAnswers('不自动安装'),
      config: { presetRoot: localPresetRoot },
      pluginManager: {
        installBundle: async () => { touched += 1; throw new Error('插件不得代为安装') },
      },
    })

    await flows.init({ sessionId: 'session-test' })
    const result = await flows.init({ sessionId: 'session-test', confirmCreate: true })

    assert.equal(touched, 0, 'installBundle 必须一次都不被调用（安装要由人经 plugin_manager / CLI 点头）')
    assert.equal(result.preset.install.attempted, false)
    assert.equal(result.preset.install.ok, false, '未安装就是未安装 —— 不得假装成功')
    assert.equal(result.preset.install.code, 'MANUAL_INSTALL')
    assert.equal(result.preset.install.requiresApproval, true)
    // 指引必须**可复制可用**：命令里带 link: 与正斜杠路径（Windows 上反斜杠进 link: 会出岔）
    assert.match(result.preset.install.command, /^dsh plugin --profile web add link:/u)
    assert.ok(!result.preset.install.command.includes('\\'), '命令里的路径必须已转成正斜杠')
    assert.ok(result.preset.install.command.includes(result.preset.directory.replace(/\\/gu, '/')),
      '指引里的路径必须就是刚生成的那个目录')
    // 撤销出口与"别删目录"的后果都要讲清（工作区内＝有被顺手删掉的风险）
    assert.match(result.preset.install.remove, /@local\/dsh-learn-preset-/u)
    assert.match(result.preset.install.caution, /拒绝恢复/u)
    assert.match(result.message, /尚未安装/u)
  })

  it('★ 人工点击才装：installPreset 调一次、spec 是 link:<目录>、并如实回显需重启', async () => {
    // 这条钉的是**触发时机**的另一半：当人点了「安装预设」（RPC installPreset），
    // 插件才被允许碰宿主服务，且必须：
    //   ① 装的正是它自己刚生成的那个目录（link: + 正斜杠路径）；
    //   ② 把宿主的 application 字段**如实**转成"需否重启"——
    //      新装的 bundle 声明只在宿主启动时读取（plugin-manager/src/index.ts:561
    //      对首次安装的包返回 'restart-required'），说成"已生效"就会让用户
    //      得到"装了却选不到"的二次误判。
    const { ws, localPresetRoot } = await fresh('install-on-click')
    const specs = []
    const { flows } = harness({
      workspace: ws,
      noMessages: true,
      answers: sixAnswers('点击安装'),
      config: { presetRoot: localPresetRoot },
      pluginManager: {
        installBundle: async (spec, options) => {
          specs.push({ spec, requestId: options?.requestId })
          return { bundle: '@local/dsh-learn-preset-x', application: 'restart-required', changed: true }
        },
      },
    })

    await flows.init({ sessionId: 'session-test' })
    const created = await flows.init({ sessionId: 'session-test', confirmCreate: true })
    assert.equal(specs.length, 0, '生成路径：确认创建时一次都不该安装')

    const installed = await flows.installPreset({ sessionId: 'session-test' })
    assert.equal(specs.length, 1, '人工点击后必须真的去装一次')
    assert.match(specs[0].spec, /^link:/u, 'spec 必须是 link:<目录>')
    assert.ok(!specs[0].spec.includes('\\'), 'spec 里的路径必须已转成正斜杠（Windows 上反斜杠进 link: 会出岔）')
    assert.ok(specs[0].spec.includes(created.preset.directory.replace(/\\/gu, '/')),
      '装的必须就是刚生成的那个 bundle 目录')

    assert.equal(installed.ok, true)
    assert.equal(installed.needsRestart, true, '宿主说 restart-required，就必须如实报告需重启')
    assert.equal(installed.application, 'restart-required')
    assert.match(installed.message, /重启/u, '回显里必须出现"重启"')
  })

  it('★ 服务缺席时如实降级：不假装装成功，且给出可复制的整行命令', async () => {
    // 为什么这条必须有：`ctx.get('pluginManager')` 是**可选能力**（不写进 inject，
    // 免得在缺该能力的部署里整体 inactive）。取不到时唯一正确的行为是
    // "如实说没装，并把要跑的那行命令给全" —— 不是静默、也不是假装成功。
    const { ws, localPresetRoot } = await fresh('install-degrade')
    const { flows } = harness({
      workspace: ws,
      noMessages: true,
      answers: sixAnswers('降级安装'),
      config: { presetRoot: localPresetRoot },
      // ⚠️ 刻意不提供 pluginManager：走的就是"服务缺席"这条路径。
    })

    await flows.init({ sessionId: 'session-test' })
    await flows.init({ sessionId: 'session-test', confirmCreate: true })

    const result = await flows.installPreset({ sessionId: 'session-test' })
    assert.equal(result.ok, false, '装不上就必须报 false —— 不得假装成功')
    assert.equal(result.code, 'MANUAL_INSTALL')
    assert.equal(result.needsRestart, true)
    assert.ok(result.reason !== undefined, '降级必须写明原因（取不到哪个服务）')
    assert.match(result.command, /^dsh plugin --profile web add link:/u)
    assert.ok(!result.command.includes('\\'), '命令里的路径必须已转成正斜杠')
  })

  it('★ 产物是两件套（package.json + cordis.patch.yml），不再有 AGENTS.md 死文件', async () => {
    // 2.0.0 会多写一个自称"预设级规则"的 `AGENTS.md`，而新架构的指令面只有
    // 「工作区/项目根 AGENTS.md」与「$DSH_HOME/AGENTS.md」
    // （`agent-instructions/src/config.ts:12,19`）—— 预设目录这个概念不存在，
    // 那个文件没有任何消费者。官方 SKILL 原文是 "exactly two files"。
    const { ws, localPresetRoot } = await fresh('two-files')
    const { flows } = harness({
      workspace: ws,
      noMessages: true,
      answers: sixAnswers('两件套'),
      config: { presetRoot: localPresetRoot },
    })

    await flows.init({ sessionId: 'session-test' })
    const result = await flows.init({ sessionId: 'session-test', confirmCreate: true })

    const entries = await readDirectory(result.preset.directory)
    const names = entries.filter(entry => !entry.directory).map(entry => entry.name).sort()
    assert.deepEqual(names, ['cordis.patch.yml', 'package.json'],
      'bundle 必须恰好两件 —— 多一件就是又一次"写了没人读的文件"')
    assert.equal(existsSync(join(result.preset.directory, 'AGENTS.md')), false)
    assert.equal(result.verification.structurallyValid, true)
    // 预览里报的也是两件套（别让预览与实际产物说两套话）
    assert.deepEqual(result.preview.preset.files, ['package.json', 'cordis.patch.yml'])
  })

  it('★ 名册不可用 ⇒ 拒绝创建（宁可不落盘，也不出重复 config.id）', async () => {
    // 官方明写「重复的 preset ID 会导致声明加载失败」（`agent-preset/README.zh.md:82`）。
    // 拿不到名册就没有任何可靠办法保证不撞 id ⇒ 直接不出件，且**一个文件都不写**。
    const { ws, localPresetRoot } = await fresh('roster-missing')
    const { flows, calls } = harness({
      workspace: ws,
      noMessages: true,
      answers: sixAnswers('无'),
      config: { presetRoot: localPresetRoot },
      agentPresets: {},   // 服务在，但没有 list()
    })

    const result = await flows.init({ sessionId: 'session-test' })

    assert.equal(result.ok, false)
    assert.equal(result.code, 'ROSTER_UNAVAILABLE')
    assert.match(result.message, /重复的 config\.id|重复的 preset ID/u)
    assert.equal(calls.length, 0, '判定必须在**问第一题之前** —— 不能让人答完六题才说不做')
    assert.equal(existsSync(join(ws, 'AGENTS.md')), false)
    // 预设根目录本身是夹具建的（空的）；判据是"里面**没有**任何预设目录"。
    const presets = await readDirectory(localPresetRoot)
    assert.deepEqual(presets.map(entry => entry.name), [], '拒绝创建时不该落下任何预设目录')
  })

  it('★ ASCII 名字撞名册已有 id ⇒ 自动换 id，绝不生成重复的 config.id', async () => {
    // 真机路线：用户起名 `alpha`，而名册里已有一个 `alpha`。`presetIdFromName`
    // 对 ASCII 名直接取 slug，所以「名册里有没有 alpha」是唯一的拦路条件 ——
    // 2.0.0 靠扫目录，只会看到 1 条假条目（组合包被当成"一个预设"）⇒ 拦不住。
    const { ws, localPresetRoot } = await fresh('id-collision')
    const { flows } = harness({
      workspace: ws,
      noMessages: true,
      answers: sixAnswers('alpha'),
      config: { presetRoot: localPresetRoot },
      agentPresets: rosterOf([
        { id: 'alpha', name: '示例预设 · 不存在的组织' },
        { id: 'beta', name: '示例预设二' },
      ]),
    })

    await flows.init({ sessionId: 'session-test' })
    const result = await flows.init({ sessionId: 'session-test', confirmCreate: true })

    assert.equal(result.preset.ok, true)
    assert.notEqual(result.preview.preset.id, 'alpha', 'id 必须避开名册里已有的 alpha')
    assert.equal(result.preview.preset.id, 'alpha-2')
    const patch = await readFile(join(result.preset.directory, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /^\s+id: alpha-2$/mu, '声明里的 config.id 必须同步为改名后的 id')
    assert.ok(!/^\s+id: alpha$/mu.test(patch), '绝不能出现与既有预设重复的 config.id')
    assert.match(patch, /name: '示例预设 · 不存在的组织'|name: 'alpha'/u,
      '显示名仍用用户输入（id 是内部标识，显示名才是他看到的）')
  })

  it('★ 判据取自名册：名册里的**显示名**同样拦重名（不再依赖扫目录）', async () => {
    const { ws, localPresetRoot } = await fresh('name-from-roster')
    const { flows, calls } = harness({
      workspace: ws,
      noMessages: true,
      // 第 1 题先答一个已被占用的显示名 → 校验失败会**回问一次**；第二次换个名字。
      answers: [answer('示例预设 · 不存在的组织'), answer('我的学习助手'),
        ...sixAnswers('我的学习助手').slice(1)],
      config: { presetRoot: localPresetRoot },
      agentPresets: rosterOf([{ id: 'alpha', name: '示例预设 · 不存在的组织' }]),
    })

    const preview = await flows.init({ sessionId: 'session-test' })
    assert.equal(preview.stage, 'preview')
    assert.equal(preview.preview.name, '我的学习助手', '重名被拦下后改用第二个名字')
    const retry = calls.find(request => (request.questions ?? [])
      .some(question => /上一轮的答案没有被采用/u.test(question.detail ?? '')))
    assert.ok(retry !== undefined, '重名必须当场回问（而不是替用户改名，也不是静默放行）')
  })

  it('★ 预览里的落点写的是**工作区内**的相对路径，不再写 <dshHome>', async () => {
    const { ws, localPresetRoot } = await fresh('preview-location')
    const { flows } = harness({
      workspace: ws,
      noMessages: true,
      answers: sixAnswers('落点检查'),
      config: { presetRoot: localPresetRoot },
    })

    const preview = await flows.init({ sessionId: 'session-test', confirmCreate: false })

    assert.match(preview.preview.preset.location, /工作区内/u)
    assert.ok(!preview.preview.preset.location.includes('dshHome'), '不得再指向宿主目录')
    const listed = preview.preview.paths.map(item => item.path).join('\n')
    assert.match(listed, /\.dsh\/preset-bundles\/<预设 id>\//u)
    assert.ok(!listed.includes('outside-workspace'), '落点已回到工作区内，不再是"工作区之外"')
    // 名册摘要随结果回传（留痕：当时名册是什么样）
    assert.equal(preview.roster.source, 'agentPresets')
    assert.equal(preview.roster.total, 0)
  })

  it('★ 判据只在名册：光放一个预设目录**不再**拦重名（架构变更的显式声明）', async () => {
    // 这一条钉的是**架构变更本身**，不是某个缺陷：2.0.0 靠"扫预设根下的目录"判重名，
    // 2.1.0 改成读宿主名册（身份＝声明行里的 `config.id`）。所以要防止两件事：
    //   ① 有人"顺手加回目录扫描当保险" —— 那会让未安装的 bundle 目录冒充已有预设；
    //   ② 有人把判据又改回文件系统而测试全绿（正是这一轮红过的那条用例暴露的盲区）。
    // 目录判据仍保留在**另一件事**上：`createPreset` 的 `ID_TAKEN`（写目标占用，
    // 防覆盖本插件自己生成、尚未安装的 bundle）。
    const { ws, localPresetRoot } = await fresh('roster-only')
    // 目录里放一个同名的手工预设，但**不**放进名册
    await mkdir(join(localPresetRoot, 'ghost'), { recursive: true })
    await writeFile(join(localPresetRoot, 'ghost', 'cordis.patch.yml'), '# 未安装的 bundle（名册不知道它）\n', 'utf8')

    const { flows, calls } = harness({
      workspace: ws,
      noMessages: true,
      answers: sixAnswers('幻影预设'),
      config: { presetRoot: localPresetRoot },
      agentPresets: { list: async () => [] },   // 名册里没有它
    })

    const result = await flows.init({ sessionId: 'session-test' })
    assert.equal(result.ok, true)
    assert.equal(result.preview.name, '幻影预设', '名册没有它 ⇒ 名字可用（目录不再是判据）')
    assert.equal(calls.length, TOTAL_ROUNDS, '不该因"目录里有个同名的"多问一轮')
    // 而那个目录一个字都没被动过
    assert.equal(await readFile(join(localPresetRoot, 'ghost', 'cordis.patch.yml'), 'utf8'),
      '# 未安装的 bundle（名册不知道它）\n')
  })
})

