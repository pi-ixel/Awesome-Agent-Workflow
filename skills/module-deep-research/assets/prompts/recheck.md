# 模块认知专家级审查 {{TASK_ID}}

本轮只审查现有认知资产，不把“章节已填写”当成通过。目标是验证这些资产是否足以解释行为、预测边界场景并支持安全变更。

## 审查对象

- 模块：`{{MODULE}}`
- 源码范围：`{{SOURCE_PATH}}`
- 认知资产：`{{ASSET_ROOT}}`
- 资产规范：`{{ASSET_SPEC}}`
- 文档模板：`{{TEMPLATE_DIR}}`
- 研究基线提交：`{{BASELINE_COMMIT}}`
- 当前提交：`{{CURRENT_COMMIT}}`

## 当前稳定认知资产

{{STABLE_ASSETS}}

## 已完成研究

{{COMPLETED_CONTEXT}}

## 未解问题

{{OPEN_ISSUES}}

## 建议优先取证位置

{{EVIDENCE_HINTS}}

## 审查方法

{{METHOD}}

## 通过标准

{{ACCEPTANCE}}

## 问题处理

{{EXPANSION_TRIGGERS}}

## 执行要求

1. 若当前提交不同于研究基线，先检查差异是否导致既有认知失效，并把受影响范围转成新任务。
2. 抽样复核重要结论的证据，不复述文档内容。
3. 至少检查一个核心运行路径、一个失败场景和一个假设变更；每类抽样都必须形成带原始证据的 claim。
4. 检查功能索引、文档链接、状态和数据描述是否一致。
5. 按 `{{TEMPLATE_DIR}}` 检查每类文档的固定章节、元信息、结论状态和证据说明。
6. 清理所有“待研究/待补充/TODO/TBD”占位内容；不适用章节必须写明不适用依据和证据。
7. 确保说明书功能索引覆盖每个业务流程和非流程功能文档。
8. 检查模块特有名词、缩写和领域概念是否进入末尾术语表，且全文用词一致。
9. 抽样检查由 Git 提交线索形成的认知，确认其事实证据来自当前 HEAD 的模块源码，而不是 commit message、历史 diff 或旧版本文件。
10. 检查所有用户补充问题是否已直接回答，问题暴露的新知识是否已经进入对应稳定文档或明确证明无需修改。
11. 发现任何缺口时，在 `new_tasks` 中创建可取证任务；需要外部材料时写入 `unresolved_issues`。
12. 逐项填写 `acceptance_checks`。只有全部完成标准均有 claim 支撑、没有新任务和未解问题时，才使用 `outcome=completed`。

## 结果提交

把结果写入 `{{RESULT_PATH}}`。结构示例：

```json
{{RESULT_EXAMPLE}}
```

`acceptance_checks` 的 `criterion_index` 从 `0` 开始，`claim_refs` 引用本结果 `claims` 的数组下标。审查通常不修改稳定认知资产，因此 `updated_assets` 可以为空。完成后执行：

```text
{{DONE_COMMAND}}
```
