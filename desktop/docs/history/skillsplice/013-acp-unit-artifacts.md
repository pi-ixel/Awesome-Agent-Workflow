# 013 ACP 执行、可编辑 Skill 副本与产物引用

> 本文保留早期实现和验证记录。人工维护目录、禁止原 Skill 兜底和已确认的 Unit 边界以 [015 可维护定义与 Unit 边界](015-authoring-and-unit-boundaries.md) 为准。

> 范围：dev 轻量链的需求进入至设计门禁。该入口是独立运行工具，尚未接入 Desktop 的 SkillSplice 窗口。

## ACP 原子动作

Runtime 的 Agent 执行者通过 [ACP 进程桥](../../skillsplice/aaw-dev/acp_runner.py)调用 Desktop 现有 `AcpSession`、Node stdio transport 和 Chrys 方言；问题与权限请求直接来自 ACP 会话，答案回给原会话，不在流程中额外创建问答节点。命令行入口使用终端接收回答；`AcpRunner` 的回调可供宿主接入其他交互界面。节点执行中断或 ACP 连接丢失时，外部动作结果按 `unknown` 处理，不自动重新发起。

桥记录 Agent 消息、工具活动、问题和答复。默认在 900 秒没有 ACP 活动时判定空闲超时；可通过 `--idle-timeout` 调整，等待用户回答不计入空闲时间。用户取消或没有有效回答时，不能仅凭 Agent 后续返回文本把该动作判为成功。超时或断开不代表外部动作未发生。

默认设计 Agent 为 `Code`，本机该 profile 配置了 `ask_user`；可用 `--agent` 显式选择。Agent 是否能提问由实际 Agent 配置和 ACP 方言决定。已建立会话的进程退出后，能否恢复正在等待的 ACP 请求尚未验证；当前桥拒绝把已中断动作伪装成新会话续跑。

当前 AAW 阶段执行仍复用 `desktop/poc/skillsplice/icode_adapter.py`，该模块还依赖 PoC 的部分辅助代码和测试模块；独立 Runtime 包与这套示例宿主的工程成熟度应分别评估。把阶段适配器抽离为独立可安装实现，是接入正式 Desktop 前的剩余工作。

真实 iCode 最小通信验证：Runtime 调用真实 ACP 会话，Agent 发起一组问题，测试程序以脚本化答案“继续”回答，Agent 随后返回“收到回答”。[最新事件记录](../../poc/skillsplice/evidence/acp-agent-qa-updated-20261103/evidence/smoke.events.jsonl)与 [Journal](../../poc/skillsplice/evidence/acp-agent-qa-updated-20261103/journal.sqlite)已保存；该次记录了工具活动并启用了空闲超时，但未实际触发超时。脚本答案是测试数据，不是用户决策。受控对端另验证了设计链多个节点提问、回答和继续，以及中断后不重发。

另一次 OpsCopilot 真实设计运行中，Agent 通过 ACP 发起四个问题：首项由用户明确决定，其余测试细节在用户授权后由执行者选择；设计节点随后完成。[ACP 问答记录](../../poc/skillsplice/evidence/acp-dev-interrupted-20261103/evidence/design.agent.events.jsonl)和[中断记录](../../poc/skillsplice/evidence/acp-dev-interrupted-20261103/run-metadata.json)已归档。该次运行后来在测试设计节点等待工具权限时进程退出；Journal 最后状态仍为 `running`，不能据此认为该节点完成。重新验证使用独立工作区和新 run，不将其视为旧节点的安全恢复。

## dev-design 阅读副本

本节记录最初的 **Skill 文件打包副本**。它并非直接从指定 Unit JSON 生成；若需要 JSON 与阅读格式的直接双向转换，请使用 [Unit 阅读副本](../../skillsplice/aaw-dev/dev-design%20Unit%20阅读副本.md)和[对照及操作说明](014-dev-design-three-way-comparison.md)。

[旧 dev-design 阅读副本](../../skillsplice/aaw-dev/dev-design%20阅读副本.md)包含可编辑的 Unit 定义、原 Skill 全文及其本地模板全文。导入和导出保持原文件字节内容；修改副本后编译生成新 Unit，可再导出副本核对内容。已启动的 run 继续使用自身定义快照。

```powershell
# 编译出独立 Unit；目标目录必须不存在。
python -B desktop/skillsplice/aaw-dev/skill_copy.py compile 'desktop/skillsplice/aaw-dev/dev-design 阅读副本.md' D:/dev/tmp/dev-design-new

# 根据阅读副本生成一份新的完整 dev 设计链模板。
python -B desktop/skillsplice/aaw-dev/skill_copy.py build-chain 'desktop/skillsplice/aaw-dev/dev-design 阅读副本.md' D:/dev/tmp/dev-chain-new

# 也可将编辑后的 Skill 文件还原到新的目录；不会自动覆盖原 Skill。
python -B desktop/skillsplice/aaw-dev/skill_copy.py restore-skill 'desktop/skillsplice/aaw-dev/dev-design 阅读副本.md' D:/dev/tmp/dev-design-skill-new
```

