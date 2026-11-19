# 016 dev-design 适配与验证

> 状态：适配验证进行中。已接通真实 ACP 和 question-tracker MCP；自然需求运行尚未通过，不代表完整 AAW 工作流已接入。

## 实现范围

- [可维护源目录](../../skillsplice/aaw-dev/dev-design-splice/SPLICE.md)编译成 [Runtime 定义](../../skillsplice/aaw-dev/dev-design-splice-compiled/dev-design-composite.json)。设计、检查、修正使用各自的指令和知识，不加载原 `dev-design` Skill 作为兜底。
- [设计宿主](../../skillsplice/aaw-dev/dev_design_runtime.py)将当前 Unit 的知识交给 ACP Agent，接收设计产物和结构化检查结果，只对明确可修正的问题进入有界修正。最终通过时才能提取设计引用。
- [问题池桥](../../skillsplice/aaw-dev/question_tracker_bridge.py)将真实 question-tracker stdio MCP 暴露为限本机、限会话、带认证的临时 HTTP MCP。它复用一个真实 MCP 进程并串行化调用，避免并发写入绕过 MCP 的进程内锁。Chrys ACP 当前接受 HTTP MCP overlay，但拒绝客户端提供的 stdio MCP。
- [运行入口](../../skillsplice/aaw-dev/run_dev_design.py)使用干净的 Git 工作区和工作区外的新证据目录。当前版本将定义复制并验证为本次运行快照，将需求内容或引用解析一次并固定为产物快照。目标产物通过本地产物库引用，不由 Runtime 固定存放位置。
- 有界循环耗尽时，当前入口在摘要中附上迭代次数、最后一次检查的问题和未通过候选的引用；该引用不等同于可交付的通过结果。
- [AAW 交接适配](../../skillsplice/aaw-dev/aaw_design_handoff.py)仅将检查通过的最终设计版本转换为下游 `SR` 和 `design_ref`；已有测试设计宿主的接收路径已用受控执行验证，尚未在新版组合上完成真实下游运行。

Git 工作区检查比较动作前后的 Git 可见状态，并阻止将越界更改报告为成功；它不是沙箱，不能覆盖忽略文件、工作区外路径或瞬时更改。ACP 中断后恢复原会话，以及检查结束后对 `needs_user` 的安全恢复入口仍未完成；状态不明时不自动重试。

独立入口依赖本机 iCode 和 [ACP 适配依赖](../../skillsplice/aaw-dev/requirements-acp.txt)。从仓库根目录启动的示例：

```powershell
python -m pip install -r desktop/skillsplice/aaw-dev/requirements-acp.txt
python -B desktop/skillsplice/aaw-dev/run_dev_design.py `
  --workspace <干净的隔离Git工作区> `
  --evidence <工作区外尚不存在的证据目录> `
  --requirement <需求文件> --handoff-sr SR-001
