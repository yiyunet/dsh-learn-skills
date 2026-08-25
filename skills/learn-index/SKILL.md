---
name: learn-index
description: 当用户要「梳理/消化 index/ 目录下外部收集的信息」，把原材料判型提炼进 knowledge/framework.md 与 knowledge/nodes/（version+1）时使用；也可由 schedule 定期触发。
whenToUse: 用户要求梳理 index 目录、消化外部收集信息、定期把 index 原材料更新进知识框架与节点时。
user-invocable: true
---
# learn-index：定期梳理外部信息 → 更新知识框架与节点

## 目标
把 `index/` 里外部收集的原始信息，判型、提炼进 `knowledge/framework.md` 与 `knowledge/nodes/`，并归档已处理原料。

## 前置
1. 读 `index/README.md`（流程）与 `knowledge/framework.md`（判型与节点模板）。
2. 本技能管「index → 知识」；若条目已标准化在 `inbox/`，走 `learn-distill`。

## 步骤
1. **盘点**：glob `index/*`（排除 `README.md` 与 `index/processed/`）。
2. **判型**：对照 framework.md，逐条判「新节点 / 更新现有节点 / 作废」。
3. **提炼**：新节点按节点模板建 `knowledge/nodes/N*.md`；更新节点 `version+1`、`sources` 追加、旧要点留「版本记录」；作废改 `superseded`/`archived`。
4. **收敛**：同步更新 `knowledge/framework.md` 节点目录行（版本/日期/状态）；稳定规则候选交 `learn-upgrade`。
5. **归档**：已处理条目移到 `index/processed/`。
6. **报告**：列出更新的节点 + 一句话总结。

## 定时触发
- schedule 只在会话 live 时跑；给 live 会话配 schedule 定时触发本技能，或手动说「梳理 index 目录」。
- 未配 schedule 时，可借周报（learn-review）顺带提醒梳理 index/。

## 铁律
- 蒸馏不删原文：原料归档保留，不覆盖。
- 不确定判型先问用户。
- 来源缺失先向用户要，不臆造来源。
