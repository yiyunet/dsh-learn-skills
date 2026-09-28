# 变更记录

遵循语义化版本。本文件记录**对使用者有影响**的变化。

## 2.2.1 — 首次公开发布后的文档修正

**性质：纯文档与元数据修正，零代码变更、零行为变更。**
（`plugin-src/` 与 `test/` 一字未动；`npm run check` 的测试数与断言组数均不变。）

### 修正（三处）

1. **删掉一条已经变假的声明**。2.2.0 的 README 里写着
   「⚠️ 诚实声明：本版本**未执行公开发布**」—— 该版本**已于 2026-09-28 发布到 npm**，
   这句话在包页上即为错误陈述，已删除。
2. **把安装路径的**主次**摆正**。2.2.0 把「本地目录安装」（五条 `npm run` 构建命令）
   列为**方式 A**，把「npm 安装」列为方式 B。但对已发布的包而言，
   消费者**一步即可**（发布包自带 `lib/`，无须构建）⇒ 现在：
   - **方式 A ＝ `dsh plugin --profile web add @yiyunet/dsh-learn-skills`**（推荐）；
   - **方式 B ＝ 本地目录安装**，并注明「改源码／调试时用」。
3. **修 `npm run check` 的说明**。原文写作 `# build + test + verify`，
   实际该脚本是 **`static → build → test → verify` 四步**（漏了 `static`）。

### 新增（两节）

4. **`## 排错`**：按症状给出 9 条（装完看不到入口、菜单 404、名册不可用、
   "尚未安装"、提炼为空、语义增强不生效、"模型到底有没有在工作"、
   `npm run check` 失败的定位）。每条都写"为什么"与"下一步"，
   且把**刻意设计**与**真故障**分开 —— 避免使用者把设计行为当 bug 来回折腾。
5. **`## 卸载`**：三步（摘插件 / 清状态 / 你的知识库不会被删），
   并显式指向 `docs/删除预设.md` 的**四步法**，
   警示「同包多预设时不能卸整包」。

### 备注

- 本版**只发文档**。若你已装 2.2.0，**功能上没有任何升级必要**；
  升级只为让 npm 包页上的 README 与事实一致。
- 行尾规范化：仓库新增 `.gitattributes`（`* text=auto eol=lf`），
  使 Windows / macOS / Linux 的检出结果一致。

## 2.2.0 — 首次公开发布（2026-09-28）

> 发布态：`@yiyunet/dsh-learn-skills@2.2.0`，`access: public`。

起因＝真机反馈三条（`dsh-learn-skills` 初始预设）：

1. 「第二问的回答没有被读取，后面生成的问题都是宽泛的通用问题」；
2. 「第二问应改为三参数输入：职业 ＋ 面向什么 ＋ 期望，并给例子」；
3. 「给了更多参数后，后面的问题应该能取到更多信息，生成更专业的预设」。

三条都指向同一处结构性缺口：**原实现里模型从头到尾没进过问答环**。六道题的题面是
代码里的固定字符串，唯一的"个性化"只有第 3 题按职业正则命中**七个硬编码池**之一
（`interestCandidates`）。于是 `大学生 ｜ 面向大学英语 ｜ 更快掌握` 只能落到通用的
"学生池"，候选与"大学英语"毫无关系 —— 用户体感就是"问题很泛"。

### ⚠️ 行为变更（四项）

1. **题序：六题固定 → 前两题固定 ＋ 第 3 轮起由模型逐轮生成**（`TOTAL_ROUNDS = 7`）。
   - 第 1 题名字；第 2 题收**三段式**（职业 ｜ 面向 ｜ 期望）并**回显第 1 题**；
     第 3~7 题每轮都把"已采集的全部信息 ＋ 剩余轮次 ＋ 已问话题"交给模型，
     由它现场生成**题面与候选**。
   - 用户侧是从"6 轮"变"7 轮"（新增第 7 题：最想先解决的一件事）。
2. **模型优先、硬编码兜底**（老板裁决）。模型不可用时（超时 / 限流 / 无凭据 /
   输出不合格）逐轮回退到硬编码题库，**流程不会中断**，并记 `warn` 日志说明
   降级原因 —— "为什么这次问题那么泛"必须可查。
3. **模型只定题面，落库槽位固定**。`question.topic` 一律取本轮对应的固定槽位
   （interests / goal / baseline / style / priority），**不是**模型自报的 topic。
   原因：`flows` 按 `topic` 决定答案写进哪个字段，模型报的 `constraint`/`scene`
   没有归一化规则 ⇒ 会绕过 `validateAnswers` 的"未填写＝未知"处理，静默丢数据。
4. **第二问答案落成三个字段**：`vocation` / `audience` / `expectation`。
   只填一段时**只当职业**，其余保持未知（`parseThreePart`，不替用户拆段）。
   三者都进预设正文（`renderPresetBody` 新增"面向的人群或事情 / 期望达到的效果"两行）
   与预览摘要；第 3、4 题的兜底候选也改为**三级匹配**：场景池（面向/期望）→ 职业池 → 通用池。

