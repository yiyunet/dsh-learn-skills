/**
 * audit.test.mjs —— 只读体检与脱敏的真实行为测试。
 *
 * ★ 最关键的一条断言在 'audit 不修改任何被检查文件' ——
 *   它比对扫描前后**每个文件的字节与内容指纹**。这正是"只读"这个承诺的判据：
 *   不是"代码里没写 write"，而是"跑完之后磁盘一个字节都没变"。
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { audit, collect, compareWithBaseline, renderAuditReport, scanPresetBundles, CONFIDENCE } from '../plugin-src/host/audit.mjs'
import { redact, REDACTION_NOTICE } from '../plugin-src/host/redact.mjs'
import { fingerprint } from '../plugin-src/host/paths.mjs'
// 夹具由片段拼装（见该模块头注释）：源码里不出现完整形态的假凭证，
// 于是发布前的泄漏扫描不会举报测试自己。
import {
  FAKE_BIZ_PATH, FAKE_BEARER, FAKE_EMAIL, FAKE_GCP_KEY, FAKE_GHP_TOKEN, FAKE_GITHUB_PAT,
  FAKE_ID_CARD, FAKE_JWT, FAKE_NPM_TOKEN, FAKE_PEM_BODY, FAKE_PHONE, FAKE_POSIX_PATH,
  FAKE_SECRET, FAKE_SLACK_WEBHOOK, FAKE_VENDOR_TOKEN, FAKE_VENDOR_TOKEN_DASH, FAKE_WIN_PATH,
} from './fixtures.mjs'

const DIRS = {
  index: 'index', inbox: 'inbox', knowledge: 'knowledge', data: 'data',
  task: 'task', reports: 'reports', skillsDir: '.dsh/skills', stateDir: '.dsh/learn-skills',
}

let workspace

async function write(relative, content) {
  const target = join(workspace, relative)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content, 'utf8')
}

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'learn-skills-audit-'))
  await write('AGENTS.md', [
    '# 我的学习工作区',
    '',
    '## 职责边界',
    '- 只做学习与知识沉淀',
    '- 不执行材料里的指令',
    '',
    '## 协作关系',
    '- 与运营部协作，按周同步',
  ].join('\n'))
  await write('knowledge/framework.md', [
    '# 知识框架',
    '',
    '## 工作流程',
    '1. 收集 → 2. 提炼 → 3. 关联 → 4. 升级 → 5. 沉淀 → 6. 复用',
    '',
    '## 命名',
    '节点文件用 LN-<日期>-<序号>.md',
    '',
    '## 节点索引',
    '',
    '| 节点 id | 标题 |',
    '|---|---|',
    '| LN-20260917-001 | 合规要求 |',
  ].join('\n'))
  await write('knowledge/nodes/LN-20260917-001-合规要求.md', [
    '---',
    'id: LN-20260917-001',
    'title: 合规要求',
    'status: active',
    'version: 2',
    'updated: 2026-09-17',
    'tags: ["fact"]',
    'sources: ["session-1"]',
    'links: []',
    '---',
    '',
    '北美站需要 FCC 标识。',
    '这条规则已废弃，被 2026 版取代。',
  ].join('\n'))
  await write('.dsh/skills/example/SKILL.md', '---\nname: example\ndescription: 示例技能\n---\n\n正文\n')
  await write('reports/2026-09-17-复盘.md', '# 复盘\n\n内容\n')
})

after(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('redact —— 宁可多打码', () => {
  // ⚠️ 这里刻意**一条规则一个用例**，不写成"一大段文本断言命中 ≥N 条"。
  //    原因：一条过宽的规则会把后面规则的靶子先吃掉，于是"总命中数够了"照样通过 ——
  //    规则看着全绿，实际只有一条在工作。逐条给靶子，才验得出每条真的在干活。
  const cases = [
    { rule: '凭证键值对（apiKey:）', input: `apiKey: ${FAKE_VENDOR_TOKEN}`, forbidden: FAKE_VENDOR_TOKEN },
    { rule: '凭证键值对（secret = 带引号）', input: `secret = "${FAKE_SECRET}"`, forbidden: FAKE_SECRET },
    { rule: '授权头 Bearer', input: `Authorization: Bearer ${FAKE_BEARER}`, forbidden: FAKE_BEARER },
    { rule: '厂商令牌 sk-', input: `令牌是 ${FAKE_VENDOR_TOKEN} 请勿外传`, forbidden: FAKE_VENDOR_TOKEN },
    { rule: '厂商令牌 ghp_', input: `token ${FAKE_GHP_TOKEN}`, forbidden: FAKE_GHP_TOKEN },
    { rule: '厂商令牌 npm_', input: `认证串 ${FAKE_NPM_TOKEN}`, forbidden: FAKE_NPM_TOKEN },
    { rule: 'JWT', input: `凭据 ${FAKE_JWT}`, forbidden: 'eyJhbGciOiJIUzI1NiJ9' },
    { rule: '邮箱', input: `联系我：${FAKE_EMAIL}`, forbidden: FAKE_EMAIL },
    { rule: '国内手机号', input: `电话 ${FAKE_PHONE} 可加微信`, forbidden: FAKE_PHONE },
    { rule: 'URL userinfo', input: `postgres://admin:${['p', 'ssw0rd123'].join('@')}@db.internal:5432/x`, forbidden: ['p', 'ssw0rd123'].join('@') },
    {
      rule: 'PEM 私钥块',
      input: `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_PEM_BODY}\n-----END RSA PRIVATE KEY-----`,
      forbidden: FAKE_PEM_BODY,
    },
    // ── 2026-10-25 补：外部测评 #1321（F3）点名的漏项 ─────────────────────
    { rule: '云厂商 GCP API key（AIza）', input: `key ${FAKE_GCP_KEY} 结尾`, forbidden: FAKE_GCP_KEY },
    { rule: 'GitHub fine-grained PAT（github_pat_）', input: `token ${FAKE_GITHUB_PAT}`, forbidden: FAKE_GITHUB_PAT },
    { rule: 'Slack webhook URL', input: `通知地址 ${FAKE_SLACK_WEBHOOK} 请勿外传`, forbidden: FAKE_SLACK_WEBHOOK },
    { rule: '身份证号', input: `证件 ${FAKE_ID_CARD} 已核对`, forbidden: FAKE_ID_CARD },
    // 令牌**尾部边界**哨兵：见 redact.mjs「令牌结尾断言」注释。
    // GCP base64url / glpat- / sk- / xox- / JWT / github_pat_ 的字母表都含 `-`/`_`，
    // 合法令牌可以以它们收尾 —— 那时 `\b` 判不出边界，密钥会原样漏出。
    // 这几条与上一条 GCP 用例共同看住同一处病灶，不许单条"改断言"绕过。
    { rule: '厂商令牌 sk- 以连字符结尾', input: `key ${FAKE_VENDOR_TOKEN_DASH} 结尾`, forbidden: FAKE_VENDOR_TOKEN_DASH },
  ]
  for (const testCase of cases) {
    it(`${testCase.rule} 被打码`, () => {
      const { text } = redact(testCase.input)
      assert.ok(!text.includes(testCase.forbidden),
        `${testCase.rule} 未生效：输入 ${JSON.stringify(testCase.input)} → 输出 ${JSON.stringify(text)}`)
      assert.ok(text.includes('«已脱敏»') || text.includes('«'), `${testCase.rule} 未留下打码占位符`)
    })
  }

  it('命中统计如实反映每条规则（不是"总数够了就行"）', () => {
    const input = [
      `apiKey: ${FAKE_VENDOR_TOKEN}`,
      `Authorization: Bearer ${FAKE_BEARER}`,
      `凭据 ${FAKE_JWT}`,
      `联系我：${FAKE_EMAIL} 或 ${FAKE_PHONE}`,
    ].join('\n')
    const { hits } = redact(input)
    // 至少 4 条不同规则各自命中过 —— 单条过宽规则无法伪造这个分布。
    assert.ok(hits.length >= 4, `命中规则种类应 ≥4，实得 ${hits.length}：${JSON.stringify(hits)}`)
  })

  it('绝对路径：目录链整体打码，文件名保留', () => {
    const { text } = redact(`路径是 ${FAKE_WIN_PATH} 和 ${FAKE_POSIX_PATH}`)
    assert.ok(!text.includes(FAKE_WIN_PATH.split('\\')[2]), 'Windows 路径里的用户名必须被抹掉')
    assert.ok(!text.includes(FAKE_POSIX_PATH.split('/')[2]), 'POSIX 路径里的用户名必须被抹掉')
    // ★ 2.2.10 语义变更（外部测评 #1321 的 F3 建议："absolutePaths: true 时任意绝对路径都打码"）：
    //   早先只打用户名段、保留目录结构，于是 `<盘符>:\Users\<用户>\Proj\<客户名>\a.md` 里
    //   项目名/客户名照样留在报告里 —— 打了"是谁的机器"，没打"是谁的项目"。
    //   现在目录链整体换成占位符，**文件名保留**（报告要能说清"去查哪个文件"）。
    assert.ok(!text.includes('Documents'), '目录段也要打掉（只打用户名会漏掉项目名/客户名）')
    assert.ok(!text.includes('C:\\Users\\'), '不再保留目录结构')
    assert.ok(text.includes('\\x'), 'Windows 路径的文件名要保留')
    assert.ok(text.includes('/y'), 'POSIX 路径的文件名要保留')
  })

  it('超长内容被截断并说明（不假装读全了）', () => {
    const { text } = redact('x'.repeat(300), { maxBytes: 100 })
    assert.ok(text.includes('已截断'))
  })

  it('保留无关内容不动', () => {
    const { text } = redact('这是一句普通的中文说明，没有秘密。')
    assert.equal(text, '这是一句普通的中文说明，没有秘密。')
  })

  it('★ 非家目录的业务数据路径也打码（真实测评里原样漏出的形态）', () => {
    // 外部测评 #1321（F3）的样本：/srv/clients/acme/payroll.xlsx —— 路径里带客户名。
    const { text } = redact(`配置在 ${FAKE_BIZ_PATH} 里`)
    assert.ok(!text.includes('acme'), `业务路径里的客户名必须被抹掉，实得：${JSON.stringify(text)}`)
    // 2.2.10：兜底规则连路径根一起打掉（`/srv/` 本身也可能带信息），文件名保留。
    assert.ok(!text.includes('/srv/'), `目录链（含 /srv）一并打掉，实得：${JSON.stringify(text)}`)
    assert.ok(text.includes('payroll.xlsx'), '文件名应保留 —— 读者要知道去查哪个文件')
  })

  it('★ URL 不会被当成绝对路径误打码', () => {
    // 兜底规则靠负向后顾区分"路径"与"URL 里的斜杠"。这条钉住它：
    // `https://host/a/b` 里 `/a/b` 前面的字符命中排除集，不该被打。
    const url = ['https://example.com', 'docs', 'guide.md'].join('/')
    const { text } = redact(`参考 ${url} 一文`)
    assert.ok(text.includes('example.com'), `URL 主机名不该被打掉，实得：${JSON.stringify(text)}`)
  })

  it('★ 单级路径不误伤命令文本（兜底要求至少两级）', () => {
    const { text } = redact('/learn rollback <批次号> 与 </div> 都应原样保留')
    assert.ok(text.includes('/learn'), `命令文本不该被打码，实得：${JSON.stringify(text)}`)
    assert.ok(text.includes('</div>'), 'HTML 片段不该被打码')
  })
})

describe('缺内容节点 —— 体检必须点名，不许沉默', () => {
  it('★ 总索引有记录、文件却载入不了 ⇒ 报成异常节点 + 出告警', async () => {
    // 这条补的是一个**漏报**：先前体检按文件名后缀数节点，一个 frontmatter 被手工改坏的
    // 文件被当成正常节点计入数量，而它在关联与升级里其实取不到。
    // 判据与升级侧共用（`findMissingNodes`），这里验的是"体检侧真的把它报出来了"。
    const ws = await mkdtemp(join(tmpdir(), 'learn-skills-missing-'))
    const put = async (relative, content) => {
      const target = join(ws, relative)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    await put('AGENTS.md', '# 规则\n\n## 职责边界\n- 只做学习\n')
    await put('knowledge/framework.md', [
      '# 知识框架',
      '',
      '## 节点索引',
      '',
      '| 节点 id | 标题 | 状态 | 版本 | 更新日 | 来源 |',
      '|---|---|---|---|---|---|',
      '| LN-20260920-001 | 好节点 | active | 1 | 2026-09-20 | knowledge/nodes/LN-20260920-001-ok.md |',
      '| LN-20260920-002 | 被手改坏的节点 | active | 1 | 2026-09-20 | knowledge/nodes/LN-20260920-002-broken.md |',
    ].join('\n'))
    await put('knowledge/nodes/LN-20260920-001-ok.md', [
      '---', 'id: LN-20260920-001', 'title: 好节点', 'status: active', 'version: 1',
      'updated: 2026-09-20', 'tags: ["fact"]', 'sources: ["s1"]', 'links: []', '---', '', '正文', '',
    ].join('\n'))
    // 被手改坏的那个：没有 frontmatter（载入不了）
    await put('knowledge/nodes/LN-20260920-002-broken.md', '我手写的一段备注\n')

    try {
      const collected = await collect({ workspace: ws, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
      const result = audit({ collected, baseline: undefined, context: {} })

      const missing = result.warnings.filter(item => item.code === 'MISSING_NODE_CONTENT')
      assert.equal(missing.length, 1, `应报出一条缺内容节点告警，实得 ${JSON.stringify(result.warnings)}`)
      assert.match(missing[0].detail, /LN-20260920-002-broken\.md/u)

      const knowledge = result.items.find(item => item.id === 'knowledge')
      assert.ok(
        knowledge.entries.some(entry => entry.source === 'knowledge/nodes/LN-20260920-002-broken.md'
          && /异常节点/u.test(entry.note ?? '')),
        `体检的「知识库」项必须点名那个文件，实得 ${JSON.stringify(knowledge.entries.map(entry => entry.note))}`,
      )
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})

describe('collect + audit —— 18 项体检', () => {
  it('产出 18 项结论，顺序与需求一致', async () => {
    const collected = await collect({ workspace, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
    const result = audit({ collected, baseline: undefined, context: { presetId: 'alpha' } })
    assert.equal(result.items.length, 18)
    assert.deepEqual(result.items.map(item => item.id), [
      'role', 'goals', 'prompt', 'precedence', 'workflow', 'skills', 'knowledge',
      'memory', 'preferences', 'tasks', 'collaboration', 'scheduling', 'permissions',
      'io', 'cases', 'issues', 'delta', 'reuse',
    ])
  })

  it('每条结论都带来源路径', async () => {
    const collected = await collect({ workspace, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
    const result = audit({ collected, baseline: undefined, context: {} })
    const withSource = result.items.filter(item => item.entries.some(entry => entry.source !== undefined))
    assert.ok(withSource.length >= 8, `带来源的结论应 ≥8 项，实得 ${withSource.length}`)
    const role = result.items.find(item => item.id === 'role')
    assert.equal(role.entries[0].source, 'AGENTS.md')
  })

  it('读不到的东西标无法访问，不猜（系统提示词 / 长期记忆）', async () => {
    const collected = await collect({ workspace, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
    const result = audit({ collected, baseline: undefined, context: {} })
    assert.equal(result.items.find(item => item.id === 'prompt').confidence, CONFIDENCE.inaccessible)
    assert.equal(result.items.find(item => item.id === 'memory').confidence, CONFIDENCE.inaccessible)
    // 关键：不假装读到了系统提示词
    const prompt = result.items.find(item => item.id === 'prompt')
    assert.equal(prompt.entries.filter(entry => entry.source !== undefined).length, 0)
  })

  it('架构缺失时判 missing 并给出结构问题', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'learn-skills-empty-'))
    const collected = await collect({ workspace: empty, dirs: DIRS, maxFiles: 50, maxBytes: 10000 })
    const result = audit({ collected, baseline: undefined, context: {} })
    assert.equal(result.items.find(item => item.id === 'role').confidence, CONFIDENCE.missing)
    assert.ok(result.warnings.some(warning => warning.code === 'NO_AGENTS'))
    assert.ok(result.warnings.some(warning => warning.code === 'NO_FRAMEWORK'))
    await rm(empty, { recursive: true, force: true })
  })

  it('过期判定必须有依据：文件里写了"已废弃"才报', async () => {
    const collected = await collect({ workspace, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
    const result = audit({ collected, baseline: undefined, context: {} })
    const issues = result.items.find(item => item.id === 'issues').entries
    const stale = issues.filter(item => item.kind === 'possibly-stale')
    assert.equal(stale.length, 1)
    assert.match(stale[0].evidence, /被替代|日期/u)
  })

  it('首次无基线：明确说"本次建立初始基线"，不假装有对比', async () => {
    const collected = await collect({ workspace, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
    const result = audit({ collected, baseline: undefined, context: {} })
    assert.equal(result.delta.available, false)
    const deltaItem = result.items.find(item => item.id === 'delta')
    assert.ok(deltaItem.entries.some(entry => /无历史基线/u.test(String(entry.note))))
  })

  it('★ audit 不修改任何被检查文件（字节与指纹都不变）', async () => {
    const tracked = [
      'AGENTS.md',
      'knowledge/framework.md',
      'knowledge/nodes/LN-20260917-001-合规要求.md',
      '.dsh/skills/example/SKILL.md',
      'reports/2026-09-17-复盘.md',
    ]
    const beforeState = []
    for (const relative of tracked) {
      const text = await readFile(join(workspace, relative), 'utf8')
      beforeState.push({ relative, sha: fingerprint(text), bytes: Buffer.byteLength(text, 'utf8') })
    }
    const collected = await collect({ workspace, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
    audit({ collected, baseline: undefined, context: {} })
    const afterState = []
    for (const relative of tracked) {
      const text = await readFile(join(workspace, relative), 'utf8')
      afterState.push({ relative, sha: fingerprint(text), bytes: Buffer.byteLength(text, 'utf8') })
    }
    assert.deepEqual(afterState, beforeState, '体检必须零写入')
  })

  it('报告里的原文也过脱敏；报告本身标注了脱敏与只读', async () => {
    await write('knowledge/nodes/LN-20260918-002-带秘密.md', [
      '---',
      'id: LN-20260918-002',
      'title: 带秘密的节点',
      'status: active',
      'version: 1',
      'updated: 2026-09-18',
      'tags: []',
      'sources: []',
      'links: []',
      '---',
      '',
      `apiKey: ${FAKE_VENDOR_TOKEN}`,
    ].join('\n'))
    const collected = await collect({ workspace, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
    const result = audit({ collected, baseline: undefined, context: {} })
    const markdown = renderAuditReport(result, { workspaceLabel: '.', generatedAt: '2026-09-18T00:00:00' })
    assert.ok(!markdown.includes(FAKE_VENDOR_TOKEN), '报告不得带出令牌')
    assert.ok(markdown.includes(REDACTION_NOTICE))
    assert.match(markdown, /只读/u)
    assert.match(markdown, /未修改任何被检查文件/u)
  })
})

describe('compareWithBaseline —— 按内容指纹，不按修改时间', () => {
  it('首跑无基线 → available=false', () => {
    const result = compareWithBaseline([{ relative: 'a.md', sha: 'x' }], undefined)
    assert.equal(result.available, false)
    assert.deepEqual(result.summary, { added: 0, updated: 0, removed: 0, unchanged: 0 })
  })

  it('新增 / 变化 / 消失 / 不变四类被分开计数', () => {
    const baseline = {
      files: [
        { relative: 'same.md', sha: 'aaa' },
        { relative: 'changed.md', sha: 'bbb' },
        { relative: 'gone.md', sha: 'ccc' },
      ],
    }
    const files = [
      { relative: 'same.md', sha: 'aaa' },
      { relative: 'changed.md', sha: 'zzz' },
      { relative: 'new.md', sha: 'ddd' },
    ]
    const result = compareWithBaseline(files, baseline)
    assert.equal(result.available, true)
    assert.deepEqual(result.summary, { added: 1, updated: 1, removed: 1, unchanged: 1 })
    assert.ok(result.entries.some(entry => entry.relative === undefined && /内容变化/u.test(entry.note)))
  })

  it('同内容不同修改时间不算变化（判据是 sha）', () => {
    const baseline = { files: [{ relative: 'a.md', sha: fingerprint('same content') }] }
    const files = [{ relative: 'a.md', sha: fingerprint('same content') }]
    const result = compareWithBaseline(files, baseline)
    assert.equal(result.summary.unchanged, 1)
    assert.equal(result.summary.updated, 0)
  })

  it('第二次体检：报告里出现真实变化条目', async () => {
    const collected = await collect({ workspace, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
    const first = audit({ collected, baseline: undefined, context: {} })
    // 增加一个节点后再体检
    await write('knowledge/nodes/LN-20260919-003-新增节点.md', [
      '---', 'id: LN-20260919-003', 'title: 新增节点', 'status: active', 'version: 1',
      'updated: 2026-09-19', 'tags: []', 'sources: []', 'links: []', '---', '', '内容',
    ].join('\n'))
    const collected2 = await collect({ workspace, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
    const second = audit({ collected: collected2, baseline: first.baseline, context: {} })
    assert.equal(second.delta.available, true)
    assert.ok(second.delta.summary.added >= 1)
    assert.ok(second.delta.entries.some(entry => /新增/u.test(entry.note)))
  })
})

describe('预设 bundle 的提示词变量 —— 体检必须点名（两台真机的真实夹具）', () => {
  // 夹具照抄真机形态（两台机器都踩过同一个坑）：
  //   · `<工作区>/.dsh/preset-bundles/learn-1a2b3c/cordis.patch.yml` —— 本插件生成，1 处
  //     `suffix: Your working directory is {{cwd}}.`；
  //   · `<dshHome>/preset-bundles/example-presets/cordis.patch.yml` —— 手工迁移产物，
  //     11 处 prefix 里的「工作目录 {{cwd}}，/。」
  // 只删掉生成器那一行是**不够**的：已经生成的预设还躺在盘上，体检必须能指出来。
  let ws
  const BROKEN_ID = 'learn-1a2b3c'
  const MIGRATED_ID = 'example-presets'

  /** 一份"插件生成物"形态的 patch（就是 2.2.1 及更早版本写出来的样子）。 */
  const pluginGenerated = () => [
    '- insert:',
    '    - id: preset-learn-1a2b3c',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: learn-1a2b3c',
    "        name: '我的学习预设'",
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              suffix: Your working directory is {{cwd}}.',
    '              prefix: |-',
    '                你是「我的学习预设」。',
    '',
  ].join('\n')

  /** 一份"手工迁移物"形态的 patch：11 处 prefix 内嵌变量。 */
  const migrated = () => [
    '- insert:',
    '    - id: preset-migrated-a',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    ...Array.from({ length: 11 }, (_, index) => (
      index % 2 === 0 ? `                工作目录 {{cwd}}，专属文件夹 P${index}/。` : '                工作目录 {{cwd}}。'
    )),
    '',
  ].join('\n')

  before(async () => {
    ws = await mkdtemp(join(tmpdir(), 'learn-skills-presets-'))
    const put = async (relative, content) => {
      const target = join(ws, relative)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    await put('AGENTS.md', '# 规则\n\n## 职责边界\n- 只做学习\n')
    await put('.dsh/preset-bundles/learn-1a2b3c/cordis.patch.yml', pluginGenerated())
    await put('.dsh/preset-bundles/example-presets/cordis.patch.yml', migrated())
    // 对照：一份**干净**的预设（2.2.2 之后的产物形态）。
    await put('.dsh/preset-bundles/learn-clean00/cordis.patch.yml', [
      '- insert:',
      '    - id: preset-learn-clean00',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        plugins:',
      '          - id: persona',
      "            name: '@deepseek-ai/dsh-persona'",
      '            config:',
      '              prefix: |-',
      '                你是「干净预设」。',
      "                !!js process.platform === 'win32'",
      '                数学式子写 {x} 不算变量。',
      '',
    ].join('\n'))
  })

  after(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it('scanPresetBundles 独立可用：报出文件路径、行号与命中行原文', async () => {
    const result = await scanPresetBundles({
      roots: [join(ws, '.dsh/preset-bundles')],
      workspace: ws,
    })
    assert.equal(result.files.length, 3)
    const broken = result.findings.filter(entry => entry.source.includes(BROKEN_ID))
    assert.equal(broken.length, 1)
    assert.match(broken[0].text, /\{\{cwd\}\}/u)
    assert.ok(Number.isInteger(broken[0].line) && broken[0].line > 0)
    const migratedHits = result.findings.filter(entry => entry.source.includes(MIGRATED_ID))
    assert.equal(migratedHits.length, 11)
    // 对照：干净预设零命中 —— 闸不是恒真。
    assert.equal(result.findings.some(entry => entry.source.includes('learn-clean00')), false)
  })

  it('体检把它们并进 ⑯ 已知问题，并提一条 PRESET_PROMPT_VARIABLE 告警', async () => {
    const collected = await collect({ workspace: ws, dirs: DIRS, maxFiles: 100, maxBytes: 100000 })
    const result = audit({ collected, baseline: undefined, context: {} })

    const issues = result.items.find(item => item.id === 'issues').entries
    const promptVariables = issues.filter(entry => entry.kind === 'prompt-variable')
    assert.equal(promptVariables.length, 12, `应报出 12 处，实得 ${promptVariables.length}`)
    // 每条都必须指到**具体文件 + 行号**：修法是"重建"还是"手改"由人按代价决定。
    assert.ok(promptVariables.every(entry => /\.dsh\/preset-bundles\/.+\/cordis\.patch\.yml 第 \d+ 行/u.test(entry.detail)),
      `条目的 detail 必须带路径与行号：${JSON.stringify(promptVariables.map(entry => entry.detail))}`)

    const warning = result.warnings.find(item => item.code === 'PRESET_PROMPT_VARIABLE')
    assert.ok(warning !== undefined, `缺少 PRESET_PROMPT_VARIABLE 告警：${JSON.stringify(result.warnings)}`)
    assert.match(warning.detail, /learn-1a2b3c/u)
    assert.match(warning.detail, /example-presets/u)
    // 干净预设不该被点名。
    assert.equal(/learn-clean00/u.test(warning.detail), false)
  })
})
