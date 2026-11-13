# 009 SkillSplice 第二阶段结果报告（AAW 全链翻译 + 两自然需求实测）

> 后续状态：本报告保留当时的运行证据和结论。其后已修复门禁修复输出解析及部分停机结果传递缺陷，详见文末“后续修复”；修复后尚未重新进行真实模型全链运行。

> 状态：**部分通过**。受控层全部通过——P2-01..15 共 15 条受控场景与四套回归测试**在本报告撰写会话全部重跑**，全 PASS/OK；两个自然需求（R1/R2）**真实模型运行已发生**（真实 `icode.exe`，两链共 7 次 agent 调用、合计约 30 分钟模型时长）：R1（dev 链）阶段 1 五环节真实走通并正确停机在任务确认点 C1，C1 合法确认后阶段 2 失败于任务执行入口（终态 failed；退出码 2 由 `real_flow_run.py:258-262` 的 status→exit 映射推定，并经修订会话同构重放直接观测，§4.3）；R2（sr 链）两次尝试均停机——首跑 sr-init 架构 agent 超时（5936.89s），重跑（r2b）在 sr-design-gate 修正轮被**误判** "could not fix" 停为 unknown，本会话已把该误判定位到代码级根因（§5.2：提示词/解析器 marker 契约不一致）。**两链均未到达 task-dev 开发环节，两项需求零实现**（读代码核对）。
>
> 证据三分贯穿全文：**模拟**（假执行者/剧本驱动）／**受控**（真实入口+真实适配层+假 icode）／**真实**（真实 iCode+真实模型驱动隔离副本）——三类证据不混用、不互相冒充。**预埋与自然分开**：阶段 A 的 T1/T2 预埋缺陷与 P2 受控剧本属预埋/受控轮次；R1/R2 为自然需求，需求文自述「无预埋缺陷」（`requirement-input.md` 尾注，本会话通读）。
>
> **归档提醒（重要）**：R1/R2 全部运行证据与交付件目前在**临时目录** `D:/dev/tmp/` 下（含 `skillsplice-p2-evidence-r1/`、`-r2/`、`-r2b/` 三个证据目录与 `opscopilot-skillsplice-p2-r1/`、`-p2-r2/` 两个隔离工作区），随时可能被清理，须按 §8 清单归档后方可视为可复核。
>
> 版本注：本稿替换同日早前的三稿。早稿把 R1 阶段 2 的 exit 2 记为「确认答案文件格式错误」——终态证据不支持该定性（`confirm-1.json` 为合法 JSON、已被消费，`result-stage2.json` 的 `driver_records` 指向 task-dev T1 unknown），本稿按证据与代码重新定性为「任务执行入口失败，原因在证据内不可查」（§4.3）；早稿记录的 R2「sr-init 真实超时 5936.89s」经本会话从 `skillsplice-p2-evidence-r2/init.agent.meta.json` 直接复核属实，予以保留；早稿的 R2「重启被证据目录非空拒绝」无证据可复核，本稿只陈述两次尝试与两个证据目录的事实。凡标注「**本会话实测**」的检查均为本稿撰写会话亲自执行（命令与结果随条给出）；其余结论引用素材（任务书给定的 P2/核验证据），引用处注明；本会话未能执行的检查如实标注（§9）。
>
> 审读修订注：本稿其后经独立审读并按意见修订。审读会话独立重放复现了 §5.2 根因、独立重跑六套件核对 §3 计数、直读两链全部留存证据，判「证据链扎实、无越界宣称」；另指出 4 处口径/留档瑕疵与 3 个读者追问，本稿逐条处置（§10）：①§4 时间线按 mtime 拆分（md 06:54 / json 09:26）；②「exit 2」改为映射推定＋同构重放直接观测（历史进程退出码未入证据）；③六套件重跑补日志留档（撰写会话首跑未留日志，修订会话重跑并存档）；④行号区间收紧（:1686-1690、flow_core 695-702）；追问①以无 `--task-map` 同构重放把「代码路径吻合」升级为实证（§4.3）、追问②给出 FIX_RESULT 修复与重跑计划（§6.1）、追问③以 216 文件哈希 manifest 固化证据（§8）。

## 1. 背景与目标

第二阶段把 AAW 全工作流（sr 严谨链 + dev 轻量链，编排定义
[skills/aaw-workflow/scripts/cli/definitions/flow.yaml](../../../skills/aaw-workflow/scripts/cli/definitions/flow.yaml)）
翻译为 SkillSplice 落盘定义，并以**两个自然需求**实测：

- **R1**（简单需求，dev 轻量链）：命令补全使用统计导出——[phase2-r1-stats/requirement.md](../../poc/skillsplice/tasks/phase2-r1-stats/requirement.md)，三项功能点（统计记录 / `ExportUsageStatsJSON` 导出 / 并发安全）+ 测试，边界限 `pkg/completion`。
- **R2**（复杂需求，sr 严谨链）：SSH 会话命令历史搜索与补全联动——[phase2-r2-history/requirement.md](../../poc/skillsplice/tasks/phase2-r2-history/requirement.md)，含两级 foreach 与链上两处 must 确认点（澄清后、任务拆分后）。

翻译对象与需求文的完整性锚点（本会话实测）：

| 对象 | 校验 | 结果 |
|---|---|---|
| `flow.yaml` | `sha256sum` | `c3d3c94e3c2de1d5…d50ee23`，与对照表 §0 一致（本会话复核） |
| R1 需求三方 provenance | `sha256sum` 仓库 `requirement.md` ≡ 证据 staged `requirement-input.md` | `835285ae…3b96ef`，一致（本会话） |
| R2 需求三方 provenance | 同上 | `c3ecf989…24d323d`，一致（本会话） |
| 知识快照基线 | 快照头注 | `main@cf20762`（素材给定，快照头注自述） |

## 2. 翻译层与本仓库状态

### 2.1 落盘、幂等与仓库边界（本会话实测）

