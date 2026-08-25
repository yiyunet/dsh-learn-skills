# DSH learn-* 技能包（知识体系方法论）

一套可在 DeepSeek Harness（DSH）里「一句话搭建知识体系框架」的技能族。

## 这是什么
`learn-*` 是「学任何工具 / 建任何领域知识库」通用的方法论技能，把
**收集 → 提炼 → 关联 → 升级 → 沉淀 → 复用** 的六步流水线做成可复用技能。

## 技能清单
| 技能 | 一句话 |
|---|---|
| learn-scaffold | 一句话搭建知识体系框架（AGENTS.md + index/ + inbox/ + knowledge/ + reports/ + .dsh/skills/） |
| learn-collect | 新内容收集入库 inbox/ |
| learn-distill | 从 inbox 提炼知识节点（version+1、sources、links） |
| learn-pipeline | 收集→提炼→关联→升级 总入口 |
| learn-index | 定期梳理 index/ 外部原料，更新框架与节点 |
| learn-review | 生成周报（输出倒逼输入） |
| learn-upgrade | 升级 framework.md 索引 + 刷 AGENTS.md（大脑） |
| learn-skillify | 把流程沉淀为新技能 |
| learn-web-collect | URL → inbox 标准化条目 |

## 目录结构
```
dsh-learn-skills/
├── README.md
├── install.sh          # macOS/Linux 一键安装
├── install.ps1         # Windows 一键安装
└── skills/
    └── learn-*/SKILL.md
```

## 安装

### 前置
- 已装 DeepSeek Harness：`npx @deepseek-ai/dsh web`
- 技能发现根：`~/.dsh/skills`（全局）或 `<工作区>/.dsh/skills`（仅该工作区）

### 方式一：一键安装
```bash
git clone https://github.com/yiyunet/dsh-learn-skills.git
cd dsh-learn-skills
./install.sh        # macOS/Linux
# Windows PowerShell： .\install.ps1
```
脚本会把 `skills/` 下所有 `learn-*` 复制到 `~/.dsh/skills/`。

### 方式二：手动安装
把 `skills/learn-*/` 整个目录复制到 `~/.dsh/skills/`（全局）或 `<工作区>/.dsh/skills/`（仅该工作区）。

## 使用（安装后请【新建会话】再触发）
- 「**搭建知识体系框架，主题是跨境选品**」→ learn-scaffold 生成完整框架
- 「**复刻 learn 框架**」/「**初始化学习工作区**」→ 同上
- 「**梳理 index 目录**」→ learn-index 定期梳理外部信息
- 「**生成周报**」→ learn-review
- 或消息首行输入 `/learn-scaffold`、`/learn-index` 等斜杠命令

## 说明
- `learn-scaffold` 生成的框架会引用 learn-* 全家，建议整包安装，后续才能完整跑通。
- `learn-index` 的「定期梳理」依赖 DSH schedule，且 schedule 只在会话 live 时跑；未配 schedule 可手动说「梳理 index 目录」或借周报提醒。
