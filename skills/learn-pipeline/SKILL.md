---
name: learn-pipeline
description: 学习流水线总入口：依次执行收集、提炼、关联、升级，把 inbox 新内容完整加工进知识库。
whenToUse: 用户说「处理 inbox」、跑完整学习流水线、或批量消化新内容时。
user-invocable: true
---
# learn-pipeline：学习流水线（总入口）

## 目标
一条指令把 inbox 内容完整加工：收集 → 提炼 → 关联 → 升级 → 沉淀。

## 步骤
1. 扫描 `inbox/` 所有待处理文件（排除 README.md）。
2. 对每个文件按序执行：
   a. 提炼：按 learn-distill 流程，写或更新节点（version+1、sources、links）。
   b. 关联：同步被关联节点的 links。
3. 全部处理后：按 learn-upgrade 流程，升级 framework.md 索引并刷新 AGENTS.md。
4. 若提炼中识别出可复用流程，按 learn-skillify 沉淀为技能。
5. 处理完标记 inbox 文件（移到 inbox/processed/ 或加「已处理」前缀），报告改动清单。

## 铁律
- 逐个文件处理，不跳跃。
- 遇模糊分类或缺来源，停下来问用户。
- 结束时给出一句话改动总结 + 每个文件路径。