- 对照表：[translation-map-phase2.md](../../poc/skillsplice/translation-map-phase2.md)。其自声明「描述翻译意图与机制边界，不代表定义已落盘或已运行验证」——**本阶段首次给出落盘与运行证据**（§3 受控、§4/§5 真实）。
- 落盘定义：`definitions/aaw/` 五个 bundle（sr-chain / ar-clarify / ar-design / group-design / dev-chain）+ 知识快照，共 **46 个文件**（本会话 `find definitions/aaw -type f | wc -l`）；其中 20 份 knowledge md 恰有一对同内容重复（`sha256sum | sort | uniq -d` → `6bd2ce3a…`，dev-chain 与 group-design 下同名 `task-expansion-guidance.md`，bundle 按根拆目录须各自自含知识所致，本会话实测）。`definitions/task-dev/` 为阶段 A 既成事实复用，**16 个文件**（同法实测）。
- **对素材的一处口径更正**：素材 P2-10 证据写「definitions/task-dev 全树 46 文件」——46 是 `definitions/aaw/` 的文件数（生成器目标），task-dev 为 16。两个半句各自成立：task-dev 前后逐文件一致由 P2-10 场景断言（本会话随套件重跑 PASS），46 文件幂等见下条。另：素材 P2-07 引「flow.yaml:74-78 固定 vars」，本会话 `grep -n 'AR: "ALL"'` 唯一命中 **:77**（74-78 为 no_split 分支整体）。
- 幂等：`gen_aaw_defs.py` 本会话连跑 3 次，`definitions/task-dev`（16 文件）与 `definitions/aaw/`（46 文件）逐文件 sha256 **全部一致**（素材 P2-10「双跑幂等」结论本会话复核成立）。
- 仓库边界：`git diff --stat HEAD -- skills/ docs/` 输出为**空**（本会话实测）；`git status` 中 `desktop/poc/`、`desktop/docs/skillsplice/` 仍为 untracked（从未 `git add`，更无 commit）。即：**AAW 源技能与 docs 零改动，全部新文件位于 `desktop/poc/skillsplice/`（untracked）**。
- 内核零修改：`runtime.py` 与 `definition.py` 零修改，AAW 全部走新文件（`gen_aaw_defs.py`/`flow_core.py`/`real_flow_run.py`）+ `icode_adapter.py` 追加——素材 REGRESS 结论；因改动全 untracked、无 diff 基线，属二手断言，以四套回归全过（§3，本会话重跑）为旁证。

### 2.2 翻译边界（定义格式 v1 的已知限制，素材给定 8 条）

以下限制在受控全链模式下由 `flow_core.StageDriver`（装配驱动器）弥补，任务书明确允许并要求记录：

1. **三级 foreach 不可表达**：v1 `foreach` 只能展开运行输入中声明的列表（`runtime.py:193-199`），而 `ars/module_groups/tasks` 均为运行期产出数据；且 v1 无逐 Call 输入映射（FORMAT.md §5/§6），无法把列表项映射进被复用 task-dev 组合逐任务不同的必填字符串输入（`task_id` 等）。实现：`ars-expansion/ar-direct/task-expansion` 三个装配点原子 Unit + 驱动器工作队列。
2. **无运行中暂停/续跑原语**：must 确认点在装配执行者内停机（paused→unknown），被中断的组合运行保持 unknown（journal 如实留痕）；`--confirm` 续跑由 `real_flow_run` 按 `flow-state.json` 剩余队列驱动剩余阶段，不重放被中断的组合运行。与对照表 §2.1②「run 边界」哲学一致，但受控全链模式保留单根运行完整性。
3. **tasks_confirm 只接受 decision=confirm**：任务列表修订需回 task-split 重拆（AAW CLI 语义）；内核复用已通过节点使原地重拆不可行，修订路径如实拒绝并说明（`flow_core._process_item` tasks_confirm 分支）。
4. **任务级「序号 {index}」注入缺失**：内核只注入 `item/prior`（`runtime.py:206`）——以 `tasks-overview.md` 既有 T 编号 + 驱动器 `enumerate` 派生 T{seq} 对齐（对照表 §2.1③ 同款降级）。
5. **sr-init 的 repo-init 产物未纳入强制交付件**：`sr-init.yaml` output 仅列 `.sdd/software_architecture.md` required，按 `flow.yaml` 事实翻译，AGENTS.md/.sdd/spec.md 等留给执行者知识。
6. **真实任务阶段执行需 `--task-map`**：逐任务执行配置（task.json+五份任务文档，契约同 `real_run --task`）；缺映射的任务在任务阶段**如实 unknown 阻塞，不用猜测配置替代**（`icode_adapter.AAWFlowHarness.run_task`）——R1 阶段 2 即停在此供给缺口上（§4.3）。
7. **真实模型全链通跑未作为受控场景执行**：受控清单内 REALRUN 判「不支持」（素材给定，见 §3 末）；真实运行改以 R1/R2 自然需求单独进行（§4/§5），两条链均中途停机——「真实模型全链走通」至本稿仍无证据。
8. **knowledge 快照为原文摘录而非全文**（篇幅控制），摘录范围与行号逐份标注于快照头部注释；对照表 §0 的原文 sha256 与本会话实测一致（§1 表）。

## 3. 受控场景实测（P2-01..15 + 回归）

运行方式：`python -B desktop/poc/skillsplice/test_flow2.py`（P2 清单）与四套回归——撰写会话与审读会话各自独立重跑（审读会话计数与本节逐条吻合）；修订会话第三次重跑并**将六套件完整输出存档**于 `D:/dev/tmp/skillsplice-revision-20261103/logs/`（撰写会话首跑未留日志——审读瑕疵③，已在此补救；两份既有 flow2 日志与新增日志均含 `Ran 15 tests` 汇总行）。P2 全部由 `definitions/aaw` 落盘定义驱动；其中 P2-04..06/11 为「真实入口/真实适配层 + 假 icode（flow-behavior.json 剧本）」的**受控**证据，不构成真实模型行为证据——该声明的实证意义见 §5.2（受控层恰未能暴露真实模型才触发的 marker 缺陷）。