### 新增

- **`plugin-src/host/model.mjs`**：模型出题的**唯一实现点**。纯函数（提示词装配
  `buildMessages`、严格解析校验 `parseQuestionSpec`／`validateQuestionSpec`、
  三段式解析 `parseThreePart`）与薄 I/O（`generateQuestion`）分离，前者可被单测直接钉住。
- **`ctx.get()` 而非 `inject`**：`llm` 与 `agentDefaultModel` 都走**可选获取**，
  **不进静态 `inject`**。本插件自己的部署纪律如此，且把可选能力写进 inject 会让
  插件在缺该能力的部署里**整体 inactive** —— 而它本可以降级工作。
  模型路由取宿主 `agentDefaultModel.currentSelection()`（即会话正在用的默认模型），
  **因此不新增任何配置项**，也不与用户在界面里切换的模型打架。
- **一次性调用姿势**：用 `GenerateOptions.system`（宿主注释明写"for one-shot callers"），
  **不带 `sessionId`**、不套 `markAgentLoopRequest` —— 不进会话历史。
- **输出是"不可信输入"**：`validateQuestionSpec` 严格挡长度、保留词（`暂不填写` 等
  由导航层追加）、话题合法性、候选数量（3~6）与重复项，**不做任何修补** ——
  修补等于替模型做决定，出了偏差查不出来。
- **超时 20s**：超时/取消合成一个 `AbortSignal`，任一触发都让流停下来（否则超时后
  模型还在烧 token）。

### 测试（新增 `test/model.test.mjs`，19 条）

- **成功路径也测**：给一个假的 `ctx.llm`，让 `generateQuestion` 真的跑完一次流
  （拼块 → 解析 → 校验）。只测降级会让这条新通道长期处于"没测过"的状态。
- 覆盖：三段式五种分隔符与"只填一段"、围栏/噪音 JSON 抠取、topic 白名单、
  保留词剔除、候选去重与上下限、流 error/aborted、缺服务、流抛错、已取消信号。
- `test/flows.test.mjs` 基线同步：`sixAnswers` → `sevenAnswers`（第 2 题改三段式）、
  计数 6 → 7、摘要 9~10 行并新增三个主题断言。**测试桩的 `ctx` 没有 `agentDefaultModel`
  ⇒ 必然走降级路径**，所以 flows 用例仍然完全确定（不依赖模型输出）。

### 实测（`npm run check`，2026-09-23，Windows PowerShell 5.1）

**全绿**：`static` ✓ ｜ `build` ✓（`lib/model.mjs` 已落盘）｜
`test` **227 tests / pass 227 / fail 0** ｜ `verify` ✓（**10 组契约断言全部为真**）。

首轮曾 4 个失败（223/227），逐条修掉，其中**一个是真产品问题**：

1. **题头被覆盖成英文 topic**（真问题）：`第 4 题 / 共 7 题 · goal`。成因是我改题头时
   把 `draftQuestions` 里原有的中文标签覆盖掉了。已改为**一律走 `TOPIC_LABELS`**，
   固定题直接沿用它自己的（含中文）题头。**内部键与展示名必须分开，且展示名只定义一处。**
2. 两处**测试基线漏改**（`已完成 1 / 6`、`calls.length === 6`）：已改用导出的
   `TOTAL_ROUNDS`，**不再写死轮次数字** —— 写死就会在下次改题序时再漏一次。
3. 一处**测试自己写错**（假阴性）：`/已明确表示不填.*goal/` 匹配不上
   `用户**明确表示不填**的项：goal`（中间夹 Markdown 的 `**`）。

> ⚠️ 复跑必须走 `npm.cmd run check`（或先 build 再 test）：本轮改过 `plugin-src/**`，
> **单独跑 `npm test` 会命中"宿主产物与真源一致"那条守卫**（lib/ 落后于源码）。
> PowerShell 5.1 不支持 `&&`，所以用 `npm.cmd`（它内部走 cmd.exe）。

## 2.1.0 — 未发布（工作区版本）

对齐「Agent 预设的新架构」（DSH 0.1.7-alpha.1 ＋ 部署侧的组合包落点）。这是一轮
**适配性修复**，不是功能增补：2.0.0 的生成物**形状**本来是对的，错的是**落点**、
**身份判据**与**安装通道**——三处都在"插件不该自作主张"的边上。

起因＝一次针对新架构的复检（取证逐条给到源码行号）。

### ⚠️ 行为变更（四项）

1. **落点搬进工作区**：预设 bundle 默认从 `<dshHome>/preset-bundles/<id>/` 改为
   **`<工作区>/.dsh/preset-bundles/<id>/`**（新配置项 `presetDir`）。
   - 依据：官方 `editing-cordis-compositions` 技能原文 "Write a bundle directory
     **in the workspace** with exactly two files"。
   - 好处：① 不再写工作区之外（不经沙箱）；② 不再造"第三处落点"（部署侧已有
     组合包／profile 用户补丁两处）；③ 工作区删除时连它的预设一起带走。
   - ⚠️ **代价（必须知道）**：该目录是**活的** —— 宿主重启时按预设 id 在当前配置里
     解析，**定义缺失的会话会被拒绝恢复**（官方 agent-note：「Restart resolves that
     identity against current configuration and rejects a missing definition」）。
     所以：**不要删也不要移动那个目录**；要撤掉请先用 `--profile <p> remove` 摘掉该 bundle。
   - `config.presetRoot` 仍保留为**显式绝对路径覆盖**（老配置一字不改即行为不变）。

