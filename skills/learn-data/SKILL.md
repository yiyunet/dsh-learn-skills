---
name: learn-data
description: 处理工作区 data/ 目录的本地数据表：调取（read）→ 定位（grep）→ 分析（筛选/聚合/占比）→ 输出。当用户说「读 data/xxx.csv 分析」「处理数据表」「算某产品销量 / 区域 GMV / 占比」时使用。负责按格式分档处理 CSV/TSV/Markdown/JSON，二进制表先引导转换，超大表先抽样，结论附计算过程。
whenToUse: 用户要求分析工作区 data/ 下的本地数据表（CSV/TSV/Markdown/JSON），做筛选、聚合、占比等计算，或询问数据文件怎么放、怎么读。
user-invocable: true
---

# learn-data：本地数据表分析（data/ 目录）

## 目标
把工作区 `data/` 里的私有数据表变成分析结论：**调取 → 定位 → 分析 → 输出**，结论附计算过程与口径。

## 前置
1. 先读本工作区 `data/README.md`，确认当前存放与命名约定（约定可能演进，以 README 为准）。
2. 本技能只处理「待分析的数据」，不处理「待蒸馏的知识」（知识走 `learn-collect`/`learn-distill`）。

## 步骤
1. **确认数据可读**：按格式分档判断能否直接读。
   - ① 直接 `read`：CSV/TSV（UTF-8，中文带 BOM 兼容 Excel）、Markdown 表格、JSON/JSONL。
   - ② 需先转换（当前预设无 shell 工具，解析不了二进制）：XLSX/XLS → Excel「另存为 CSV（UTF-8）」；PDF 表格/截图 → pandoc / camelot / tabula / OCR 转文本，或用户直接贴内容。
   - 格式易用性排序：CSV/TSV > Markdown 表格 > JSON/JSONL > HTML 表格 > XLSX > SQLite > XLS > PDF 表格 > 截图。
2. **提问句式引导**：「读 data/xxx.csv，A 产品最近 6 个月销量是多少？美国区域 GMV 占比是多少？」——文件名 + 指标明确，agent 自动完成后续。
3. **分析四步**：
   - `read` 调取 → 看表头、字段、行数。
   - `grep` 定位 → 按关键词/日期过滤相关行。
   - 筛选/聚合/占比 → 如按 `product` 过滤 + 日期窗口过滤后 `SUM(units)`；占比 = `SUM(条件值)/SUM(总值)`。
   - 输出 → 聊天直接给「结论 + 计算过程」；需留档写 `reports/YYYY-MM-DD-主题-分析.md`（可被 session_search 检索）。
4. **报告**：返回文件路径（如写入 reports/）或直接给结论。

## 数据约定（与 data/README.md 对齐）
- 命名：`YYYY-MM-主题.csv` 或 `主题-版本.csv`，文件名避免空格与特殊字符。
- 字段：一行表头、一列一字段、一行一记录；不合并单元格、不分节标题行。
- 日期：ISO 8601（`YYYY-MM-DD`），避免 `2026/2/1`、`2月1日` 歧义写法。
- 编码：中文 CSV 用 UTF-8 带 BOM（Excel 双击可读）；要保数字/日期类型用 JSON/JSONL。
- 规模：纯文本工具结果有 model-facing context cap；数万行以上先抽样/聚合或拆表，别直接塞上下文。

## 铁律
1. **不编造**：每个数字来自文件实际内容；读不全就标注「该字段无数据」，不臆测。
2. **口径明确**：聚合前说明过滤条件与口径（如「近 6 个月 = 2026-03-01 ~ 2026-08-31」）。
3. **二进制先转**：XLSX/PDF/截图解析不了时先引导转换，不硬读。
4. **超大表先抽样**：先看行数，超限先抽样/聚合再分析。
5. **与 MCP 分工**：私有/公司数据走本地 `data/`；Amazon 等公开数据直接走 MCP（如 asin_prediction 近 14 个月销量），不必上传。

## 示例
- 「读 data/2026-08-sales.csv，B 产品最近 3 个月销量」→ `read` 表头 → `grep "B"` → 日期窗口过滤 → `SUM(units)` → 输出结论+过程。
- 「读 data/2026-08-sales.csv，美国 GMV 占比」→ `SUM(gmv where region=US) / SUM(全部 gmv)` → 输出占比+过程。