| 场景 | 内容 | 结论 | 本会话重跑输出（摘） |
|---|---|---|---|
| P2-01 | 门禁 fail→修正上游文档→重审通过 | 通过 | `P2-01 PASS …两轮信封逐轮留证，链推进到任务` |
| P2-02 | 门禁连续 fail→≤2 轮停（有界），下游不执行 | 通过 | `P2-02 PASS …修正轮 ≤2 耗尽即停（有界），下游一个都不执行` |
| P2-03 | 门禁 blocked→停机不 rollback | 通过 | `P2-03 PASS …停机（unknown）等宿主决策；上游文档与已过节点不被回滚` |
| P2-04 | 真实入口 sr 链 stage1 在 ar-clarify 定稿确认点 exit 3 + pending-confirm.json | 通过 | `P2-04 PASS …正常退出 3，pending-confirm.json 落「待确认问题+上下文」` |
| P2-05 | 无确认不推进（字节级不变；越级/错链 exit 2） | 通过 | `P2-05 PASS …不带 --confirm → exit 3，队列原样，重申待确认问题` |
| P2-06 | 带确认推进（含 revise 回炉，C1→C2→C3→exit 0） | 通过 | `P2-06 PASS …revise 先回炉重澄清…→ 任务串行执行（run_task 替身）→ exit 0` |
| P2-07 | 两级 foreach 展开正确（模块组×任务） | 通过 | `P2-07 PASS no_split 单 AR × 两模块组 × 每组两任务…任务串行`（vars 行号口径见 §2.1） |
| P2-08 | sr 链拆分两分支（内核 when 求值留痕） | 通过 | `P2-08 PASS …分支选择由内核 when 条件求值（condition/skipped 事件留痕）` |
| P2-09 | dev 链全通 | 通过 | `P2-09 PASS init→design→test-design→gate→task-split→确认→两任务串行…` |
| P2-10 | task-dev 复用不改源码 | 通过 | `P2-10 PASS definitions/task-dev 前后逐文件哈希一致，任务运行来自同一 bundle 根 Unit`（文件数口径修正见 §2.1） |
| P2-11 | 真实适配层门禁循环（假模型层） | 通过 | `P2-11 PASS fail→修正（目标真实变更）→重审 pass；两轮报告落盘、逐轮留证` |
| P2-12 | 模块组名 item_validation 拒绝 | 通过 | `P2-12 PASS …不以 模块(组) 结尾 → module-detail-split 验收拒绝，无组展开` |
| P2-13 | 任务标题 T1- 前缀拒绝 | 通过 | `P2-13 PASS …（flow.yaml reject_pattern）→ task-split 验收拒绝` |
| P2-14 | 任务串行失败即停 | 通过 | `P2-14 PASS …T1 失败 → T2 不执行，后续模块组也不推进` |
| P2-15 | 门禁坏信封（缺 report）拒绝 | 通过 | `P2-15 PASS …违反 flow.yaml「report 不得为 null/空」→ 验收拒绝` |

回归（本会话重跑，命令与汇总行）：

| 套件 | 命令 | 结果 |
|---|---|---|
| test_poc | `python -B test_poc.py` | `Ran 18 tests … OK` |
| test_definition | `python -B test_definition.py` | `Ran 21 tests … OK` |
| test_flow | `python -B test_flow.py` | `Ran 18 tests … OK` |
| test_adapt | `python -B test_adapt.py` | `Ran 29 tests … OK` |
| test_scanner（非任务要求四套之一，一并跑过） | `python -B test_scanner.py` | `合计：11 通过，0 失败（共 11 条）` |

六套件修订会话重跑全部 exit 0，逐套日志：`logs/test_poc.log`（Ran 18）、`test_definition.log`（Ran 21）、`test_flow.log`（Ran 18）、`test_adapt.log`（Ran 29）、`test_scanner.log`（11/0）、`test_flow2.log`（Ran 15、15 行 PASS、无 FAIL），路径见 §8 修订目录。

REALRUN（受控清单内场景「真实模型运行 real_flow_run（非受控）」）：**不支持**——未作为受控场景运行（消耗真实模型调用且需 `D:/dev/tmp` 下隔离副本与真实 iCode/go 环境）；真实路径当时仅以假 icode 受控验证（P2-04..06/11）。**其后的真实运行改以 R1/R2 进行**，结果见 §4/§5：真实运行已发生但两链均中途停机，「全链真实走通」仍无证据。

## 4. R1 自然需求真实运行（dev 链）：确认 8 / 缺口 6

时间线（文件 mtime，本会话 `ls -la`）：03:54 起 stage 1（4 次 agent 调用至 04:04，journal 落盘）→ 06:54 撰写确认答案 `confirm-1.md` → **09:26 stage 2 运行**（`confirm-1.json` 于此刻落盘，与 `flow-state.json`/`result-stage2.json` 同刻——审读瑕疵①：md 与 json 的 mtime 分别为 06:54/09:26，此前一句合并表述有误）→ 终态 failed（退出码 2 的依据见 §4.3）。隔离工作区 `D:\dev\tmp\opscopilot-skillsplice-p2-r1`（OpsCopilot @ `3f5f4e6`，`baseline-head.stdout.txt` 本会话读）。**真实运行判定依据**：全部 agent 调用 argv 为真实 CLI `D:\Program Files\Chrys\icode.exe run -a <agent> --json -C <worktree>`（`*.agent.cmd.json` 本会话读），时长为真实模型量级——design 195.063s / testdesign 182.765s / gate.r1 133.469s / tasksplit 93.594s，全部 `class=ok exit=0`（meta 本会话读）。

### 4.1 确认项（8，均本会话逐条复核）