2. **不再代为安装**：删除 `ctx.get('pluginManager').installBundle(dir)` 调用，改为
   **只出安装指引**（可复制的 CLI 命令 ＋ `plugin_manager` 工具路径 ＋ 复核方式 ＋
   撤销命令 ＋ "别删目录"的后果）。
   - 为什么：安装会在 **Host 进程执行新代码**。同一动作的官方入口 `plugin_manager`
     工具**强制**弹 `danger-full-access` 审批（`plugin-manager/src/tools.ts:34-41`），
     而服务方法 `installBundle()` **本身没有审批闸**（`plugin-manager/src/index.ts:417-447`）
     ⇒ 插件直接调它＝**替用户越权**。
   - 结果体里 `preset.install.attempted` 恒为 `false`、`code` 为 `MANUAL_INSTALL`、
     `requiresApproval: true`；**未安装就是未安装**，不再有"已创建并安装"的说法。

3. **身份判据改取宿主名册**：`init` 先读 `ctx.agentPresets.list()`（注册表 roster），
   用它的 `id` 与 `name` 做判重；**名册不可用 ⇒ 直接拒绝创建**（`ROSTER_UNAVAILABLE`，
   一个文件都不写）。
   - 为什么：新架构里预设身份＝声明行里的 `config.id`，而注册表**不扫描目录、也不接受
     preset 路径**（`agent-preset-registry/README.zh.md:46`）；一份组合包可以声明**很多**个
     预设（本机 `dsh-migrated-presets` 一个文件里就有 12 个）。2.0.0 按目录名数，只会数出
     "1 个"，且名字取错（取到文件里第一个非包名 `name:`）⇒ **ASCII 名字（`alpha`/`beta`…）
     会生成重复的 `config.id`**，而官方明写「**重复的 preset ID 会导致声明加载失败**」
     （`agent-preset/README.zh.md:82`）——影响面不止新预设。
   - 顺带修好一处旧缺口：「续办 → 预览」那条路径此前**没传**名册（重名检查在其中缺失），
     现在三条路径（问答完 / 续办 / 确认创建）一律带名册。
   - `status` 也以名册为准（`rosterSource: 'agentPresets'`），并回报 `brokenPresets`
     ——落选的行带诊断时看得见；名册取不到才退回扫目录（**仅用于显示一个数**，不用于判重）。

4. **删掉 `AGENTS.md` 死产物**：bundle 由三件套变**两件套**（官方原话 "exactly two files"）。
   - 为什么：新架构的指令面只有「工作区/项目根 `AGENTS.md`／`CLAUDE.md`」与
     「`$DSH_HOME/AGENTS.md`」（`agent-instructions/src/config.ts:12,19`；`render.ts:98`），
     **没有"预设目录"这个概念** ⇒ 那个文件没有任何消费者，却让用户以为"预设级规则已生效"。
     预设级规则的真实落点是声明行里的 `persona.prefix/suffix`（本来就已经写进去了）。
   - 连带：`renderPresetAgents()` 删除；`verifyPreset` 的"文件齐备"判据由三件改两件。

### 新增

- **安装指引是纯函数** `installInstructions({ directory, presetId, profile })`：命令／工具路径／
  复核／撤销四件，可被单测直接钉住（不依赖任何宿主服务）。
- **名册摘要进结果体**（`roster: { source, total, broken, reason }`）：留痕"当时名册长什么样"。
- **名册闸在问第一题之前**：不再让人答完六题才被告知"判不出来"。
- **纵深防御**：`finalize` 里再断言一次 id 未被名册占用（`PRESET_ID_TAKEN`），
  真要撞上说明判据坏了 —— 那就不出件。
- **`npm run verify` 加四条结构性断言**（⑥-b）：宿主半侧不得出现 `installBundle(...)`；
  判据必须来自 `ctx.agentPresets`；必须有 `ROSTER_UNAVAILABLE` 分支；`preset.mjs` 不得再导出
  `renderPresetAgents`、且必须有 `installInstructions`。可选服务表补 `agentPresets`／`pluginManager`
  （它们不得进静态 `inject`）。
- **`clean-test-state.mjs` 默认预设根改为随工作区**（`<工作区>/.dsh/preset-bundles`）；
  残缺判据由三件改两件；`DEFAULT_PRESET_ROOT` 常量换成 `defaultPresetRoot(workspace)`。
  旧落点 `<dshHome>/preset-bundles` **不再被默认扫描**（那里住的是部署方自己的组合包，
  不属于本插件）——要处理旧落点请显式传 `--preset-root`。

### 测试（先落后写，新增 9 条）

