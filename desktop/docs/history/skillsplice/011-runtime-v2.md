# 011 SkillSplice Runtime v2 实现与验证

> 状态：运行时包已在仓库实现并完成受控验证；尚未发布，也尚未以新 v2 定义驱动真实 iCode 完成 AAW 全流程。原 AAW 流程的新版本仍需单独设计。

## 交付内容

执行内核位于 [desktop/skillsplice](../../skillsplice/README.md)，提供 Python 包 `skillsplice_runtime`。既有 `desktop/poc/skillsplice/runtime.py` 和 `definition.py` 保留为兼容导入，原 v1 bundle 和 PoC 驱动继续使用同一实现。

v2 定义增加运行期数据引用、逐 Call 输入绑定、基于上游结果或输入集合的多层展开、持久化确认节点和有界循环。循环支持 `until` 后置判断和 `while` 前置判断，可包含组合 Unit 和确认节点；每轮有独立调用路径。已启动的 run 使用持久化定义快照，模板修改不迁移运行实例。

Journal 保存节点、事件、调用输入和确认请求。同一 run 使用本机进程锁；确认后可重开 Journal，在同一 run 继续。外部原子动作中断后不自动重发；经操作者提供证据并显式处置后，才允许重新运行或对已完成结果重新验收。绑定工作区的 v2 运行在恢复前必须由宿主提供一致性检查回调。

定义格式、API 示例、状态语义和边界见 [运行时使用说明](../../skillsplice/README.md)；可执行样例位于 [examples](../../skillsplice/examples/run_demo.py)。

## 验证范围

- v2 测试 26 项通过，使用本地执行者和真实本地子进程，覆盖动态任务及嵌套展开、逐次输入、输入隔离、并行确认、循环与确认组合、循环上限、失败与暂停优先级、未知结果处置、真实进程中断和跨进程运行锁。
- 既有 v1 的 `test_poc`、`test_definition`、`test_flow`、`test_flow2`、`test_adapt`、`test_scanner` 分别为 18、21、18、19、29、11 项通过，检查 PoC 内核、定义、task-dev、AAW 受控场景与适配器兼容；这些受控测试不等同于真实 Agent 全链验证。
- 运行时包通过隔离目录构建 wheel、安装和样例执行的冒烟检查；没有发布制品或改变全局 Python 环境。
- 在临时工作区通过既有 iCode 适配器调用只读 Reviewer，收到 `OK`；v2 样例随后暂停等待确认，重新打开 Journal 并提交确认后，动态展开和有界循环执行至 `passed`。展开数据由样例执行器提供；该冒烟使用临时证据，测试结束后已清理，不等同于真实 task-dev 验收。

## 已知边界

- 现有 AAW PoC 翻译仍使用 v1 定义和 `StageDriver` 队列；本次没有把它重写成 v2 工作流，也没有消除 AAW 既有工作单和 CLI 耦合。
- 样例和受控测试不代表 v2 已驱动真实 iCode 完成 task-dev 或 AAW 自然需求。需要在决定新工作流后，以隔离工作区及独立证据验证真实集成。
- 引擎面向单机 SQLite 与本机文件锁，不承诺多机调度或网络文件系统；也不提供 Agent 沙箱、用户身份认证或资源授权。宿主必须验证恢复证据与工作区状态，并保护 Journal 中的输入和输出。
- 进程被强制终止时，`run` 可能仍记录为 `running`；这只表示最后记录的状态。恢复调用会检查未完成的原子动作，不能仅凭该状态认定进程仍在运行或操作已经完成。