首次导入器目前只映射 `dev-design`，不是通用 Skill 转换器；不支持的二进制附件会明确拒绝。它保留原 Skill 中对外部 `aaw-workflow`、Agent 和工具的依赖，并未把外部系统自动封装进 Unit。组合链同时快照了 `module-test-design` 与 `dev-design-gate` 的源 Skill 及本地资源，并保留轻量模式指令；它们尚未有同等的独立阅读副本与往返编辑流程。复制全部文字不证明外部工具已接入或语义等价已通过全面验收。

## 输入与本地产物

根 Unit 接收结构化需求来源：文本、本地文件、HTTP(S) 地址或已有本地产物引用。程序宿主也可以先通过 `prepare_requirement` 解析可信函数的返回值，随后再创建运行；函数本身不嵌入声明式定义。HTTP(S) 获取会快照内容，并有读取大小和时间限制；认证型远程服务与非 HTTP 协议尚未接入。

需求和设计产物的引用包含本地存储标识、逻辑键和内容摘要，不包含工作区路径；门禁报告也提供 `report_ref`，同时保留旧适配器使用的本地 `report` 路径。本地存储保留每个键的历史内容版本；设计整改后产生新版本。当前 AAW Agent 适配器仍需要在隔离工作区 `.sdd/{SR}` 中创建工作副本，宿主检查工作副本与存储版本一致，最后将修改保存为新版本。这是当前适配方式，尚未实现远程文档服务或多进程并发写入协调。

```powershell
python -B desktop/skillsplice/aaw-dev/bridge.py --workspace <隔离干净的Git工作区> --text '需求正文' --sr SR-001 --evidence <工作区外的新目录>
# 输入也可选 --requirement <文件> 或 --url <HTTP地址>；--artifacts 可指定工作区外的本地存储目录。
```

## 门禁循环与反馈

模板的 `repeat.max_iterations` 控制评审次数。按当前默认值 3：首次评审后最多整改两次；通过时退出，达到上限时返回 `repeat_exhausted`、迭代次数和最后一轮结果，同时记录事件。

正式入口对自动整改使用更严格的策略：每个问题须明确标记 `auto_fixable=true`、`requires_user=false`，有具体整改方向和限定在设计文档范围内的 `fix_targets`，否则停为 `unknown` 并返回问题及报告引用；整改只授予声明的目标文件。模型给出的标记仍是判断，不构成语义正确或隔离保障。现有文件快照和 Git 检查不等于沙箱，也不能撤销已发生的越界修改。

## 验证边界

受控测试覆盖：完整 Skill 与模板往返、编辑后 Unit 身份变化、文本/本地/HTTP 输入、版本化产物、ACP 问答、问答中断不重发、整改策略和循环耗尽反馈。真实流程运行的证据和结果应单独记录；不要把脚本化 Agent 或本地 HTTP 测试当作真实模型或外部服务验证。

### 隔离工作区真实运行（2026-11-03）

在 OpsCopilot 基线 `3f5f4e696721ed768a5ad67224cba28f00ce1c9a` 的新隔离克隆中，以 R1 测试需求、用户确认的空前缀口径和用户对其余测试细节的自主决策授权重新运行。run `db36c9e4-5735-4a68-8cf6-409da9b3f80b` 经真实 iCode ACP 完成需求进入、设计、测试设计和第一轮门禁，门禁 `pass`，run `passed`。本次没有触发自动整改；真实门禁整改闭环仍以旧版运行证据为准，ACP 版本的整改与次数耗尽目前是受控验证。

[完整证据](../../poc/skillsplice/evidence/acp-dev-pass-20261103/)、[开发设计](../../poc/skillsplice/evidence/acp-dev-pass-20261103/working-copy/dev-design.md)、[测试设计](../../poc/skillsplice/evidence/acp-dev-pass-20261103/working-copy/test-design.md)、[门禁报告](../../poc/skillsplice/evidence/acp-dev-pass-20261103/evidence/gate-round-1.md)和 [Journal](../../poc/skillsplice/evidence/acp-dev-pass-20261103/evidence/journal.sqlite)已归档。独立检查确认需求、设计与测试设计工作副本的摘要均与本地产物版本一致；git 未显示源码变更，`.sdd` 本身受忽略规则影响，不能用 git 状态证明其完整变更范围。

本次 run 启动后，又补充了 ACP 空闲超时、未回答问题的成功判定、门禁报告 `report_ref` 和工作副本访问前的符号链接检查；本次真实 run 没有覆盖这些后续修改。超时、未回答和报告引用另经受控测试；符号链接检查尚未在真实 Agent 运行中验证。测试设计要求后续运行 `go test -race`，本机实测 `CGO_ENABLED=0` 且未找到 `gcc`；门禁报告关于命令可执行的表述不能作为本机 race 环境已就绪的证据。本次没有执行代码开发或 race 测试。