- `test/flows.test.mjs` 新增 6 条：**不代为安装**（放"陷阱" `installBundle`，被调用即失败）、
  **两件套且无 `AGENTS.md`**、**名册不可用 ⇒ 拒绝且零落盘**、**ASCII 名撞名册 id ⇒ 自动换 id
  且声明里不出现重复 `config.id`**、**显示名撞名册 ⇒ 当场回问**、**预览落点是工作区内相对路径**；
  harness 增 `agentPresets` 桩（默认可用但空）与 `pluginManager` 陷阱注入口。
- `test/clean-test-state.test.mjs` 新增 2 条：默认根随工作区、两件套判据不误报。
- 既有用例的 `config.presetRoot: <临时目录>` 一律保留 —— 这是"显式覆盖"路径，正好当它的回归。
- **实跑第一轮抓到 1 条**（`npm run check`：**tests 189 / suites 49 / fail 1**）：
  「重名：拒绝并请用户换名，不覆盖原预设」——它用**"在预设根里放一个目录"**来模拟"名字已被占用"，
  而本版把重名判据挪到了**宿主名册**，于是那个目录不再拦得住 ⇒ 名字没被拒、没回问、断言失败。
  **已按新架构修**：夹具改为"把名字放进名册桩"（判据在哪、夹具就在哪），同时**保留那个手工目录**
  继续钉"既有预设一个字也不动"。
- **新增第 9 条**（把这次架构变更本身钉死）：`★ 判据只在名册：光放一个预设目录**不再**拦重名`
  —— 它能同时挡住两件事：① 有人"顺手加回目录扫描当保险"（会让**未安装**的 bundle 目录冒充已有预设）；
  ② 判据被改回文件系统而测试照旧全绿（正是本轮红过的那条用例暴露的盲区）。
  注：目录判据仍活在**另一件事**上 —— `createPreset` 的 `ID_TAKEN`（写目标占用，防覆盖本插件自己
  生成、尚未安装的 bundle）。**两件事，两套判据**，别混。

### 文档（本次下沉 · 「删掉一个预设」的用户指引）

- **新增 [`docs/删除预设.md`](docs/删除预设.md)**：把"怎么干净地删掉一个预设"写成用户指引 ——
  **三种形态**（本插件生成的小包／与别人共用的组合包／老版本目录式）＋ **四步法**
  （关行确认 → 卸包 → 删工作区里的 bundle 目录 → 清 `known.json` 占用）＋ **删错的两级救援**
  （重启前＝黄金窗口；有备份／记得显示名）＋ **四条禁忌** ＋ 一页速查。
  全文**只用占位符**（`<工作区>` / `<DSH_HOME>` / `<profile>` / `<预设 id>`），**不含任何本机参数**。
- **订正三处"删除入口"表述**（都源于"新版没有删除按钮"这一点）：
  1. `docs/反复测试-清理流程.md` 第 1 步原写「`设置 → Agent 预设 → 删除`」——
     该入口在**声明式预设**下**不存在**（设置页对预设**只读**：查看／选择／设为默认；
     源码：`client/ui-agent-preset/README.zh.md`「本页不编辑任何内容」、`agent-preset/README.zh.md:82`
     「声明不提供目录、文件复制或文件删除操作」）⇒ 已改为**摘依赖 → 删目录 → 清占用**，
     并写明"顺序反了会被拒绝恢复"；同时把该文的示例路径改为占位符。
  2. `scripts/clean-test-state.mjs`（头部用法与运行提示）同步订正，并补一句**前置**：
     **本工具只删目录、不摘 profile 依赖** —— 删之前请先
     `dsh plugin --profile <profile> remove @local/dsh-learn-preset-<预设 id>`。
  3. `README.md` / `README.en.md` 的"撤销"一处补上四步法指引与"删除后清占用"的后果说明。
- **两条写进指引、值得记住的机制**：① **改 bundle 自己的 patch 必须重启**（热更新只监听
  profile 用户补丁与 `$DSH_HOME/cordis.patch.yml`；源码：`packages/boot/hmr/src/index.ts` 的
  `patchFiles`）；② 共用组合包**不能卸包**（一份 patch 可声明多个预设，卸包＝同包全没）。
- **运行时指引同步**：`installInstructions().caution` 由原来的"要撤掉请先 `remove` 该 bundle"
  扩成**三步顺序**（① 先 `remove` → ② 再删该目录 → ③ 清 `known.json` 占用），并指向本指引文档。
  字段与接口**未变**（仍是 `caution` 一个字符串），既有断言 `/拒绝恢复/` 继续成立。
- `scripts/verify-package.mjs` 的必需文件清单加入 `docs/删除预设.md`（并仍在第 ⑦ 组
  "本机绝对路径与凭证形态"的扫描面内：`docs/` 本就随包发出，写法必须形态化）。
- **订正留痕**：本文 §2.0.0 那条"流程文档 …（体检 → **GUI 删预设** → …）"是**当时**的写法，
  现行口径以本节的四步法为准（历史条目不改写，只在此处点明）。