1. **需求 staged 三方一致**：仓库 `requirement.md` ≡ 证据 `requirement-input.md`，sha256 `835285ae…`（§1 表）。
2. **stage 1 五环节真实执行**：journal 节点 `/init /design /testdesign /gate /tasksplit` 全 `passed`；其中四环节由真实 agent 驱动（时长见上），dev-init 为纯文件环节（本会话 sqlite 直查节点表）。
3. **四份交付件落盘**：`.sdd/SR-001/` 下 `dev-design.md`、`test-design.md`、`tasks-overview.md`、`.context/dev-design-gate.md`（本会话 `find`）。
4. **轻量门禁一轮 pass**：`GATE_RESULT {"gate_result": "pass", … "summary": {"unqualified_items": 0, "blocking_issues": 0, "pending_questions": 0}, "issues": []}`；报告正文结论「通过（pass），可进入 dev-task-split」（本会话自 `gate.r1.agent.stdout.txt` 与报告文件提取）。
5. **任务计划与需求一一对应**：单任务 T1「命令补全使用统计导出」，改动面 `pkg/completion` 三文件（service.go 修改 + usage.go/usage_test.go 新增），承接 TC1–TC13，TC12（-race 需 cgo）按门禁要求登记 Pending 不降级（`tasks-overview.md` 本会话读）。
6. **正确停机在任务确认点 C1**：`result-stage1.json` `status=unknown`，detail 为 `awaiting user confirm: {confirm_id: C1, kind: dev-task-split-confirm, tasks: ['命令补全使用统计导出']}`；journal `/taskloop` unknown、event 28 `run_settled` unknown（本会话 sqlite 直查）。
7. **C1 以合法答案确认并被消费**：`confirm-1.json` 为合法 JSON（`confirm_id: C1, decision: confirm`）；`flow-state.json` `confirm_seq: 1`；`pending-confirm.json` 按 `real_flow_run.py:245`（消费答案且非 paused 即删除）移除——本会话核对当前目录确无此文件（`confirm-1.md` 引用其行号属实）。
8. **需求三项零实现 + 基线无回归**：`pkg/completion/service.go:9-11` `Service` 仅 `db *Database` 字段；`GetCompletions`（service.go:19-40）无任何记录逻辑；目录仅 `database.go/service.go/service_combo_test.go/types.go/data/`，**无 usage.go/usage_test.go**，`grep -riE 'usage|export|stat' pkg/completion/*.go` 零命中；worktree `git status --porcelain` 为空；`go test -count=1 ./pkg/completion/` `ok 1.113s`（本会话在隔离副本执行）——通过仅代表基线回归，不构成实现证据。

### 4.2 缺口（6，素材给定，本会话逐条复核/补证）

1. **task-dev 全链（实现/测试/双 Review/处置/复核/CodeCheck/交付）完全缺失**：`result-stage2.json` `status=failed`、`driver_records=[{unit: task-dev, run_id: T1, status: unknown, note: 命令补全使用统计导出}]`；`flow-state.json` 队列仍剩 1 个 `dev_task`；`run-meta.json` `last_status=failed`（本会话读三个文件）。
2. **task-dev 的 journal 节点缺失**：journal 仅 7 节点/28 事件止于 stage-1（节点序 `/init /design /testdesign /gate /tasksplit /taskloop /`）；按 task-dev/review/codecheck/deliver 关键词检索零命中；`journal.sqlite` mtime=04:04，stage-2（09:26）未写入任何节点（本会话 sqlite + mtime 复核）。
3. **task-dev 产物缺失**：证据目录无任何 taskdev/task-dev 文件；`.sdd/SR-001/` 无 `tasks/` 目录；`tasks-overview.md` 的 T1 执行记录段（状态/修改文件/核心实现/设计偏差/待处理/后续须知/证据）**全部空白**（本会话 `sed -n 55,80p`）。
4. **需求三项均未实现**（读代码核对）：同 §4.1 第 8 条——统计记录/导出接口/并发安全三项无一有实现。
5. **自然 finding 无从验证**：双 Review/处置/复核/CodeCheck 从未运行（无产物、无 journal 节点）；唯一真实审查发现来自 stage-1 设计门禁的 4 条**非阻断观察 O1–O4**（race 需 CI、`completeOptions` 不可达回落分支、覆盖矩阵映射精度、TC12 不得降级——`.context/dev-design-gate.md` §2，本会话读），非任务级代码 Review。
6. **stage-2 失败原因在证据内不可查**：`result-stage2.json` `detail` 为空；证据目录无 stage-2 的 stderr/日志（受控测试产物 `skillsplice-p2-flow2-rerun-20261103.log` 指向 temp 目录，与 r1 无关）。**代码侧解释（本会话读码，非证据）**：(a) `real_flow_run.py:236-239` 只在 `status=="paused"` 时填 `detail`，failed 恒空——阻塞原因不透传是可观察性缺口；(b) 与 `driver_records` 逐字段恒等的唯一代码路径是 `flow_core.py:695-702`（`if kind == "dev_task":` 起的分支，失败路径 698-701：`run_task` 非 passed → `_record("task-dev", T1, unknown, title)` → failed），而 `run_task` 的 unknown 分支即 `icode_adapter.py:1762-1768`（task_map 查找在 `:1764`）「缺 `--task-map` 映射 → Outcome unknown」——该 Outcome detail 同样未进 result JSON。历史调用是否真的未带 `--task-map` 仍无 argv 留档可证，但「不带 `--task-map` ⇒ 必现该精确失败形态」已由修订会话同构重放**正向实证**（§4.3）。

### 4.3 阶段 2 退出记录（`result-stage2.json` 原文，本会话读）

```json
{
 "chain": "dev", "sr": "SR-001", "stage_arg": 2, "status": "failed", "detail": "",
 "pending_confirm": false,
 "driver_records": [
  {"unit": "task-dev", "run_id": "T1", "status": "unknown", "note": "命令补全使用统计导出"}
 ]
}
```

定性：**任务执行入口失败（终态 failed）**。上游五环节与确认点 C1 均真实成立（§4.1）；失败发生在任务级装配执行（§2.2-6 的 `--task-map` 供给缺口）。退出码 2 的依据链（审读瑕疵②的处置）：历史运行的进程退出码**未入证据**——由 `real_flow_run.py:258-262` 的 status→exit 映射（failed⇒2）**推定**，并由下述同构重放**直接观测**。

**同构重放（修订会话执行，回应审读追问①）**：在证据副本上重建 09:26 运行前一刻的前置态——`pending-confirm.json` 按 `RealConfirmHandler.ask` 的写盘格式重建，C1 问题原文逐字取自 `result-stage1.json` detail（非臆造）；`run-meta.json` stage 回 1（`:185-188` 的 expected_stage 校验要求）；`flow-state.json` `confirm_seq` 回 0。随后以真实 worktree（只读）运行，**不带 `--task-map`**：

    python -B real_flow_run.py --workspace D:/dev/tmp/opscopilot-skillsplice-p2-r1 --evidence D:/dev/tmp/skillsplice-revision-20261103/replay/evidence-r1-copy --chain dev --sr SR-001 --stage 2 --confirm <副本>/confirm-1.json