```

也可用 `--text` 或 `--url` 提供需求。终端问答需要交互式输入；没有有效回答时不当作完成。修改可维护源后，应先编译到新的定义目录，再通过 `--definitions` 指定它；默认入口使用已有的 `dev-design-splice-compiled`。`--handoff-sr` 只在设计通过后生成 AAW 下游输入，不会启动测试设计。

## 真实 ACP 与问题池

真实 iCode ACP 通信测试在一次 Agent 动作中创建问题池、发起用户提问、接收回答、记录回答并查询状态。回答“继续”是预设测试数据，不是实际用户决策；状态为 1 条已回答、0 条待处理。记录见 [ACP 事件](../../poc/skillsplice/evidence/dev-design-acp-question-20261104/evidence/question-smoke.events.jsonl)和 [问题池快照](../../poc/skillsplice/evidence/dev-design-acp-question-20261104/pool/)。

第一次真实设计运行停为 `unknown`：设计未按要求标记草案。运行还暴露了桥接层的并发缺陷——每个工具调用创建独立 MCP 进程，不能依靠 MCP 的进程内锁保证跨进程写入，导致问题编号重复和 6 条待处理问题。桥接已改为同一运行复用一个进程，并通过 16 路并发写入回归。iCode 原有 profile 中存在另一套问题池工具；测试中一次未加前缀的重置调用因找不到对应池未执行。后续入口将默认问题池数据目录也限制在运行证据目录，并在检测到非限定工具调用时停止。证据见 [首次运行摘要](../../poc/skillsplice/evidence/dev-design-splice-first-20261104/evidence/summary.json)、[问题池状态](../../poc/skillsplice/evidence/dev-design-splice-first-20261104/evidence/question-pool/)及 [设计调用记录](../../poc/skillsplice/evidence/dev-design-splice-first-20261104/evidence/agent/design.events.jsonl)。

## OpsCopilot 自然需求运行

以 `D:/dev/tmp/OpsCopilot` 的独立克隆（提交 `3f5f4e696721ed768a5ad67224cba28f00ce1c9a`）和[补全统计测试需求](../../poc/skillsplice/evidence/dev-design-splice-20261104/requirement.md)运行新版 `dev-design`。原工作区有未提交改动，这些改动没有进入克隆，也未被本次运行修改。测试明确允许 Agent 自行决定需求未规定的细节，并要求未获用户确认的设计标记为草案。测试交互器取消权限请求，因此未取得 Go 命令和 race 测试的执行证据。

设计 Agent 经 ACP 实际使用隔离的问题池；设计结束时池中 14 条记录、0 条待处理、编号无重复。随后独立检查触发两次修正和两次复查，最后一轮仍返回 `revise`，Runtime 按两次上限结束为 `failed`，没有生成可交接给下游的通过结果。[摘要](../../poc/skillsplice/evidence/dev-design-splice-20261104/evidence/summary.json)、[Journal](../../poc/skillsplice/evidence/dev-design-splice-20261104/evidence/journal.sqlite)、[最终检查记录](../../poc/skillsplice/evidence/dev-design-splice-20261104/evidence/agent/repair-loop_round-1_review.stdout.txt)和[各版设计工作副本](../../poc/skillsplice/evidence/dev-design-splice-20261104/working-artifacts/)已归档。

最后一轮检查中的 Go 示例缺陷可在候选设计中直接核对：`completion.NewDatabase()` 返回两个值，不能直接作为单值参数传给 `NewService`。用相同函数签名构造的[独立最小 Go 片段](../../poc/skillsplice/evidence/dev-design-splice-review-20261104/go-arity-repro.go)经 `go tool compile` 验证，编译器报告参数过多；这不是对 OpsCopilot 项目的完整测试。检查还把工作区保留的初稿与最终候选不同视为缺陷；Journal 显示 Runtime 实际传给该轮检查的是修正版本的不可变引用，不能据此认定下游会收到初稿。此次真实运行启动后，适配器增加了向检查 Agent 提供明确的本轮候选工作副本、检查后重新读取问题池、停止时的结构化反馈以及需求和定义快照等保护；这些新增代码由后续受控测试覆盖，不能追溯声称本次实跑已经覆盖。

针对上述候选版本另做了一次真实 ACP 只读复核：宿主提供明确的本轮候选副本，文件摘要与原运行最后候选的 revision 一致；检查结论仍为 `revise`，提出 4 项问题，包括无法编译的构造调用、包级统计测试隔离、行为不变的基线及问题池答案与最终设计不一致。此次结果未再提出“下游读取初稿”的问题，但一次复核不能证明同类误判已完全消除。[复核结论](../../poc/skillsplice/evidence/dev-design-splice-review-20261104/evidence/audit-result.json)中的 `status: passed` 表示**检查动作的输出契约有效**，业务决策 `decision: revise` 表示设计仍未通过；本次复核没有修改原 Runtime run 的失败状态，也没有自动增加修正轮次。

## 验证与后续工作

`test_dev_design_runtime.py` 14 项通过，覆盖设计、检查、修正、不可自动修正问题、问题池缺失或未收敛、越界文件检测、不可变输入/定义、16 路 MCP 并发写入，以及真实 MCP + ACP 替身的完整入口。`test_splice_workspace.py` 5 项通过，覆盖可维护目录与 JSON 的往返及修改传播；旧 `test_bridge.py` 19 项回归和 Desktop 类型检查也已运行通过。模型评审质量、真实用户决策、完整 dev 轻量链及最终实现验收均不由这些测试保证。

下一步应以不绕过修正次数上限为前提，先审阅失败原因和本轮候选；必要时由用户决定是否启动新的修正运行。确认设计交付后，再翻译并接入 `dev-test-design`，而不是继续依赖其旧 Skill 作为新版 Unit 的执行兜底。
