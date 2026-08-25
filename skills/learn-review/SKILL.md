---
name: learn-review
description: 当用户说「生成周报」「本周复盘」「输出倒逼输入」「出周报」时使用。扫描 inbox 与知识节点，按 reports/ 模板生成周报（reports/YYYY-MM-DD-周报.md），必填「下周输入计划」。
whenToUse: 用户要求生成定期复盘周报；或到周报日触发复盘。
---

# learn-review：生成周报（输出倒逼输入）

## 目标
按标准模板产出本周复盘周报，并用「下周输入计划」倒逼下周输入。

## 前置
1. 读 `reports/README.md`（流程）与 `reports/周报模板.md`（模板）。
2. 本技能只复盘沉淀，不替代 `learn-distill` 的节点加工。

## 步骤
1. **盘点输入**：glob `inbox/*`（排除 README.md 与已处理项）；读 `knowledge/nodes/` 版本记录与 `knowledge/framework.md`。
2. **按模板填写**：复制 `reports/周报模板.md` 内容逐段填写；「下周输入计划」至少 1 条、具体可执行。
3. **落盘**：写入 `reports/YYYY-MM-DD-周报.md`（日期 = 今天，建议周日）。
4. **归档**：把 inbox 已处理条目移到 `inbox/processed/`。
5. **报告**：返回周报路径 + 一句话总结。

## 模板要点（五段）
一、本周输入盘点 ／ 二、知识库变化（按框架五层归类）／ 三、差距与堵点 ／ 四、下周输入计划（必填）／ 五、自评。

## 铁律
- 下周输入计划必填，不许留空（这是倒逼输入的核心）。
- 只复盘不臆造：本周没做的输入如实写「无」。
- 模板与流程以 `reports/README.md` 与 `reports/周报模板.md` 为准（可能演进）。