观测（本会话，副本与输出存档于 §8 修订目录）：**退出码 2（shell 直接捕获）**；stdout JSON 与历史 `result-stage2.json` **逐字段一致**（程序化比对＝True：failed、detail 空、`driver_records=[task-dev/T1/unknown/命令补全使用统计导出]`）；副本 journal 零新增（仍 7 节点/28 事件）；副本文件集与源目录完全一致、无任何新 agent 产物——**icode 全程未被调用**，失败点（`icode_adapter.py:1764` 的 task_map 查找）先于一切模型调用。重建局限（如实声明）：历史队列中的 C1 确认项已被 09:26 运行出队、无法从留档复原，重放队列仅含 dev_task（从任务项直接起步），且重放后副本 `flow-state.json` 的 pending 残留 C1（历史为 null/confirm_seq=1）——系重建态与真实确认消费路径之差，不影响被测机制（缺映射分支在确认消费之后才可达）。**结论升级**：「代码路径吻合」→「同构重放实证」。仍未实证的是历史调用确未带映射（无 argv 留档，不可证性保留）；带映射的对照侧需先按 `real_run --task` 契约制作 T1 任务目录（task.json＋五份文档，源料可用 `.sdd` 交付件），本会话不执行——不以臆造的执行配置替代真实供给（§2.2-6 同款原则）。

## 5. R2 自然需求真实运行（sr 链）：确认 7 / 缺口 10

两次尝试：**r2**（06:54–08:33，证据 `skillsplice-p2-evidence-r2/`）与 **r2b**（09:26–09:46，证据 `skillsplice-p2-evidence-r2b/`），共用隔离工作区 `D:\dev\tmp\opscopilot-skillsplice-p2-r2`（同基线 `3f5f4e6`）。r2b 真实 agent 调用：design 504.391s / gate.r1 298.391s / gate.fix1 390.968s，全部 `class=ok exit=0`（meta 本会话读）。

### 5.1 确认项（7，均本会话逐条复核）

1. **需求 staged 三方一致**：sha256 `c3ecf989…`（§1 表）。
2. **r2 首跑超时如实留痕**：`init.agent.meta.json` `class=timeout`、`duration_s=5936.89`；`result-stage1.json` `blocked (timeout): sr-init architecture agent did not complete`、unknown（本会话读 r2 证据）。
3. **r2b sr-init 以既有基线完成**：journal `/init passed` 且无 init agent 调用；`.sdd/software_architecture.md` 已存在（r2 超时前落盘），走 repo-init「已有基线未修改仅提示不等待」分支（对照表 §2.2 同条）。
4. **sr-design 真实执行**：504.391s，`SR-design.md` 落盘（`.sdd/SR-001/` 本会话列目录）。
5. **门禁第 1 轮真实评审 fail**：`GATE_RESULT {"gate_result": "fail", … "p1_conflicts": 2, "p2_findings": 7}`，报告落盘 `SR-design-gate.md`「结论: fail」（本会话提取）——2 条 P1 为真实模型审查发现（历史捕获与 LineBuffer 现状矛盾、补全合并的历史候选匹配条件未定义）。
6. **修正轮真实修复且边界合规**：`gate.fix1.agent` 390.968s，末行 `FIX_RESULT {"fixed": true, "summary": "仅修改 .sdd/SR-001/SR-design.md：…"}`（本会话提取，JSON 可解析）；仅改目标文档、`_boundary_check` 通过（worktree `git status --porcelain` 为空——`.sdd` 外零改动）。
7. **停机语义正确**：终态 unknown、不 rollback——journal `/init /design` 保持 passed、`/gate` unknown（4 节点/16 事件）；`flow-state.json` `confirm_seq: 0、pending: null`；worktree 代码零改动（见确认 6 与缺口 9）。

### 5.2 r2b 停机根因（本会话代码级定位，更正素材「疑似确认点」定性）

r2b `result-stage1.json` 原文（本会话读）：

```json
{
 "chain": "sr", "sr": "SR-001", "stage_arg": 1, "status": "unknown",
 "detail": "blocked (permission): gate fix round 1 could not fix within the boundary ()；停机等宿主决策，不 rollback",
 "pending_confirm": false, "driver_records": []
}
```

素材判读「疑似确认点但 pending 不可读（可能为失败退出误判）」——**本会话定性：不是确认点，是 marker 解析失败导致的误判停机**，证据链：

- 修正轮提示词（`icode_adapter.py:1673`）要求 agent 末行输出 `FIX_RESULT {...}`（**无冒号**）；解析器（`icode_adapter.py:1681` → `_marker_payload`，`icode_adapter.py:360-371`）用正则 `^FIX_RESULT:\s*(\{.*\})\s*$`（**有冒号**）。真实模型按提示词输出无冒号 → 解析 0 匹配 → payload=None → `or {}` → `fixed` 为假 → 判「could not fix within the boundary (summary为空)」——detail 里空括号 `()` 即空 summary 的直接痕迹。
- 本会话以解析器同款正则重放 fix1 输出：带冒号 **0 匹配**、去冒号 **1 匹配且 `fixed=true`、summary 非空**——即修正实际成功、边界实际合规，停机是误判。
- 对照：门禁轮 `GATE_MARKER = "GATE_RESULT"`（无冒号，`icode_adapter.py:1201`）与提示词一致，故第 1 轮评审解析成功。
- **受控层为何未暴露**：假 icode（`test_flow2.py:313-321`）按解析器格式 `emit("FIX_RESULT:", …)` 输出——受控剧本恰好掩盖了「真实模型按提示词行事」才触发的缺陷。这是「假模型输出不构成真实模型行为证据」声明的实证案例。
- 复审（第 2 轮评审）因此**从未执行**——无 gate.r2 调用与产物，需求门禁无 pass 记录。
- 佐证：独立审读会话对本根因做了**独立重放复现**（带冒号正则 0 匹配、去冒号 1 匹配且 fixed=true、summary 356 字符，与本节一致；`test_flow2.py:321` 假 icode 确按带冒号输出）——素材：审读报告 §一「核对通过」。

### 5.3 缺口（10，素材给定，本会话逐条复核）