### 兼容（补记 · 2026-09-23 对上游 `0.1.7-alpha.2` 的差分核验）

上游 `dsh-v0.1.7-alpha.2`（2026-09-22T15:49Z）发布后，对 `alpha.1...alpha.2` 做了**逐文件 SHA 比对**
（15k+ 文件）。结论：**本版对本插件零适配成本**，不需要改代码或产物。要点：

- **预设架构全套未变**（`agent-preset`、`agent-preset-registry`、`editing-cordis-compositions` 技能、
  `web-app/presets/{standard,ptc}.patch.yml` 逐字节相同、`agent-instructions`、`ui-conversation` 槽位、
  `plugin-manager` 工具层、`app-boot` 的 profile 装载）⇒ 2.1.0 的四项改动（落点／去提权／名册判据／两件套）
  与三条结构断言**继续成立**。
- **一处配置改名（本插件不涉及）**：`spill-policy` 的 `maxInlineBytes` → **`maxInlineTokens`**
  （字节→token；base 默认 `50000` → `12500`，省略即禁用保留）。
  已实测本方**没有任何地方设置** `spill-policy`／`maxInlineBytes`：预设组合包、profile 用户补丁、
  三个 link 插件的 patch、工作区插件树均无命中；`~/.dsh/cordis.patch.yml` 不存在。
  ⇒ 升级无需改配置。**但记住**：以后若要写这一行，键是 `maxInlineTokens`。
- **一处行为收紧（须知晓）**：`installFailLoud` 现在**同时**兜 `uncaughtException`
  （此前只兜 `unhandledRejection`）—— 进程内任意时点的未捕获异常都会变成一行诊断 + `exit(1)`。
  本插件自查：`diagnose()` 与全部 RPC 处理器都包了 try/catch，不留未捕获异常。
  其它 link 插件（尤其带长连接事件回调的）建议各冒烟一次。
- **两处与我们强相关的修复**：① 连续完成后台命令／一次性子代理后会话停住的问题已修，且
  **完成唤醒默认不再限次**（长链路自动化受益）；② Web 服务重启后"显示已连接却不再出回复"已修
  （原页在应用就绪后恢复连接并保留输入草稿）。

### 兼容

- **老配置不动即兼容**：`presetRoot` 显式给出时行为与 2.0.0 完全一致（只是不再自动安装、
  判据改用名册）。
- **已经生成过的旧预设**（`<dshHome>/preset-bundles/<id>/` 三件套）：仍可被宿主装载
  （多一个 `AGENTS.md` 不影响解析）；要不要搬进工作区由使用者决定 ——
  搬的话记得**同步 profile 依赖**（link 路径变了）并**重启宿主**。
- **旧目录式预设**（`<dshHome>/.agent-presets/<id>/`）仍不被读取，本版未改这一点。

## 2.0.0 — 未发布（工作区版本）

从「方法论技能包」升级为「AI学习插件」。这是一次形态变更，不是内容增补。

### ⚠️ 破坏性：预设改为声明式（DSH 0.1.7-alpha.1 起）

DSH 0.1.7-alpha.1 删除了目录式预设的读取端（`packages/preset/agent-presets`，
提交 `feat(preset): declare Agent compositions in profile YAML`）：预设改为
**普通 Cordis 声明行**（`@deepseek-ai/dsh-agent-preset`），由 bundle patch 承载。
旧式 `<dshHome>/.agent-presets/<id>/` 目录**不再被任何代码读取**（上游技能文档原话：
"Nothing reads that directory any more"）。

- **生成物变了**：`presetRoot` 默认值从 `<dshHome>/.agent-presets` 改为
  `<dshHome>/preset-bundles`；产物从 `preset.yml` + `agent.cordis.yml` + `AGENTS.md`
  变为 `package.json` + `cordis.patch.yml` + `AGENTS.md`（bundle 三件套）。
- **创建后自动安装**：`createPreset` 之后由 `pluginManager.installBundle` 装进 profile ——
  **只写盘不算预设存在**。宿主未提供该服务时如实降级为手动指引，不假装成功。
- **旧预设需手动迁移**：0.1.6-alpha.2 及更早生成的目录式预设不会自动转换，
  步骤见 `docs/迁移与兼容.md`「旧式目录预设的迁移」。
- **影响**：本版本要求宿主 **≥ 0.1.7-alpha.1**；仍在 0.1.6-alpha.2 及更早的，
  请继续用改版前的产物（那时写的是目录式预设）。
- **顺带修复**：`clean-test-state --only <id>` 此前一个也选不中 —— `planCleanup` 里
  `only === undefined || stateOnly ? readdir(...) : []` 意为"给了 `only` 就不扫目录"，
  于是 `presets` 恒为空、`applyCleanup` 什么也不删。现已总是扫目录再按 id 筛选。

### 新增

