---
name: learn-scaffold
description: 当用户要「搭建/复刻/初始化」一套知识体系框架（AGENTS.md + index/ + inbox/ + knowledge/framework.md + knowledge/nodes/ + reports/ + .dsh/skills/，配套六步学习流水线与 index 定期梳理）时使用。生成与 learn 方法论同构、可直接照用的工作区骨架与全部模板文件。
whenToUse: 用户要求搭建知识库、初始化学习工作区、复刻 learn 框架、生成知识体系骨架时。
user-invocable: true
---
# learn-scaffold：一键搭建知识体系框架

## 目标
在目标工作区一次性生成一套与「learn 方法论」同构的知识体系骨架：大脑（AGENTS.md）+ 外部原料库（index/）+ 收集箱（inbox/）+ 唯一索引（framework.md）+ 知识节点（nodes/）+ 周报（reports/）+ 技能目录（.dsh/skills/）。

## 步骤
1. 确认目标工作区根目录；把占位符 `<主题>` 替换为用户领域名，`<YYYY-MM-DD>` 替换为今天。
2. 创建目录：`index/`、`inbox/`、`knowledge/nodes/`、`reports/`、`.dsh/skills/`。
3. 按「文件模板」写入七个文件（见下），代码块与三反引号保真。
4. 按「自查清单」核对后，报告已生成文件清单 + 一句「框架搭建完成，从『把第一条经验写进 inbox/』开始」。

## 文件模板（七个文件，按原文写入）

### 1. AGENTS.md
```markdown
# <主题>学习工作区

本工作区用于系统性学习 <主题>。回答问题请解释机制原理、引用来源路径、说明可验证依据。

## 核心心智模型（稳定层，勿堆细节）
- （写本主题 2~4 条不会过时的核心原则，例如：一句话定位、一个底层模型、一条闭环）
- 定时循环 = schedule（会话 live 才跑，如定期梳理 index/ 更新框架与节点）

## 知识库指针
- 完整框架索引：knowledge/framework.md（新内容先读它，定位节点）
- 知识节点：knowledge/nodes/N*.md（每个节点带 version / sources / links）
- 外部原料库：index/（外面收集的原始信息；定期用 learn-index 梳理后更新框架与节点）
- 收集箱：inbox/（标准化条目先丢这里，待加工）
- 方法论技能：~/.dsh/skills/learn-*（学习流水线，学任何工具通用）
- 周报输出：reports/（周报模板与存档；输出倒逼输入，流程见 reports/README.md）

## 学习流程（六步）
1. 收集：新内容入 inbox/（带来源/日期）
2. 审阅：对照 framework.md 判型（新节点/更新/作废）
3. 提炼：按节点模板写入，version+1，记录 sources
4. 关联：更新 links 并同步到被关联节点（双向）
5. 收敛：升级 framework.md 索引；稳定规则刷新本文件；可复用流程沉淀为技能
6. 复用：会话自动带大脑，细节查节点，流程加载技能

## 铁律
- 蒸馏不删原文：旧会话靠 session_search 可查，放心删繁就简。
- 本文件只加「不会过时的原则」，细节一律进节点版本记录。
- 不确定的分类先问，不臆造结论；一切结论附来源依据。
```

### 2. knowledge/framework.md
```markdown
# <主题> 知识框架（v1.0）

> 唯一索引。新增/合并/作废节点都先改这里。节点 ID 永久稳定，仅在重大重构时重排。
> 本文件的「心智模型」段与 `../AGENTS.md` 保持镜像——改动时同步两处。

## 心智模型（稳定层，镜像到 AGENTS.md）
- （写本主题 2~4 条核心原则，与 AGENTS.md 保持一致）
- 定时循环 = schedule（会话 live 才跑，如定期梳理 index/ 更新框架与节点）

## 学习路径（递进编排）
> 按「会用 → 懂原理 → 会扩展 → 会沉淀 → 有视野」的学习逻辑编排，可替换为主题自己的递进。
> 参考：Harness 学习工作区用 L1上手 → L2心智模型 → L3能力扩展 → L4方法沉淀 → L5视野。

| 层 | 主题 | 节点 | 一句话定位 |
|---|---|---|---|
| L1 | 上手 | N01 示例节点 | 先用起来 |

## 节点目录
| ID | 层 | 标题 | 状态 | 版本 | 更新 |
|---|---|---|---|---|---|
| N01 | L1 | 示例节点 | active | 1 | YYYY-MM-DD |

## 作废区（archive）
（暂无）

## 节点模板
（此处嵌入一个 ```markdown 代码块，内容见下方「节点模板内容」）
```

### 节点模板内容（作为 ```markdown 代码块写入 framework.md 的「节点模板」段）
```markdown
---
id: Nxx
title: 标题
status: active        # active | superseded | archived
version: 1
updated: YYYY-MM-DD
tags: []
sources: []           # 源码路径 / 会话名 / URL
links: []             # 关联节点 ID
---
# 标题
## 核心要点（3 条以内，供 AGENTS.md 提炼）
## 细节
## 版本记录
- v1 (YYYY-MM-DD)：初稿
```

### 3. knowledge/nodes/N01-示例节点.md
```markdown
---
id: N01
title: 示例节点
status: active
version: 1
updated: YYYY-MM-DD
tags: [示例]
sources: []
links: []
---
# 示例节点

## 核心要点
1. 这是知识节点的标准形态：frontmatter + 核心要点 + 细节 + 版本记录。
2. 每次更新 version+1，并在「版本记录」里留一条说明，不静默覆盖。

## 细节
- 正式内容从这里开始，按需补充。

## 版本记录
- v1 (YYYY-MM-DD)：初稿，示范格式。
```

