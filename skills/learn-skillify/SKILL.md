---
name: learn-skillify
description: 把可重复的操作流程沉淀为一个新 Skill（SKILL.md，含 frontmatter），供模型按需加载。
whenToUse: 出现可复用的操作流程或方法论，需要沉淀成技能时。
user-invocable: true
---
# learn-skillify：沉淀技能

## 目标
把可复用流程变成 `SKILL.md` 技能。

## 步骤
1. 判断流程是否可重复、是否有明确触发场景（没有则先不沉淀）。
2. 选定位置：跨工作区 → `~/.dsh/skills/<name>/SKILL.md`；仅本工作区 → `<工作区>/.dsh/skills/<name>/SKILL.md`。
3. 写 frontmatter：`name`（kebab-case）、`description`（像搜索索引，写明「何时用 + 做什么」）、`whenToUse`、可选 `disable-model-invocation` / `user-invocable`。
4. 正文写步骤、铁律、示例；目录包可加资源文件。
5. 验证：frontmatter 必须有 name 和 description（缺失会被忽略）；确认可从技能目录被加载。

## 铁律
- name 用 kebab-case（小写 + 连字符）。
- description 决定自动调用率，写清楚触发场景。