- **反复测试的清理工具** `scripts/clean-test-state.mjs`：把本插件留下的两类产物
  （① 它生成的预设目录 ② 工作区 `.dsh/learn-skills/` 状态）**干净清掉**。
  - **判据是文件里的生成标记**（`agent.cordis.yml` 首行"由 @yiyunet/dsh-learn-skills 生成"），
    **不是目录名** ⇒ 手工预设（如 `alpha`）永不被误删。
  - **影响面必须先看清**：**不加筛选**的 `--yes` 会删「该预设根下**所有**本插件生成的预设
    ＋ 工作区状态」；**只删一个**用 `--only <预设 id>`（推荐，或走 GUI「设置 → Agent 预设 → 删除」，
    那条路一次只删一个目录且有二次确认）。`--only` **默认不动**工作区状态，
    要动得显式加 `--with-state`。干跑输出会明确写出影响面，并在"插件生成预设 > 1"时给出警告。
  - **只读体检 `--scan`（识别残留用）**：逐类指出 `.dsh` 里的残留并给出对应清理命令 ——
    ①预设侧（缺件的**残缺**预设、插件生成但**显示名重复**的测试残留）；②登记侧
    （`~/.dsh/storages/workspace.json` 里 `path` **已不存在**的**孤儿登记**）；
    ③引用侧（工作区 `known.json` 记了、预设根却没有的**死引用** —— 会让同名再生成拿到 `-2` 后缀）。
    **只读**：给它 `--yes` 也不会删任何东西。
  - **流程文档 `docs/反复测试-清理流程.md`**：把"反复测试后怎么删"写成**六步＋复核**
    （体检 → GUI 删预设 → GUI 删工作区登记 → 删工作区文件夹 →（可选）删诊断日志 →
    重启宿主 → 再体检复核），并点明三处易错：**裸 `--yes` 会清空所有插件生成的预设**、
    **删工作区永远"先 GUI 后目录"**、**删了工作区文件夹就不必再"清工作区状态"**。
  - **默认干跑**（只列出会删什么），加 `--yes` 才真删；符号链接跳过不跟随。
  - **刻意不删工作区骨架**（`AGENTS.md`/`knowledge/`/`inbox/`…）：那里可能有用户自己的内容，
    而插件没有留下"哪些目录是它建的"的可靠记录 —— 宁可不删，也不越权。
  - 用法：`node scripts/clean-test-state.mjs`（干跑）／`… --only learn-1a2b3c --yes`（只删一个）／
    `… --yes`（全清）／`… --state-only --yes`（只清工作区状态）；
    执行后**须重启宿主**（预设名册一进程只挂载一次）。
- **输入区菜单**：会话输入区工具行新增 `[📖] AI学习 ▾`（`conversation.input.left`
  槽位，位于「工作区内修改」控件右侧）。菜单固定四项，顺序不变。
- **四入口流程**（斜杠命令 `/learn` 与菜单按钮共用同一实现）：
  - 初始预设：六轮互动问答 → 画像预览 → 确认 → 生成预设与工作区骨架；
  - 收集提炼：会话消息 → 候选知识（只进 `inbox/`，逐批裁决）；
  - 关联升级：候选 × 既有节点 → 变更清单 → 分栏确认 → 写入 → 可回滚；
  - 沉淀复用：只读体检 18 项 + 内容指纹对比 + 复用建议。
- **预设管理**：生成可被宿主加载的 `preset.yml` / `agent.cordis.yml` / `AGENTS.md`；
  显示名与内部 id 分离；重名拒绝而非覆盖；创建后有结构自证。
- **知识审核入库**：候选结构含稳定 id、批次 id、来源与消息定位、支持依据、
  用户处理决定、事实验证状态（**两个独立字段**）、初步关联。
- **可回滚的变更批次**：`.dsh/learn-skills/changes/<批次>.json` 变更日志；
  回滚不覆盖用户写入之后的新修改。
- **只读体检与基线**：`reports/<日期>-知识体系体检报告.md`；基线存
  `.dsh/learn-skills/audit.json`；报告默认只在会话展示，用户显式选择才落盘。
- **脱敏层**：报告、基线、日志统一过一遍（私钥、凭证键值对、授权头、厂商令牌、
  JWT、邮箱、手机号、本机路径中的用户名段）。
- **发布契约断言**：`npm run verify`，10 组断言，每条对应一个真实失败模式。

### 变更

- 工作区规则文件统一使用正确大小写 `AGENTS.md`。
- 唯一总索引固定为 `knowledge/framework.md`；节点固定进 `knowledge/nodes/`。
- 新增工作区状态目录 `.dsh/learn-skills/`（不碰宿主配置）。
- 技能从「直接落盘」改为「产出候选、经审核后落盘」；旧命令保留为引导入口。

### 兼容

- 旧版 10 个 `learn-*` 技能的触发语仍然可用，但**行为变了**：任何直接写正式知识或
  修改规则的旧路径都改为「先出候选/变更清单」。这是刻意的，详见
  `docs/迁移与兼容.md`。
- 既有工作区采用增量迁移：不覆盖、可恢复、重复运行不重复创建。

### 新增

