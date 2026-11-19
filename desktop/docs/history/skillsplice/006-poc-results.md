# 006 SkillSplice PoC 验证结果

> 状态：**部分完成，整体未通过**。受控流程场景已验证；真实 task-dev 的正式 CodeCheck 不可用，实际流程尚未完成，候选引擎也未完成同一套案例对比。

## 1. 实验对象

- 独立原型：[desktop/poc/skillsplice](../../poc/skillsplice/README.md)，Python 标准库与 SQLite，非正式协议实现。
- 测试项目：`D:/dev/tmp/OpsCopilot`；以提交 `3f5f4e696721ed768a5ad67224cba28f00ce1c9a` 建立独立测试副本。原工作区已有未提交内容，未对其修改或清理。
- 受控测试证据：`D:/dev/tmp/skillsplice-poc-tests.log` 和 `D:/dev/tmp/skillsplice-poc-evidence/simulated/`；每个测试保留独立 SQLite 事件记录。

## 2. 受控执行场景

在原型目录运行 `python test_poc.py`，**18 项通过**：包括设计中的 POC-01 至 POC-13，以及并行失败阻止汇聚、缺少条件或展开输入时暂停、展开结果完整性、人工确认后重试 Review 处置、未知外部操作不能借 Review 入口重试五项边界测试。

可控场景验证了嵌套调用、明确并行和串行、条件处理、执行结果与验收分离、重试次数、定义快照和资源绑定。POC-08 和 POC-09 在子进程中使用进程退出注入中断，再打开数据库检查已确认结果复用和结果不明时暂停。

这些结果仅适用于原型和测试输入。尤其是 POC-13 的完成验收使用模拟证据字段；它不证明真实报告内容、真实 CodeCheck 或全部外部副作用已被验证。恢复验证也不保证任意工作区变化后的结果仍有效。

## 3. OpsCopilot 真实任务

### Runtime 与 iCode

`D:/dev/tmp/opscopilot-skillsplice-poc` 和 `D:/dev/tmp/opscopilot-skillsplice-run2` 是分别从基线建立的隔离副本。两次均先在负数光标用例中实际复现 `slice bounds out of range`，再由 iCode Agent 在隔离副本修改 `pkg/completion/service.go`；目标包测试通过。

原型分别启动了两个真实 iCode 只读 Review。第二次运行中两个 Review 均完成，Reviewer B 提出测试可维护性等 finding；Review Unit 已完成，后续处置节点先停为 `unknown`。随后人工处置并重新运行目标测试和独立差分，由原 Reviewer B 定向复核；Runtime 记录人工确认和证据后继续，同一次运行进入 CodeCheck 节点，并因扫描器是 mock 停为 `unknown`。事件、原报告、定向复核、处置和重验记录位于 `D:/dev/tmp/skillsplice-poc-evidence/real-run2/`。第一次运行及其独立复核证据位于同目录的 `real/`；两次运行不能合并成一次成功的端到端执行。

当前原型不自动处置 finding；本次继续执行依赖针对该案例编写的人工核验程序，检查定向复核、测试、基线差分和文件摘要后才授权重试处置节点。它不是对任意工作区变更均可安全复用历史结果的通用恢复机制。进入 CodeCheck 后检测到仓库配套脚本是 `mock-codecheck`，未当作真实扫描结果。

### 真实 AAW CLI 工作单

另在 `D:/dev/tmp/opscopilot-skillsplice-aaw` 使用 AAW `dev` 入口创建 `SR-998`。设计门禁首轮发现调用入口行号错误并拒绝推进；修正后第二轮通过。任务拆分后，按已批准的单个 T1 需求进入 task-dev。

该副本中完成负数输入的修复前 panic 复现、修复后的 `go test ./pkg/completion -count=1 -v` 和 `go vet ./pkg/completion`；另以固定基线比较正常光标 0、3、6 的完整建议集合及区间。`D:/dev/tmp/skillsplice-poc-evidence/aaw/comparison.json` 保存提交、文件摘要和命令；对应完整快照保存在同目录。

两个只读 Reviewer 的报告和 finding 处置位于 `.sdd/SR-998/.aaw/task-dev/6/1/`。Reviewer A 对测试内缺少完整基线比较提出 finding；外部差分证据经原 Reviewer 定向复核后，本次验收证据缺口关闭。该差分是独立脚本验证，不是目标包测试自动执行的持续回归。

**AAW CLI 当前状态仍为 `implemented`，阶段为 `completion`，工作流 `in_progress`。** 工作单执行记录标记 `Blocked`：CLI 配套的 `codecheck.py` 明确是临时 mock，原生输出也标识 `tool: mock-codecheck`。未提交 `completion.json`、未执行 `done`，未将 mock 输出当作正式 CodeCheck 通过。CLI 工作单与上述 Runtime/iCode 运行是两组独立实验，尚未接成同一条真实端到端流程。

## 4. 候选实现对照

本次在本地 chrys 代码提交 `8d5a32082f445f8c460cfc7d420a695a3305e63a` 上运行了其已有的三个聚焦测试：有限重试、分支汇聚、带屏障的两个 Agent 并行后汇聚，均通过。日志：`D:/dev/tmp/skillsplice-poc-evidence/chrys-checks.log`。

这三个测试是 chrys 自身的测试，并非将 POC-01 至 POC-13 原样适配后运行；它们不能证明 chrys 满足全部 SkillSplice 语义，也不能和本原型形成完整的成本、性能或质量对比。Flowable、ZCode 等候选引擎本轮未运行同一验收套件，尚不能据此选型。

## 5. 后续缺口

1. 获取正式 CodeCheck CLI，按 Skill 的原生输出执行并处理结果，再完成真实 AAW 工作单的 completion 和 done；不得用 mock 或 `go vet` 冒充。
2. 将本次案例专用的人工处置和重验扩展为可验证的通用机制，明确何时可复用此前结果；将 Runtime 与真实 AAW 工作单接为同一次运行并验证完整证据链。
3. 将同一组验收场景适配到候选引擎，对不支持的场景给出实测结果和适配成本。
4. 在进入正式协议前补齐原型之外的定义解析和一致性校验、知识依赖固定、状态及恢复边界。当前原型不具备生产可靠性或完整安全保障。