1. **需求门禁（pass）不成立**：第 1 轮 fail（2 P1），修复轮后复检未执行（§5.2），无任何 pass 记录；链路在此停机（driver 判 permission blocked，修复授权边界实为空——系 summary 丢失的显示痕迹）。
2. **AR 拆分或 no_split：未到达**（`.sdd/SR-001/` 仅 `SR-design.md`、`SR-design-gate.md`、`original-requirement.md` 三文件，无 ar-split 产物；证据目录亦无对应 agent 记录——本会话列目录）。
3. **澄清环节与用户确认点 1：未到达**（无 pending-confirm 与 confirm-*.md 成对文件；`flow-state.json` `confirm_seq=0、pending=null` 佐证）。
4. **模块边界（module-boundary-design）：未到达**。
5. **模块分组（foreach，组数与执行数一致）：未到达**。
6. **每组 asis+tobe+test-design+模块门禁：未到达**。
7. **任务拆分与用户确认点 2：未到达**（无第二组 pending-confirm/confirm-*.md）。
8. **任务串行 task-dev：未到达**。（4–8 均由 journal 仅 4 节点止于 `/gate` 佐证，本会话 sqlite 直查。）
9. **需求覆盖核验无实现可核**：`pkg/history` 目录不存在（本会话 `ls pkg/` 无该项）；`pkg/completion` 全目录 grep `history` 零匹配；`app.go` 无 `SearchCommandHistory`；新增测试文件不存在——「相关包 go test」按新功能包测试口径无法执行，仅既有包基线通过（`go test -count=1 ./pkg/completion/ ./pkg/terminal/ ./pkg/recorder/` 全 ok，本会话在 r1 隔离副本执行；两 worktree 同基线 `3f5f4e6` 且均 clean）。
10. **自然 finding 与处置链（R1 口径）：无产物可核**——未到达实现环节，`.sdd` 与证据目录均无 finding/处置类文件（需求自述自然需求、无预埋缺陷）。

## 6. 四类新机制：实测结论与暴露的缺口

### 6.1 门禁三态（pass/fail/blocked，≤2 修正轮，不 rollback）

- **受控**：P2-01/02/03/15（内核三态、有界修正、停机不回滚、坏信封拒绝）+ P2-11（真实适配层循环）全 PASS（本会话重跑）。
- **真实**：R1 一轮 pass（计数全 0、O1–O4 非阻断观察如实落盘）；R2 一轮 fail（2 P1 真实发现）→ 修正轮真实修复（仅改目标文档）→ 复审未执行（§5.2）。两次停机方向均 fail-safe：无伪成功、无 rollback、journal 如实。
- **缺口**：① marker 契约不一致（提示词无冒号 vs 解析器有冒号，`icode_adapter.py:1673`（提示词） vs `:1681`（解析器），误判分支 `:1686-1690`，到 `:1690` 才闭合——审读瑕疵④已收紧）——对真实模型为必现级缺陷。**修复与重跑计划（回应审读追问②）**：最小修复二选一（提示词 `:1673` 补冒号，或解析器 `:1681` 去冒号——建议向提示词字面格式对齐），并顺手核对全部 marker（STAGE/GATE/AR_SPLIT/MODULE_GROUPS/TASKS/ARCH/FIX）的提示词↔解析器逐字一致；受控层补负例「假 icode 按提示词字面格式（无冒号）输出 → 解析失败 → 如实停机」；修复后 R2 需**新建证据目录**重跑 stage 1（消耗真实模型调用），R1 阶段 2 需先制作 T1 任务目录再带 `--task-map` 重跑。**本修订会话未执行代码修复与真实重跑**：报告修订授权不含行为基线变更（修复会改变本报告引用的代码行与行为，须与重跑一并作为下一迭代），处置明细见 §10；② 受控剧本按解析器格式输出，掩盖该缺陷——受控证据不能外推为真实模型行为；③ 失败/阻塞的 detail 不透传（`real_flow_run.py:236-239` 仅 paused 填 detail），停点在证据内不可查。

### 6.2 宿主确认屏障（user_confirm must → paused→unknown，--confirm 续跑）

- **受控**：P2-04/05/06 全 PASS（exit 3、字节级不变、revise 回炉、C1→C2→C3 推进到 exit 0）。
- **真实**：R1 全程成立——stage 1 正确停在 C1（dev-task-split-confirm），宿主以合法 `confirm-1.json` 确认后 `--confirm` 续跑（`confirm_seq=1`、pending-confirm.json 按 `real_flow_run.py:245` 消费）。
- **缺口**：① 失败停机（R2 r2b）与确认停机（R1 C1）在 result JSON 上均表现为 `status=unknown` + `pending_confirm=false`，仅 detail 文本可辨——宿主易误判（素材「疑似确认点…可能为失败退出误判」即因此，本会话已定性为后者）；② `tasks_confirm` 只接受 `decision=confirm`，修订需回 task-split 重拆（§2.2-3）；③ 被消费后的 pending-confirm.json 不留档，事后复核只能靠 flow-state/journal。

### 6.3 两级（实为三级）foreach：ars × module_groups × tasks

- **受控**：P2-07/08 全 PASS——no_split 单 AR=ALL × 2 模块组 × 每组 2 任务，执行序与任务矩阵断言成立；split 双 AR 分支由内核 when 求值留痕（condition/skipped 事件），2 AR×2 组×2 任务=8 项全序展开（本会话重跑）。
- **真实**：**未到达**（R2 停在 sr-design-gate，§5.3-2..8）——foreach 的真实模型路径无自然证据。
- **缺口**：定义格式 v1 不可表达（§2.2-1），由驱动器装配实现；「序号 {index}」注入缺失以交付件编号对齐（§2.2-4）；两处降级均已记录于对照表 §2.1③。

### 6.4 环节翻译（20 节点 yaml + 环节 skills → definitions/aaw）

- **落盘**：`definitions/aaw` 46 文件，`gen_aaw_defs.py` 幂等（本会话 3 跑逐文件哈希一致）；对照表 §0 flow.yaml sha256 复核一致。
- **受控**：P2-09 dev 链全通、P2-10 复用不改源码、P2-12/13 翻译期校验（组名/任务标题）生效（本会话重跑）。
- **真实**：R1 stage 1 五环节按翻译定义真实走通（含门禁与拆分交付件）；R2 走通 init（基线复用分支）/design/gate r1+fix1。
- **缺口**：① sr-init repo-init 产物未纳入强制交付件（§2.2-5）；② knowledge 快照为摘录非全文（§2.2-8）；③ 环节 agent 输出的结构化契约（marker）与解析器的一致性无系统性核对——本次由 R2 暴露（§5.2），建议对所有 marker（STAGE/GATE/AR_SPLIT/MODULE_GROUPS/TASKS/ARCH/FIX）做提示词↔解析器逐字核对，并在受控层补「按提示词字面格式输出」的负例。