- **缺内容节点：识别 + 确认重建 + 体检点名**（老板裁决：B 方案）。
  节点文件被手工编辑后 frontmatter 丢失 ⇒ 它解析不出 id ⇒ 对关联与升级**不可见**。
  现在按「**总索引有记录、文件却载入不了**」把它认回来：
  - **入口三**：检出后**先问一次**（`全部重建` / `逐个选` / `本轮不动` / `取消`）。
    选择重建 ⇒ 按本插件写入语义重写该节点（元数据取总索引那一行），
    **被覆盖的原文全文进变更日志**，`rollback` 可原样取回；不重建 ⇒ 保持原行为（拒绝覆盖，
    但报错**指向被保护的那个文件**，不再指向一个算出来、磁盘上并不存在的路径）。
  - **入口四**：体检的「知识库」项**点名**异常节点并出 `MISSING_NODE_CONTENT` 告警
    —— 补上此前"坏节点被当成正常节点计入数量"的漏报。判据与入口三**共用同一处实现**。
- **诊断出口补栏**：`gateTrace`（诊断那一遍）与 `failed[].gateDecision`（写盘那一遍）
  —— 两遍视图不一致时，这是唯一能分辨的凭据。

### 修复（工作区版本在测中暴露，均**先落到测试**再改实现）

- **生成的预设无法切换（实测真机，2026-09-21）**：预设生成成功、新会话里也能选到，
  但一切换就报
  「`1 row(s) did not activate: tool-fs-search (@deepseek-ai/dsh-tool-fs-search):`
  `invalid config: - $.sampleOverCapGlobResults missing required value`」。
  根因：`sampleOverCapGlobResults` 是**必填且无回退值**的配置项
  （`tool-fs-search/README.zh.md:42`："必填项且没有回退值，部署必须显式选择"；
  schema `z.boolean().required()` 见该包 `src/index.ts:98`），
  而本插件生成的 `agent.cordis.yml` 里这一行**没带 config** ⇒ 该行激活失败 ⇒
  整个预设切不过去。
  现在：模板显式写 `sampleOverCapGlobResults: false`，取值与 shipped 预设
  （`presets/{standard,ptc,cordis}`）及本机既有预设**逐字对齐**；
  并加了一条用例**直接断言生成的组合文件含该字段**（这类错只能靠"逐字对着宿主 schema 核"）。
  > 已经生成的旧预设文件不受模板影响，需**手工补这一行**或重新生成一份（见下方行动指南）。
- **真机三连反馈（界面与问答，2026-09-21）**：菜单终于能跑通六题问答、也能出预览了，
  但暴露三处问题，逐条修：
  - **① 重进「初始预设」总是从第 1 题重问一遍**（用户体感＝"重复的问题"）。
    根因：六题答完后的答案**就在磁盘上**（`phase: 'awaitingReview'`），而 `resumed`
    这个变量**算了却没用上** —— 每次进入都无条件走完整六题。
    现在：非 `restart` 且上一轮答案已答完时，**直接回到预览、一次不问**；想重答有显式出口
    （`init({restart:true})` ⇄ 界面上的「重新回答」按钮）。
  - **② 预览面板"最前面内容看不到、最后面没有提交按钮"** ⇒ 无法点击生成 ⇒ **③ 没有生成任何预设**。
    根因：操作按钮**只放在面板头部**，正文一长、往下滚读就再也够不着「确认创建」
    （面板本身是 `maxHeight + overflow:auto`，头不是 sticky）。
    现在：头与尾**都 sticky**，主操作在末尾**常驻一份**（「确认创建」／「确认写入」／
    「保存报告」），并附一句"确认后才会写入"的说明。
  - **④ 第 2/4/5/6 题的选项里出现两个「暂不填写」**。根因：`nav.options` 里**已经**含
    `SKIP_OPTION`，这四题又各加了一次（第 3 题早先单独修过，其余漏了）。
    现在四题统一改为只经 `nav.options` 取一次，并由用例**逐题比对选项标签**钉死。
- **输入区菜单「执行失败」（实测真机，紧接 404 之后）**：404 修好后点菜单变成一句
  没头没尾的「执行失败」。这是**两处互相掩盖**的缺陷：
  - **宿主侧（真因）**：RPC 路径提问**从不带 agent**。`user-questions/request` 是
    **Scoped<Agent>** 事件、UI 应答者注册在 **Agent 作用域**；不带 agent 时宿主的瀑布
    跑在 **root 面** ⇒ 没人应答 ⇒ 抛 `NO_PROVIDER`
    （`user-questions/src/index.ts:130-136`）。**斜杠命令没这个问题**（它本就在 agent
    调用栈里），所以只有 RPC 路径会撞上。现在 `ask()` 先用会话 id 取那个 **live agent**
    并带上；取不到、或身份/根校验不过，就**宁可不带**（宿主的前置自校见同文件 `:93-107`）。
  - **客户端侧（放大器）**：信封摊平函数是个**空壳**（`return result`）。宿主失败信封是
    `{ok:false, error:{code,message}}`，界面读 `payload.message`（浅了一层）⇒ 真因被丢，
    只剩兜底文案「执行失败」；成功路径同样错位（真值在 `value` 里，各面板读
    `payload.preview` 一律为空）。现已抽成纯函数 `plugin-src/client/envelope.mjs`
    并配 `test/envelope.test.mjs`（8 条）。
  - **诊断**：RPC 层把每次失败（method + code + message）写进诊断出口 —— 界面即便只显示
    一句话，真因也能在 `~/.dsh/learn-skills-boot.log` 里查到。
