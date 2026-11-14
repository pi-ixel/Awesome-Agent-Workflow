# 019 dev 工作流小改动实测

> 状态：原运行因没有正式扫描器在 CodeCheck 停为 `unknown`；经用户授权接入模拟扫描并显式恢复后，同一次运行完成交付，Runtime 结果为 `passed`。这是模拟扫描条件下的流程验证，不代表正式 CodeCheck 已通过。

## 需求与结果

以 OpsCopilot 的隔离克隆（基线提交 `3f5f4e696721ed768a5ad67224cba28f00ce1c9a`）验证一项小需求：命令补全遇到负数光标时按 0 处理，保持其他光标行为，并补充测试。需求限定仅修改 `pkg/completion/service.go`、新增 `pkg/completion/service_cursor_test.go`，新增和删除总计不超过 100 行。原 `D:/dev/tmp/OpsCopilot` 工作区有未提交内容，未参与本次克隆中的实现。

实际实现改动 `service.go` 为 +4/-1 行，新增测试文件 92 行，总计 97 行。Runtime 宿主实际执行 `go test ./pkg/completion` 成功；独立检查及超时后恢复时另执行了 `go test ./pkg/completion -count=1`，均退出 0。业务文件在独立测试前后的 SHA-256 一致。

## 同一次运行走到哪里

| 环节 | 实际结果 |
|---|---|
| 需求确认 | 真实 ACP Agent 完成；测试需求中的细节由测试发起方授权自行决定。 |
| 设计与内部检查 | 真实 ACP Agent 使用 question-tracker MCP；7 条问题已答、0 条待处理。独立检查通过，并把具体设计版本传给测试设计。 |
| 测试设计 | 真实 ACP Agent 完成；输出的测试设计与设计版本已交给下游。 |
| 设计门禁 | 真实 Agent 读取设计与测试设计并返回 `pass`；此结论不是代码测试通过。 |
| 任务规划 | 真实 Agent 规划出一个任务，并回填测试矩阵阶段；事后独立对照确认只修改了阶段列。 |
| 实现与包测试 | 真实 Agent 在隔离克隆修改两文件；宿主实际执行包测试通过。 |
| 双路语义评审 | 两个真实 ACP 会话各返回 `pass`、无 finding。它们读取了实际文件，但本次宿主没有主动传入完整 Git diff；评审结论有此限制。 |
| 发现处置 | 两路均无发现，仍启动 Agent；该动作在 ACP 空闲 900 秒后超时，原运行停为 `unknown`。 |
| 显式恢复 | 核对两份评审、业务文件摘要、工作区、定义与问题池后，由宿主重新运行目标测试，并使用 Runtime 的显式 reconciliation 记录无发现处置。**这不是原超时 Agent 返回成功**。 |
| CodeCheck 原停点 | 恢复后运行到扫描节点；没有配置正式扫描器，停止为 `unknown`。 |
| 模拟扫描与交付 | 按用户要求接入模拟扫描，通过两条日志正则检查后显式恢复；任务交付与最终交付均执行完成，最终 Runtime 状态 `passed`。 |

首次执行从初始化证据文件创建至超时摘要落盘约 36 分钟，其中一次空闲超时 15 分钟；这是该次文件时间观察，不代表其他任务的稳定耗时。时间成本对这种小改动偏高，尤其无发现时无需启动额外 Agent。

## 依据

- [初次运行摘要](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/summary.json)：超时前的节点状态和实际输入输出。
- [原 Journal 备份](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/journal-before-reconciliation.sqlite)：reconciliation 前保存。
- [显式恢复证据](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/reconciliation.json)与[恢复后摘要](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/resume-summary.json)：记录证据、测试命令和 CodeCheck 停点。
- [模拟扫描及第二次恢复证据](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/mock-codecheck-reconciliation.json)、[模拟扫描输出](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/checks/tasks--0-codecheck-initial-review.stdout.txt)、[最终运行摘要](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/mock-resume-summary.json)和[恢复前 Journal 备份](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/journal-before-mock-codecheck.sqlite)。
- [独立包测试](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/manual-check/result.json)及[测试矩阵回填对照](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/manual-check/stage-fill.json)：二者是运行外的独立核验。
- 真实 Agent 的 ACP 输入、事件与输出位于 [agent 证据目录](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/agent/)；测试命令输出位于 [checks](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/checks/)。

## 本次优化及范围