## 7. 总体判定

**部分通过**。分层判定与停点：

| 层 | 判定 | 依据 |
|---|---|---|
| 受控（定义驱动+假 icode） | **通过** | P2-01..15 全 PASS + 四套回归 OK + scanner 11/11（本会话全部重跑） |
| R1 真实（dev 链） | **停点：阶段 2 任务执行入口**（终态 failed、task-dev T1 unknown；退出码 2 经同构重放实证） | §4；上游五环节 + C1 确认点真实成立 |
| R2 真实（sr 链） | **停点：阶段 1 sr-design-gate 修正轮**（误判 blocked(permission)，unknown 停机） | §5；到达的 init/design/gate r1+fix1 真实成立 |
| 需求实现 | **零实现**（两需求均未到达 task-dev；读代码核对） | §4.1-8、§5.3-9 |

**能否支撑 AAW 级流程——分两层回答**：

- **流程控制层：能**。编排推进、门禁三态有限循环、宿主确认屏障、失败即停、不 rollback、逐轮留证、task-dev 复用不改源码——受控 15/15 全部成立；更重要的是两次真实失败停机均落在 fail-safe 方向：R1 停在正确的确认点并按合法确认推进；R2 的误判停机也没有产生伪成功、没有回滚上游、journal 如实记录。控制层行为在真实模型面前保持了一致性。
- **环节质量层：尚不能宣称**。真实运行暴露三个供给/契约缺口：① marker 提示词↔解析器不一致（§5.2，修复前 sr 链门禁循环对真实模型不可用）；② 失败原因不透传（§6.1-③，停点不可诊断）；③ 任务级真实执行依赖宿主提供 `--task-map` 逐任务配置（R1 即停在此）。且 task-dev 及其后的双 Review/处置/复核/CodeCheck/交付在真实路径上**零证据**。修复这三项并在真实模型下重跑两链走通 task-dev 之前，「支撑 AAW 级流程」仅对流程控制层成立。

## 8. 证据清单与归档（全部位于临时目录 `D:/dev/tmp/`，须归档）

| 路径 | 内容 | 关键文件 |
|---|---|---|
| `D:/dev/tmp/skillsplice-p2-evidence-r1/` | R1 全部证据（63 文件） | `result-stage1/2.json`、`flow-state.json`、`journal.sqlite`（7 节点/28 事件）、4 组 `*.agent.{cmd,meta}.json`、`confirm-1.{md,json}`、`run-meta.json` |
| `D:/dev/tmp/skillsplice-p2-evidence-r2/` | R2 首跑（超时） | `init.agent.meta.json`（timeout 5936.89s）、`result-stage1.json`（blocked timeout） |
| `D:/dev/tmp/skillsplice-p2-evidence-r2b/` | R2 重跑 | `result-stage1.json`（blocked permission）、`journal.sqlite`（4 节点/16 事件）、`gate.r1/gate.fix1/design.agent.*`、`flow-state.json` |
| `D:/dev/tmp/opscopilot-skillsplice-p2-r1/` | R1 隔离工作区（OpsCopilot @ `3f5f4e6`，clean） | `.sdd/SR-001/{dev-design,test-design,tasks-overview}.md`、`.context/dev-design-gate.md` |
| `D:/dev/tmp/opscopilot-skillsplice-p2-r2/` | R2 隔离工作区（同基线，clean） | `.sdd/software_architecture.md`、`.sdd/SR-001/{SR-design,SR-design-gate,original-requirement}.md` |
| `D:/dev/tmp/skillsplice-p2-controlled-rerun-20261103.log` | 受控套件重跑日志（03:51） | — |
| `D:/dev/tmp/skillsplice-p2-flow2-rerun-20261103.log` | flow2 受控重跑日志（09:00，temp 工作区，与 r1/r2 无关） | — |
| `D:/dev/tmp/skillsplice-revision-20261103/` | **修订会话固化目录**（回应审读追问③） | `manifest.sha256`（**216 文件**逐一 sha256：三个证据目录全文件＋两 worktree `.sdd` 树＋两份旧日志＋本目录全部产物；manifest 自身 sha256＝`152922aa1cc6d8c74a860df487ccacf3bb6da806026465bc913b37048466628c`，以此锚定；`apply_edits.py`（本稿审读修订的编辑脚本）亦在清单内）；`logs/`（六套件重跑日志）；`replay/`（§4.3 同构重放副本与 stdout/stderr）；`definitions-tree.sha256`（aaw 46＋task-dev 16 逐文件哈希，自身 sha256＝`18ba39f3d21965741bf44e3f31c4a0950455c14911844e8b80f19712830dc211`）；`make_manifest.py`（清单生成脚本，可重跑核验） |

**再次提醒**：以上均在系统临时盘，未经归档不得作为长期可复核证据；本报告结论的可复核性以这些目录存在为前提。**归档方案（追问③的处置现状）**：哈希清单已由修订会话固化（上表 manifest，任何事后篡改可经 sha256 比对发现）；**物理搬迁**（连同 worktree `.git` 基线与 216 文件定着落点，建议入仓库 `desktop/poc/skillsplice/evidence/p2/` 或团队证据库）属所有者决策，本会话未搬迁——报告修订授权不含大体积证据入库。

## 9. 本会话执行与未执行的检查

已执行（命令级）：四套回归 + scanner + `test_flow2.py`（15/15 PASS）；`gen_aaw_defs.py` 3 跑哈希对比（task-dev 16 / aaw 46 均幂等）；`sha256sum`（flow.yaml、两需求三方、knowledge md 重复对）；`git diff --stat HEAD -- skills/ docs/`（空）与 `git status`；两证据目录全量文件枚举与关键 JSON/sqlite 直查（journal 节点/事件表、agent cmd/meta、result/flow-state/run-meta、confirm-*）；两 worktree 的 `.sdd` 树、`git status`、代码态（service.go / pkg/completion / pkg history / app.go）、`go test -count=1 ./pkg/completion/ ./pkg/terminal/ ./pkg/recorder/`（全 ok）；marker 正则重放（带冒号 0 匹配 / 无冒号 1 匹配 fixed=true）；`grep -n 'AR: "ALL"'`（flow.yaml:77）。