- **输入区菜单 404（实测真机，本轮头号缺陷）**：`registerLearnRpc` 原先只在 `apply()`
  那一刻判一次 `ctx.connection`；而 `connection` 属于 Web 运行时那一层、**常常晚于
  本插件激活**（插件只静态 inject `userQuestions` / `commands`）⇒ 早到就**永久放弃注册**。
  症状极具迷惑性：**菜单能弹**（客户端半侧独立装载）、**斜杠命令 `/learn` 可用**，
  唯独点菜单报 `transport failure for /api/dsh-learn-skills: HTTP 404`；
  而 147 项用例全绿 —— 因为**这条路径从来没有被测过**。
  现在改为**两段式注册**：就绪即注；未就绪则 `ctx.inject(['connection'], …)`
  挂到它就绪之后再注（`connection` 仍**不进**静态 `inject`，以免在无 Web 运行时的
  部署里整体 inactive）。配套三项：① 注册状态如实汇报（此前日志**无条件**写
  "RPC /api/…"，注册失败时等于在撒谎）② `verify` 增一条"必须存在延迟注册"的断言
  ③ 新增 `test/rpc.test.mjs`（注册时机 / 路径口径 / 信封契约三组）。
- **节点文件形态鲁棒性**：frontmatter 解析对「前置空行 / CRLF 行尾 / BOM」的容忍。
  此前少一层容忍，边缘形态会让**整块 frontmatter 被静默丢弃** → 该节点在内存里
  不存在 → 关联失效，症状表现为「关联明明在，却判成新增」，离真因很远。
- **拒绝覆盖真正生效**：写基线（`.dsh/learn-skills/known.json` 的 `writeShas`）持久化
  「我方上次写入的指纹」。此前判据是**本次升级刚读到的指纹** —— 用户若在上一次升级
  之后手改过文件，它恰好等于用户的内容，于是插件会**静默覆盖用户的手改**。
  现在：内容与写基线不符 → 拒绝覆盖并如实列入 `failed`；回滚会同步撤销对应基线
  （否则文件被自己回滚过、却再也写不进去）。
- **产物与真源不同步可被测试抓到**：`npm test` 新增「宿主产物 vs 真源」逐字比对。
  此前 `plugin-src/` 改对、`lib/` 未重建时**测试全绿而线上照旧出错** ——
  测试跑的是源码，DSH 加载的是 `lib/`。

### 测试

- 新覆盖三条此前测不到的路径：① 节点文件的前置空行 / CRLF / 无 frontmatter 形态
  （并断言"缺 id 的节点被**报出来**"，而不是悄悄少一个）；② 升级的写基线判据
  双向（用户改过 → 拒绝；没改过 → 照旧补写；基线被改坏 → 拒绝）；③ 产物漂移。
- **`test/rpc.test.mjs`（新增）**：RPC 注册的**时机**（未就绪必须延迟注册，不许当场放弃）
  / **路径口径**（必须带 `/api/` 前缀，判据复刻自宿主 `rpc-host.ts` 的
  `endpointFromPath` 与 `assertFetchRoute`）/ **信封契约**（未知 method、
  未知 method 的 `details` 必须是对象、非法 JSON 走 400）。
  这三组正是"147 项全绿但真机 404"漏掉的那条缝。
- **`test/envelope.test.mjs`（新增 8 条）**：客户端信封摊平——成功要摊平（否则各面板
  渲染为空）、失败要摊平（否则只剩兜底「执行失败」）、异常输入不抛。
  客户端的这段逻辑此前**根本没有测试面**（`impl.mjs` 依赖 React，node 里测不了），
  现在它是个零依赖纯函数模块，测得到。
- **`test/flows.test.mjs`（新增 3 条）**：提问必须带上 live agent（有则带、取不到不带、
  身份对不上不带）—— 对应"点菜单报执行失败"的宿主侧真因；斜杠命令覆盖不到这条路径。

### 尚未验证

- **延迟注册在真机上是否真的生效**：待 `npm run check`（重建 `lib/`）**＋ 重启宿主**后
  由输入区菜单实测确认。诊断留痕见下条。
- **临时诊断出口**：宿主半侧会把装载与注册结论追加到 `~/.dsh/learn-skills-boot.log`
  （`apply() 已调用` / `connection 未就绪` / `RPC 已注册 path=…` / `RPC 状态终值`）。
  **发布前须移除或改为默认关闭** —— 用户家目录里不该长期躺着运行日志。
- 公开发布（npm）未执行；`dsh plugin --profile web add @yiyunet/dsh-learn-skills`
  在发布并回读确认之前**不可用**。
- 宿主兼容矩阵只对 `0.1.5-alpha.1` 标 `verified`，其余版本标 `unknown`（未实测）。
