---
name: learn-distill
description: 从 inbox 内容提炼知识，写入或更新知识节点（version+1），建立双向关联并迭代旧内容。
whenToUse: 处理 inbox 内容、把新知识挂到框架节点、更新旧节点时。
user-invocable: true
---
# learn-distill：提炼·关联·迭代

## 目标
把收集箱内容变成 `knowledge/nodes/N*.md` 节点，并保持知识图连通。

## 步骤
1. 读 `knowledge/framework.md` 定位并判断：新节点 / 更新现有节点 / 作废旧节点。
2. 新节点：分配新 ID（N 递增），按 framework.md 里的节点模板建文件。
3. 更新节点：改正文，`version + 1`，`updated` 改今天，`sources` 追加来源；旧要点保留在「版本记录」里，不静默覆盖。
4. 关联：更新本节点 `links`，并同步到每个被关联节点的 `links`（双向）。
5. 作废：`status` 改 superseded 或 archived，在 framework.md 的 archive 区登记被什么替代。
6. 完成后同步更新 `knowledge/framework.md` 的节点目录行（版本 / 日期 / 状态）。

## 节点内容标准
- 「核心要点」3 条以内，是未来提炼进 AGENTS.md 的候选。
- 「细节」放事实与依据，每条尽量带源码路径或来源。
- 结论必须可验证，不确定的标注「待验证」。

## 铁律
- 蒸馏不删原文；版本记录保留迭代痕迹。
- 不确定分类先问用户。