### 4. index/README.md
```markdown
# 外部信息原料库（index）

> 学习流水线的「外部原料库」——外面收集到的信息（网页、资料、导出数据、他人分享）原样放进来的暂存区；智能体定期梳理这里，更新知识框架与知识节点。

## 定位
外部收集的原始信息先进 index/，由智能体定期梳理（learn-index），判型提炼后更新 knowledge/framework.md 与 knowledge/nodes/。

## 与 inbox/ 的分工
- index/ = 外部收集的原始信息（未整理）→ 定期 learn-index 梳理 → 更新框架/节点
- inbox/ = 已标准化的待提炼条目 → learn-distill 提炼 → 写/更新节点

## 文件命名
YYYY-MM-DD-主题.md（或保留原文件名）；来源必填。

## 定期梳理流程（learn-index）
index/（外部原料）→ learn-index 梳理（判型→提炼→收敛）→ framework.md + nodes/N*.md（version+1）→ 归档 index/processed/
触发方式：schedule（会话 live 时）或手动说「梳理 index 目录」

## 铁律
- 原料归档不删除，保留溯源。
- 来源缺失先向用户要；不确定判型先问。
```

### 5. inbox/README.md
```markdown
# 收集箱（inbox）

> 学习流水线的「收集箱」——标准化条目的暂存区，不是产出目录。

## 定位
任何新知识、新经验，先进 inbox 暂存为「标准化条目」，再被提炼进知识节点（knowledge/nodes/），最终沉淀为铁律（AGENTS.md）。

## 流水线
```
inbox/（标准化条目）→ learn-distill 提炼 → knowledge/nodes/N*.md（version+1）
→ learn-upgrade 升级 → framework.md（索引）+ AGENTS.md（大脑）
```

## 文件命名
YYYY-MM-DD-主题.md

## 标准条目格式
```markdown
# 主题（一句话）
- 来源：URL 或会话名（必填）
- 日期：YYYY-MM-DD
- 类型：新机制 | 修正 | 补充细节 | 待分类
- 预判关联节点：N0x（可选，不确定写"待分类"）

## 原始内容 / 摘要
（贴原文或自己总结，保留关键信息）
```

## 处理流程（六步）
收集 → 审阅 → 提炼 → 关联 → 升级 → 沉淀（对应技能 learn-collect / learn-distill / learn-upgrade / learn-skillify）。
```

### 6. reports/README.md
```markdown
# 输出环节（周报）说明

> 用途：输出倒逼输入——每周固定产出一份复盘周报，用「下周输入计划」倒逼定期输入。

## 目录约定
- 周报存档：reports/YYYY-MM-DD-周报.md（建议每周日）
- 模板：reports/周报模板.md

## 周报流程（五步）
1. 盘点输入：扫描 inbox/ 待处理条目、knowledge/nodes/ 版本记录、近期会话主题
2. 复盘提炼：本周新增/更新了哪些节点，对照 framework.md 学习路径归类
3. 找差距：哪些主题还空白/薄弱
4. 定计划：写下周输入计划（必填，不许留空，这是倒逼输入核心）
5. 归档：报告存入 reports/；inbox 已处理条目移到 inbox/processed/

## 检查清单
- [ ] 日期与周期正确
- [ ] 输入盘点完整
- [ ] 知识库变化按层级归类
- [ ] 下周输入计划 ≥1 条且具体可执行
- [ ] 自评诚实（没做的写「无」）
```

### 7. reports/周报模板.md
```markdown
# 周报：<本周主题一句话>
- 周期：<YYYY-MM-DD> ~ <YYYY-MM-DD>
- 报告日期：YYYY-MM-DD

## 一、本周输入盘点（学了什么）
- 新增 inbox 条目：
- 新增/更新节点（含 version 变化）：
- 会话/阅读主题：

## 二、知识库变化（按框架层级归类）
- L1 上手：
- L2 心智模型：
- L3 能力扩展：
- L4 方法沉淀：
- L5 视野：

## 三、差距与堵点（还有什么没学）
- 空白/薄弱主题：
- 疑问/待验证：

## 四、下周输入计划（倒逼输入，必填）
- [ ] <主题>：<来源/渠道> → 预期产出（新节点 / 更新 Nxx / 新技能）

## 五、自评
- 本周输入质量：满意 / 一般 / 不足
- 下周改进：
```

## 自查清单
- [ ] AGENTS.md、knowledge/framework.md、knowledge/nodes/N01-示例节点.md、index/README.md、inbox/README.md、reports/README.md、reports/周报模板.md 均已生成
- [ ] `index/`、`inbox/`、`knowledge/nodes/`、`reports/`、`.dsh/skills/` 目录均已创建
- [ ] framework.md 的「节点模板」段含一个成对的 ```markdown 代码块（内容为节点模板）
- [ ] 占位符 `<主题>`、`<YYYY-MM-DD>` 已替换为真实值

## 铁律
- 占位符必须替换为真实值，不留给用户填空。
- framework.md 里「节点模板」的 ```markdown 代码块必须三反引号成对、原样保留。
- 先确认目标路径再写；目标已有同名文件时先询问用户，不静默覆盖。
