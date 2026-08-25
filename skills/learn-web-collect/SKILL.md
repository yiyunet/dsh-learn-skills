---
name: learn-web-collect
description: 当用户给一个网页 URL 并要求把页面内容抓取、补全标准字段、保存为 inbox/ 的 YYYY-MM-DD-主题.md 时使用。负责抓取页面要点（或指导用户用 pandoc/jina/trafilatura 抓全文）、补来源/日期/类型字段、按 inbox/README.md 格式落盘。
whenToUse: 用户给 URL 并要归档页面到 inbox；或说「抓这个网页存进收集箱」。
---

# learn-web-collect：网页 URL 收集入 inbox

## 目标
把用户给的网页 URL 提取内容，补全标准字段，保存为 `inbox/YYYY-MM-DD-主题.md`。

## 前置
1. 读本工作区 `inbox/README.md`，确认当前命名与条目格式（格式可能演进，以 README 为准）。
2. 本技能只收集、不提炼；提炼交给 `learn-distill`。

## 步骤
1. **确认主题与日期**：向用户确认主题（一句话概括）；用户没给时从页面标题提取。日期取今天（`YYYY-MM-DD`）。
2. **抓取内容**（按保真度选路径）：
   - **路径 A（默认，我直接执行）**：用 `web_search` 抓取页面要点与来源片段，适合「归档要点、不需逐字全文」的场景。
   - **路径 B（用户要全文保真时）**：把下面任一命令交给用户在终端自己跑，跑完贴回或直接放 `inbox/`：
     - Jina Reader（零安装，直接返回 Markdown）：
       `curl -s "https://r.jina.ai/<URL>" -o "inbox/YYYY-MM-DD-主题.md"`
     - trafilatura（抽正文最干净，去广告导航）：
       `pip install trafilatura`，再 `trafilatura.extract(html, output_format="markdown")`
     - pandoc（保留页面结构最全）：
       `curl -sL "<URL>" | pandoc -f html -t gfm -o "inbox/YYYY-MM-DD-主题.md"`
3. **补标准字段头部**：来源（URL，必填）、日期、类型（`新机制 | 修正 | 补充细节 | 待分类` 四选一）、预判关联节点（可选，不确定写「待分类」）。
4. **落盘**：用 `write` 工具写入 `inbox/YYYY-MM-DD-主题.md`。
5. **报告**：返回文件路径。

## 标准条目模板
```markdown
# 主题（一句话）

- 来源：<URL>（必填）
- 日期：YYYY-MM-DD
- 类型：新机制 | 修正 | 补充细节 | 待分类
- 预判关联节点：待分类

## 原始内容 / 摘要
（这里贴抓取到的正文或要点）
```

## 铁律
- 来源（URL）必填；抓不到正文就在文件里标注「未抓全 / 待验证」。
- 只收集不提炼，不在此阶段写节点。
- URL 无效或抓取失败时先问用户，不臆造页面内容。
- 文件名日期打头、`.md` 结尾、避开 `README.md`（流水线会跳过它）。