修订会话新增执行（回应审读）：§4.3 同构重放（证据副本＋留档重建前置态＋无 `--task-map`：exit 2 直接观测、结果 JSON 逐字段一致、icode 未被调用、journal 零写入）；六套件重跑并存档日志（§3）；`definitions-tree.sha256` 与 216 文件 `manifest.sha256` 固化（§8）；`real_flow_run.py:258-262/:185-188`、`icode_adapter.py:1764/:1690`、`flow_core.py:695-702` 行号逐处钉准。

未执行（如实声明）：R1/R2 真实运行本身（历史运行，仅静态核验其全部留存证据）；`go test -race`（本机无 cgo/gcc，TC12 已按门禁 O1 登记）；受控清单内 REALRUN 场景（§3 末）；**历史 stage-2 原始命令行的取证**（无 argv 留档，「当时未带 `--task-map`」永远只能是推定＋同构重放充分性实证，§4.3）；FIX_RESULT 代码修复与修复后的真实重跑（§6.1 计划所列，超出报告修订授权）；证据物理搬迁入库（§8）。

## 10. 审读意见逐条回应

独立审读报告判「抽查范围内证据链扎实，未发现把部分通过写成通过、把受控当真实的越界宣称；§5.2 根因独立重放复现成立」，并指出 4 处口径/留档瑕疵与 3 个追问。处置如下（均为修订会话实际执行，非承诺）：

| # | 审读意见 | 处置 | 定位 |
|---|---|---|---|
| 瑕疵① | §4 时间线自相矛盾：`confirm-1.md`@06:54 与 `confirm-1.json`@09:26 被并作一句 | 已拆分表述并注明各自 mtime；时间线改为 md 06:54 撰写、json 09:26 与 stage-2 同刻落盘 | §4 时间线 |
| 瑕疵② | 「exit 2」是代码映射推定，非证据记录 | 全文三处改为「映射推定（`real_flow_run.py:258-262`）＋同构重放直接观测」；历史进程退出码未入证据如实标注 | 文首、§4.3、§7 |
| 瑕疵③ | 四套回归＋scanner「本会话重跑」无日志留档 | 修订会话重跑六套件（全 exit 0）并把完整输出存档于修订目录 `logs/`；撰写会话首跑未留日志的事实保留声明，不回溯伪造 | §3、§8 |
| 瑕疵④ | 行号区间松（:1686-1689 实至 :1690 闭合；flow_core 实为 695 起） | 已收紧为 `:1686-1690` 与 `695-702`（失败路径 698-701），全部行号重新钉准 | §4.2-6、§6.1、§9 |
| 追问① | R1 stage-2 失败究竟为何？宿主命令行为何无留档？能否补对照重放升级为实证？ | 已做**不带侧**同构重放（证据副本＋留档重建前置态＋真实 worktree 只读）：exit 2 直接观测、结果 JSON 与历史逐字段一致、icode 未被调用、journal 零写入；重建局限（确认项已出队不可复原）与不可证性（无 argv 留档）如实声明。带侧需先按 `real_run --task` 契约制作 T1 任务目录，未执行——不臆造执行配置。宿主命令行无留档已列为可观察性缺口（§6.1-③） | §4.3 |
| 追问② | FIX_RESULT 一行级缺陷为何不顺手修复并重跑？ | 给出最小修复（二选一，建议解析器向提示词对齐）＋全 marker 逐字核对＋受控负例＋重跑前置（R2 新证据目录、R1 先制作任务目录）；本修订会话不执行代码修复与真实重跑——报告修订授权不含行为基线变更（修复将使本报告引用的行号/行为失准），列为下一迭代第一项 | §6.1 |
| 追问③ | 临时目录证据何时归档、如何固定？ | 已固化 216 文件哈希 manifest（其 sha256 写入 §8 锚定，篡改可比对发现）＋ definitions 树快照＋重放副本与六套件日志留档；物理搬迁（含 worktree `.git`）属所有者决策，建议落点已列 | §8 |

审读「未核验项」的对应说明：`gen_aaw_defs.py` 幂等为撰写会话 3 跑实测（审读会话因只读约束未重跑；其独立证实的 46/16 文件数与幂等结论方向一致）；任务书素材侧引文（P2-10「46 文件」原文、早稿三稿对比、快照头注逐份核验）不在审读可达范围，本报告对其的口径更正与引用保持原样并标注来源。

## 11. 后续修复（2026-11-03）

本节记录报告完成后的代码修复；前文 R1/R2 的历史结果和证据不变。

- 门禁修复输出：提示词明确要求成功和无法修复两种结果均带 `FIX_RESULT`；解析器接受带冒号和不带冒号的格式，并以最后一个信封为准。缺失或损坏的信封报告 `unparseable_output`，不会误判为权限拒绝；边界检查仍先于结果判定执行。
- 队列停机：`unknown` 与 `failed` 分别向上传递，记录保留具体原因；真实入口将队列停点原因写入结果，不再用空 detail 掩盖缺少 task-map 等问题。两种状态均停止后续队列。
- 待确认标记：根运行在确认点返回 `unknown` 时，根据实际待确认状态和文件标记 `pending_confirm`；普通 unknown 阻塞不被误标成待确认。
- 受控验证：`test_flow2.py` 19 项通过（含原 15 个 P2 场景），覆盖无冒号/旧冒号、最后信封、格式错误、越界优先检查、确认点和缺少 task-map 的真实入口受控场景；`test_poc.py`、`test_definition.py`、`test_flow.py`、`test_adapt.py`、`test_scanner.py` 分别为 18、21、18、29、11 项通过。R2 原始 Agent 文本按新格式解析得到 `fixed=true`；这不代表修复后复审已经通过。
- 边界：未进行真实 iCode 全链重跑；任务配置自动形成、通用恢复及 AAW 工作流职责调整仍未完成。结果不明的队列项不会自动重试，现有入口尚不能将此修复视为通用恢复能力。