1. 增加[隔离实测宿主](../../skillsplice/aaw-dev/dev_workflow_runtime.py)和[运行入口](../../skillsplice/aaw-dev/run_dev_workflow.py)，将真实 ACP、问题池、设计、测试设计、门禁、任务与后续动作接到整份 Runtime 定义。该宿主绑定本次测试的文件白名单、行数上限、测试命令和交互策略，不是 Desktop 正式通用宿主；工作区检查也不是操作系统沙箱。
2. 明确测试权限的最小允许范围；Agent 无法执行测试时可返回待验证，由宿主实际执行配置的命令后再判断，不把未运行声称为通过。本次运行启动前的旧权限策略曾拒绝 Agent 的测试请求，该记录没有改写。
3. 两位 Reviewer 都无发现时，宿主直接核验后返回空处置，不再额外启动 Agent；若实现版本和测试日志摘要均一致，可复用已有测试结果，否则重跑。本次超时后显式恢复时实际重跑了测试；测试复用优化发生在本次恢复之后，尚无一轮从头运行的真实回归。
4. 任务规划补充“只引用、不复制测试正文”的要求。新增测试矩阵检查，要求仅修改首次可验证阶段列；本次运行的原宿主未包含此检查，事后独立对照通过。
5. 后续实现结果会携带宿主生成的 Git diff、未跟踪新文件及摘要，供 Reviewer 读取；本次双路评审运行在该补丁之前，不能声称已经覆盖新接线。
6. CodeCheck 接口支持显式指定 Python CLI，并按既有 PoC 预期的 `codecheck-scanner/1.0` 输出检查结果；工具标识、报告或退出状态不一致时停止。有 finding 时暂不自动修复。该输出约定未与正式扫描器核对，工具标识也不是对程序来源的身份认证；真实扫描器与自动修复流程均未验证。
7. 增加显式启用的[模拟 CodeCheck](../../skillsplice/aaw-dev/mock_codecheck.py)。它使用两条按行匹配的正则，模拟检查敏感关键词进入日志和普通级别日志中的错误关键词，并输出规则、日志和 `simulated: true`。默认模式不自动回退到模拟器；本次由用户指定使用模拟模式。此次检查两份变更文件，未命中规则。
8. 后续宿主会把 Git 变更文件及增删行数提供给交付 Agent。该改动发生在本次交付动作启动后，已做受控测试，尚未经新一轮完整真实运行验证。

## 模拟扫描续跑与交付核对

原扫描节点没有结果；此次在核对同一运行、定义、工作区和业务文件摘要后，执行模拟扫描，并以 `user-authorized-mock-codecheck` 显式记录替代结果，再恢复同一 Runtime 运行。首次无 finding 处置超时后的人工核验与此次模拟扫描恢复是两次独立操作；因此，这不是一次无人介入、从头连续跑通的运行。

最终 Journal 中任务交付 `/tasks/@0/state`、整体交付 `/delivery` 和根节点均为 `passed`。Agent 生成的[最终交付报告](D:/dev/tmp/skillsplice-dev-small-20261104/workspace/.skillsplice/dev-60175a24ccb84df1-workflow/delivery/report.md)保留原样，但有以下需要按证据纠正之处：

- 报告将新增 96 行写成增删总数。实际为生产代码 +4/-1、新测试 +92，即新增 96 行、增删合计 **97 行**，仍在 100 行内。
- 报告称首次检查和修复循环均通过。Journal 只记录首次模拟检查节点通过，没有执行修复循环；首次扫描无 finding 时也不需要进入修复。
- 报告称未取得部分原始评审和测试产物，是交付 Agent 在隔离工作区内查找的结果；真实 ACP 事件与宿主检查输出保存在本仓库的证据目录。两位 Reviewer 本次未被主动提供完整 Git diff 的限制仍然成立。

两份业务文件在模拟扫描恢复时与最终交付后的摘要一致。模拟报告通过不代表代码符合其他未覆盖的扫描规则。

## CodeCheck 事实与剩余工作

当前仓库的 [CodeCheck 入口](../../../skills/code-check/scripts/codecheck.py)是固定通过的 `mock-codecheck`；本机搜索到的其他副本也相同，未发现正式扫描器。其结果不能报告为正式通过。额外独立运行了旧 PoC 的 [简易扫描器](../../poc/skillsplice/codecheck_homemade.py)，结果发现两项原有代码问题及新增测试的一处长行；它是行级启发式诊断，不是正式 CodeCheck 结果，也不是本次用户指定的日志正则模拟器。基线和当前结果分别见[基线](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/manual-check/experimental-scanner.baseline.json)、[当前扫描](../../poc/skillsplice/evidence/dev-workflow-small-20261104-run1/manual-check/experimental-scanner.stdout.json)。

后续需要接入可信的正式扫描器、实现并验证低风险修复与复扫、验证原 Reviewer 定向复核的身份/会话恢复；还需将实测宿主收敛到 Desktop 可用的通用宿主。当前已验证模拟扫描条件下的整链交付，尚无正式 CodeCheck 条件下完整通过的证据。
