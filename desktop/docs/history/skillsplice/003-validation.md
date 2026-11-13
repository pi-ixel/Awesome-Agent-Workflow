# 003 SkillSplice 示例与验证

本文承接[执行语义](002-execution.md)，通过示例和 PoC 场景检验架构基线。

## 示例：task-dev

以下为概念示例，不是协议语法，也不代表当前 AAW 已按此实现。

```text
TaskDev Unit
  资源：设计与测试输入、编码知识、共享代码工作区

  实现与测试
      ↓
  实现提交
      ↓
  语义 Review：Reviewer A、Reviewer B（明确声明并行）
      ↓
  按结果进行必要修复和重验
      ↓
  CodeCheck
      ↓
  回填与完成提交

  Verification：必要步骤和本任务声明的完成条件均已满足
```

工作区由实例绑定；两个 Reviewer 的并行须在编排中明确声明。是否修复和定向复核由已定义的条件决定。Runtime 跟踪显式调用及验收；阅读具体文件等执行细节可以留在相应 Unit 内部。

## 验证与后续工作

以 `task-dev` 的最小流程进行 PoC，验证架构能否落地，而不是预先选定引擎：

| 场景 | 验证重点 |
|---|---|
| 递归组合 | 组合 Unit 引用子 Unit，各层调用、结果和验收关系可追踪。 |
| 受控执行 | 必要步骤不被跳过；依赖未满足不推进；显式并行及条件分支按定义执行。 |
| 验收 | 执行返回、验收通过和无法判断可区分；未通过时不会报告成功。 |
| 失败恢复 | 保留执行与尝试记录；重试有限；副作用不明时暂停。 |
| 定义与模板 | 知识、流程、契约或内部引用变化形成新身份；更新不传播到其他引用；新实例使用用户选择的定义。 |
| 工作资源与展开 | 同一 Unit 可绑定不同工作区；按预声明规则动态展开并记录实际实例。 |

完成 PoC 后，再制定正式定义格式、运行状态和接口、一致性测试，并评估 AAW-Desktop 的实现方案。运行实例迁移不属于 v0.1 的必过项。

## 参考方向

以下项目提供设计参考，不表示 SkillSplice 已采用其实现，也不表示其能力已通过本项目 PoC 验证。

| 参考项目 | 主要借鉴 |
|---|---|
| [Agent Skills 示例](https://github.com/anthropics/skills) | 将指导、知识和资源封装为能力单元。 |
| [ZCode](https://github.com/zai-org/ZCode) | 代码式流程分析、执行记录与恢复中结果复用的边界。 |
| [iCode / chrys](https://github.com/openJiuwen-ai/iCode) | 工作流调度、Agent 执行与多次尝试的分工。 |
| [Flowable](https://github.com/flowable/flowable-engine)、[Camunda](https://github.com/camunda/camunda) | 流程执行和活跃实例迁移约束；迁移不属于 v0.1 功能承诺。 |
| [Temporal](https://github.com/temporalio/temporal)、[Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | 执行历史、检查点和副作用边界。 |
| [Tekton Pipelines](https://github.com/tektoncd/pipeline) | 逻辑工作区声明与运行时资源绑定分离。 |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | 产物依赖与阻塞状态；产物存在不等同于 SkillSplice 验收通过。 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Agent 接入、任务与执行分离、外部操作和授权边界。 |
