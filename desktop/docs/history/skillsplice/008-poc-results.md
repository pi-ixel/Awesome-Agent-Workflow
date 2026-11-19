# 008 SkillSplice PoC 结果报告（007 工作指导执行结果）

> 状态：**部分验证且阻塞**。受控层（定义格式、内核调度、完整流程分支、iCode 适配层）四套门禁全部通过；真实 CodeCheck 不可用，真实运行（007 阶段 E）未建立，同一次 run 的证据整体缺失。
>
> **实测时点与基线锚定（复核本文任何声明前先读此段）**：本报告有两次实测时点——**T0 = 撰写**（2026-11-02 18:37 前后，本仓库 HEAD = `b1868313523c73e269515196d8a0441e5bf34b23`）与 **T1 = 审读后修订**（2026-11-02 18:56 前后，本仓库 HEAD = `84336d06e595812648d70187a9ca8582f85aca51`，其间本仓库新增一个 SSO 登录提交，未触及 `desktop/poc/`）。文中「本次实测」均属于其标注的时点；**仓库状态类声明（HEAD、porcelain 等）以括注的时点与提交哈希为锚**，本仓库持续演进，读者复核时应以自己当下的 `git rev-parse HEAD` 为准并重新实测，不得把文中快照当作现状。对 `D:/dev/tmp` 下隔离副本与证据目录的声明锚定于 OpsCopilot 基线提交 `3f5f4e696721ed768a5ad67224cba28f00ce1c9a`，与本仓库 HEAD 无关。
>
> 本报告按 [007 §9](007-poc-work-guide.md) 的格式撰写，不覆盖 [006](006-poc-results.md)；006 的结论一律标注为历史记录，不作为本次结果。证据溯源约定：**「T0 实测」**= 撰写会话亲自执行；**「T1 实测」**= 修订会话亲自执行（含对审读会话发现的修正复核）；**「前序实测」**= 同一 PoC 工作流前序阶段执行、已核对其留下证据或状态一致的结果。撰写与修订会话均为只读评估：未修改工作区文件、未执行 git add/commit、未发起真实 iCode 长任务。

## 1. 总体结论

**部分验证且阻塞**（[007 §7.3](007-poc-work-guide.md) 第二类：受控链路全绿也只能作此结论）。

- **已验证（受控层，本次四套门禁实测全绿，70 项）**：定义格式与加载（21 项）、内核执行语义（18 项）、完整流程正负分支（18 项）、iCode 适配层（13 项）。
- **阻塞**：仓库无真实 CodeCheck 扫描器（配套脚本恒 pass mock，§7）；完整真实链路未执行——真实运行尝试在启动门禁按设计停止（exit 2，§6），实现、Review、处置、扫描、交接证据均不存在（§6.2）。
- **演进策略建议：extend（内核保留、外围大幅扩建），不是 rewrite。** 理由：
  1. 执行语义内核已验证且通用——`runtime.py` 不含 task-dev/OpsCopilot/iCode 写死分支，按 `definition['kind']`/`executor` 调度（T0、T1 两次实测 `grep -ciE "icode|opscopilot|task-dev" runtime.py definition.py` → runtime.py **0**；definition.py 的 2 处命中为 `UnicodeDecodeError` 子串误报，definition.py:161、423；注意须用 `-E`，BRE 下 `|` 为字面量会得 0/0）；T0 实测 `python desktop/poc/skillsplice/test_poc.py` → Ran 18 tests OK（T1 复跑仍 OK）。
  2. 不可变定义与内容寻址正确：sha256 规范化 JSON（runtime.py:18-19），restore 校验摘要；DEF-05/06/07、POC-10 实测身份随子/知识/契约变化传播。
  3. 保守恢复语义存在且被测试：中断原子动作置 unknown（runtime.py:167-171）、unknown 外部动作不得借 Review 入口重试（runtime.py:110-130；POC-09、EXTRA-unknown-reopen）。
  4. 真实 iCode 曾在此内核上跑通隔离副本修复+双路 Review+定向复核（006 §3，**历史记录**，按 007 §2.3 复用前须重新核验——本次 t1 副本状态已重新核验，见 §3）。
  5. 007 §2.2 明确允许复用但需重新验证。
- extend 代价（本次已基本付清）：定义格式+加载校验（已完成，DEF-01～19）、task-dev 落盘翻译+对照表（已完成，translation-map.md 审查 pass）、iCode 适配器分离（已完成，icode_adapter.py）、可验证只读隔离（工具层白名单+落盘配置核验已实现，OS 级沙箱边界如实标注）、Runtime 驱动的处置/重验/复核循环（受控层已实现，FF/NEG 场景）、交接与最终 Verification（受控层已实现）、真实 CodeCheck 接入（**仍阻塞**）。
- rewrite 不推荐：需从零重推导并重测细微的 fail-closed 行为（POC-08/09 进程退出注入、隐式并行拒绝、review-retry 门控），重验证成本高且无内核缺陷收益——本次全部场景没有任何一条证明内核语义有缺陷。

## 2. 代码与定义

### 2.1 本仓库状态（双时点实测 `git` 命令；时点定义见报告头部）

| 时点 | HEAD | 检出分支 | main 指向 | `git status --porcelain` |
|---|---|---|---|---|
| T0（撰写，2026-11-02 18:37 前后） | `b1868313523…` | feat/sso-user-login | 同 HEAD | **32 项**（13 修改 + 19 未跟踪路径） |
| T1（修订，2026-11-02 18:56 前后） | `84336d06e595…` | feat/sso-user-login | `b1868313523…`（HEAD 已领先 main 一个 SSO 登录提交 `84336d0 feat(desktop): 用户登录——企业 SSO 对接…`） | **13 项**（2 修改 + 11 未跟踪路径；`-uall` 展开为 150 项） |

- T0 与 T1 之间本仓库落了 SSO 登录提交（触及 desktop/src 等，**未触及 `desktop/poc/`**）；交接素材的「分支 main」「未提交 12 项」与两个时点的实测均不符，以实测为准。
- 两个时点下 PoC 产物目录 `desktop/poc/`、`desktop/docs/skillsplice/` 均在未跟踪集合内，按 007 §5.1.1/§5.1.3 保持不动，未清理或重置。
- 目标仓库基线：OpsCopilot 提交 `3f5f4e696721ed768a5ad67224cba28f00ce1c9a`（隔离副本核验见 §3，锚定于该提交，不随后续副本状态漂移）。

### 2.2 Unit 与知识身份

- 身份机制：解析后形态（子引用→子身份、知识→{name,sha256}、retry 展平）经 `Registry.add` 内容寻址，sha256 规范化 JSON（runtime.py:18-19）；子/知识/契约变化传播到所有祖先（DEF-05/06/07 实测）；Journal 持久化定义快照，restore 摘要校验通过（DEF-08/18）。
- 落盘 bundle（T0 实测目录列表，T1 复核仍在）：`desktop/poc/skillsplice/definitions/task-dev/`（**11 Unit**：task-dev、implementation、semantic-review、reviewer-a、reviewer-b、finding-adjudication、finding-resolution、affected-retest、targeted-rereview、codecheck、delivery + `knowledge/` **5 快照**：task-dev-guidance、semantic-review-prompt、review-extension-rules、codecheck-guidance、delivery-handoff）；`definitions/text-pipeline/`（6 Unit + 1 快照，含并行/foreach/条件分支）。格式为 skillsplice-definition v1（[FORMAT.md](../../poc/skillsplice/definitions/FORMAT.md)）。semantic-review-prompt 快照与源文件 `skills/task-dev/references/semantic-review-prompt.md` 的 T1 实测 `diff --strip-trailing-cr` → **仅快照头部 5 行来源注释为新增（`1,5d0`），其余正文一致**（行尾符 CRLF/LF 差异已由 `--strip-trailing-cr` 消除）。
- **真实 run 的身份钉定记录不存在**：run 未创建（无 journal.sqlite / run-id.txt，§6.2），故本次 run 加载的定义与知识身份、输入绑定均无归档；具体 sha256 值可随时用 `definition_id`（runtime.py:18-19）对 bundle 重算。

## 3. 目标及环境（T0 实测；时点定义见报告头部）

| 项 | 值 | 证据 |
|---|---|---|
| 任务 | OpsCopilot 单个 T1：`GetCompletions` 负数 Cursor 钳零，行为保持见 [005](005-task-dev-test-case.md) | 007 §7.2 |
| 隔离副本 | `D:/dev/tmp/opscopilot-skillsplice-t1`：`git status --porcelain` 仅 `?? pkg/completion/cursor_bounds_poc_test.go`（授权测试载体）；HEAD 实测 = `3f5f4e6…`（`git log` 顶条）；`git diff --cached --stat` 空；fixture 与 `desktop/poc/skillsplice/fixtures/cursor_bounds_poc_test.go` `cmp` 逐字节 **IDENTICAL** | T0 实测 |
| 旧副本 | `D:/dev/tmp/opscopilot-skillsplice-poc` 含上次修复残留 ` M pkg/completion/service.go`（T0 实测），非基线态，real_run.py 拒绝（§5 RUN-01）；`-run2`、`-baseline`、`-aaw` 仍在 | T0 实测 |
| iCode | 0.26.0（`icode --version` 实测）；headless 入口 `icode run` | T0 实测，T1 复验一致 |
| Go | go1.25.5 windows/amd64（`go version` 实测） | T0 实测 |
| Python | 3.10.8 | T0 实测 |
| 扫描器 | **不可用**：仅恒 pass mock（§7） | T0 读源码实测，审读会话复验一致 |

AGENTS.md 核对（T0 实测 `ls`）：本仓库根目录与 `skills/` 顶层均无 AGENTS.md（均报 No such file or directory）。全仓仅有 `skills/repo-init/references/AGENTS.md`（repo-init Skill 随附的目标仓库模板）及 skill-eval 测试夹具/历史快照内的副本，均非约束本仓库的约定。**目标仓库（OpsCopilot）适用的 AGENTS.md 检查属真实运行期义务**（007 §5.1.1、§7.2），须在真实运行前执行。

## 4. 翻译覆盖（已覆盖、未覆盖、与原 Skill 的差异及理由）

- 对照表：[translation-map.md](../../poc/skillsplice/translation-map.md)（前序审查结论 pass；§0 对 codecheck.py 的 mock 核实、§2.6 阻塞声明本次复核在文）。
- **已覆盖**：task-dev 11 Unit + 5 知识快照落盘，翻译依据对照表，快照头部注明原文来源；完整流程（实现→并行双 Review→汇聚合并→逐条处置→重验/定向复核→CodeCheck→交接→完成验收）在受控层经同一未修改内核跑通（§5 FF-01～03）。
- **未覆盖 / 与原 Skill 的差异（含理由，均来自阶段产物的如实记录）**：
  - 逐 Call 输入映射（SkillSplice Link/Port 按调用交接数据）：内核把同一份 inputs+item+prior 传给每个子 Call（runtime.py:206），call 级 inputs 字段被拒绝为不支持；Reviewer 角色因此改用 executor 名区分。
  - 多命名资源绑定：内核一次运行只贯穿一个 workspace 字符串（runtime.py:82 `Journal.create` 签名），根 Unit 声明资源必须含 workspace，其余报不支持（FORMAT.md §6）。
  - verification 语义：加载器只校验形态与可选 allowlist，验证逻辑由应用 Verifier 实现（阶段 C/D 产物），格式不预支。
  - codecheck「低风险修复→受影响测试→复扫」循环的退出条件：格式只表达尝试上限（max_attempts/retry_safe 的异常重发语义，POC-07），循环体内条件评估属适配器语义（FORMAT.md §6），未在格式或内核中实现。
  - 单 Reviewer 片段最小结构检查是新增约束（原 review-report.schema.json 只约束合并报告）；合并报告为 stdlib 结构校验（reviewers minItems 2、dimensions 枚举、finding 必填字段）+ PoC 溯源字段（sources/original_sha256），**非原 schema 全量 JSON Schema 校验**。
  - 真实 T1 输入绑定：测试中的 `VALID_TASK_DEV_INPUTS` 为结构性示例值，不是 007 §6.2 要求的真实 T1 设计/用例/任务范围引用——**仍为开放缺口**（§10）。
- 不可自动证明项（semantic_impact 分级真伪、Review 是否真实覆盖维度、提交信息与代码事实最终一致性；translation-map §3.3）：受控场景只强制声明结构与蕴含，如实标注。

## 5. 受控验证（场景 ID → 结果 → 证据）

### 5.0 门禁命令与结果（T0 撰写会话实测；T1 修订会话对四套门禁全部重跑，再次 18/21/18/13 全 OK）

| 门禁 | 命令 | 结果（T0 / T1） |
|---|---|---|
| 内核 | `python desktop/poc/skillsplice/test_poc.py` | **Ran 18 tests … OK**（T0 4.008s / T1 3.501s） |
| 定义格式 | `python desktop/poc/skillsplice/test_definition.py` | **Ran 21 tests … OK**（T0 2.850s / T1 2.768s） |
| 流程 | `python desktop/poc/skillsplice/test_flow.py` | **Ran 18 tests … OK**（T0 9.705s / T1 4.595s） |
| 适配层 | `python desktop/poc/skillsplice/test_adapt.py` | **Ran 13 tests … OK**（T0 47.691s / T1 27.285s） |
| 编译 | `python -m py_compile icode_adapter.py real_run.py definition.py` | OK |

内核写死检查：`grep -ciE "icode|opscopilot|task-dev" runtime.py definition.py` → runtime.py **0**，definition.py 2（`UnicodeDecodeError` 子串误报，definition.py:161、423，T0、T1 实测一致；**命令须带 `-E`**——BRE 下 `|` 是字面量，照抄不带 `-E` 的写法会得 0/0，与事实不符）。适配器无 shell/环境变量注入：`grep "shell=True|env=|os.environ[" icode_adapter.py` → **0 命中**（T0 实测）；调用走 `asyncio.create_subprocess_exec`（icode_adapter.py:212）。

以下场景表来自前序阶段结果；**场景级结论已由四套门禁在 T0、T1 两次整体重跑确认**（同一测试文件、同一场景编号）。诚实声明（对应审读意见 E）：场景表各行 evidence 中的 **detail 字符串（如 NEG-03 的具体报错文本）是测试内部断言文本，未逐条单独复现**，由上述整体重跑背书；测试函数名经审读会话逐一核对全部存在。单条 evidence 中的行号凡与前序素材不符处已按 T0 实测修正（icode_adapter.py），T1 修订又修正了两处错位（ADAPT-09、RUN-04，见 §5.4/§5.5 行内注）。

### 5.1 定义格式与通用性（test_definition.py，21 项 OK）

| ID | 场景 | 结果 | 证据 |
|---|---|---|---|
| DEF-01 | 格式与版本标识：v1 加载成功，未知 format/format_version 解析前拒绝 | 通过 | test_def_01_format_version_gate |
| DEF-02 | 不支持字段拒绝并带定位（含内核会静默忽略的 retry-on-composite、outputs-on-atomic、call 级 inputs） | 通过 | test_def_02（4 子用例断言精确 location，如 root.json#/retry） |
| DEF-03 | 加载真实落盘 task-dev 定义（11 Unit、5 快照摘要校验）并经同一内核执行通过 | 通过 | test_def_03；/implementation、/review/a、/review/b、/resolution/resolve、/codecheck、/delivery 均有事件且 condition 被求值 |
| DEF-04 | 递归引用可追踪：引用图逐边断言、按 id 遍历闭合、id↔名称双向解析、8 atomic 无孤儿 | 通过 | test_def_04 |
| DEF-05 | 子 Unit 定义变化 → 子与祖先身份变化，兄弟/无关 Unit 不变 | 通过 | test_def_05 |
| DEF-06 | 知识快照重钉摘要 → 引用它的 6 个 Unit 及祖先身份变化，其余 5 个不变 | 通过 | test_def_06 |
| DEF-07 | 输入契约变化 → 根身份变化，子 Unit 身份不变 | 通过 | test_def_07 |
| DEF-08 | 身份确定性；旧版本可引用可运行；Journal restore 摘要校验通过 | 通过 | test_def_08 |
| DEF-09 | 缺失子 Unit 引用：拒绝并定位引用方与期望路径 | 通过 | test_def_09 |
| DEF-10 | 循环引用：拒绝并报告完整环路径 a -> b -> a | 通过 | test_def_10 |
| DEF-11 | 快照与声明摘要不一致：加载时拒绝；create_run 重验拒绝加载后被篡改的快照 | 通过 | test_def_11 |
| DEF-12 | 固定知识文件缺失：拒绝并给出路径 | 通过 | test_def_12 |
| DEF-13 | 输入契约启动前强制：缺必填/类型错（bool≠integer）/枚举外/多余键/根保留名，定位 inputs/&lt;名&gt; | 通过 | test_def_13 |
| DEF-14 | 不可执行条件：引用不存在/同组/更晚组 Call、缺 equals → 加载期拒绝并定位 | 通过 | test_def_14（3 个 location 精确断言） |
| DEF-15 | foreach 引用未声明输入、非 foreach 调用无法满足子 Unit 必需 item → 拒绝；合法展开可加载 | 通过 | test_def_15 |
| DEF-16 | 资源绑定启动前强制：未绑定/未知/路径不存在拒绝；绑定值进入运行 | 通过 | test_def_16 |
| DEF-17 | 结构错误全部拒绝并定位：缺 executor/verification、retry-on-composite、groups-on-atomic、坏摘要、隐式并行、重复/斜杠 call id、空 calls、未引用文件、未钉快照 | 通过 | test_def_17（6 个 location 断言 + 5 独立用例） |
| DEF-18 | create_run 持久化定义快照：root 匹配、restore 校验通过、恢复后可继续执行 | 通过 | test_def_18 |
| DEF-19 | verification 名称不在应用集合内 → 报不支持（不静默默认 always） | 通过 | test_def_19 |
| ALT-01 | 通用性：小型组合定义不经任何 Runtime/加载器源码修改即可加载运行（串行、显式并行、foreach、空集零展开） | 通过 | test_alt_01（runtime.py 未改） |
| ALT-02 | 通用性：条件分支由 Runtime 求值——verdict≠pass 时 summarize 跳过并记录 skipped/condition | 通过 | test_alt_02 |

### 5.2 内核执行语义（test_poc.py，18 项 OK；场景先落盘为 v1 定义、经未修改 load_bundle/create_run 加载）

| ID | 场景 | 结果 | 证据 |
|---|---|---|---|
| POC-01 | 嵌套组合：父调子、子内显式并行 | 通过 | test_poc_01_nested：executed == {/review/a, /review/b}，node(/review) passed |
| POC-02 | 实现验收失败阻断下游 Review | 通过 | test_poc_02：executed == ["implementation"]，review 未执行 |
| POC-03 | 并行屏障：两名成员均到屏障前下游不得启动 | 通过 | test_poc_03：asyncio.Event 屏障，release 后才推进 |
| POC-04 | 显式串行；同组多 Call 未声明 parallel 被拒绝 | 通过 | test_poc_04：load_bundle 抛 DefinitionError 含定位 root.json#/groups/0 |
| POC-05 | finding 处置链：含 finding 的 Review 仍算完成，条件触发 fix→test→rereview | 通过 | test_poc_05：原报告 "original" 保留于 node(/a) |
| POC-06 | 执行与验收分离：执行者成功文本 ≠ Verification 通过 | 通过 | test_poc_06：事件同时含 execution_returned 与 verified（runtime.py:252-255） |
| POC-07 | 有限重试：max_attempts=2 且 retry_safe | 通过 | test_poc_07：once→passed、always→failed，attempts 均 2 |
| POC-08 | 恢复：已确认结果重启后复用，不重复执行 | 通过 | test_poc_08：子进程 os._exit(91) 后 resume passed，事件含 reused_confirmed |
| POC-09 | 恢复：外部操作结果不明停 unknown，不盲目重试 | 通过 | test_poc_09：os._exit(92) 后 resume 停 unknown（runtime.py:167-171） |
| POC-10 | 身份随定义快照变化：知识重钉后子与祖先身份变化，旧版本可引用可运行 | 通过 | test_poc_10：旧 run 携带旧身份 a，新 run 携带 b |
| POC-11 | 同一 Unit 绑定不同隔离工作区，互不串扰 | 通过 | test_poc_11 |
| POC-12 | foreach 动态展开：空集与多项均按输入展开 | 通过 | test_poc_12 |
| POC-13 | 完成验收以证据为准：缺任一必填证据即失败 | 通过 | test_poc_13（**完成验收证据字段为模拟**，006 §2 自认，不证明真实报告内容） |
| EXTRA-join | 并行一方失败时汇聚不得执行 | 通过 | test_parallel_failure_prevents_join |
| EXTRA-unavailable | 不可达条件加载期拒绝；运行期条件字段缺失/可选 foreach 输入缺失暂停 unknown 且不伪成功 | 通过 | test_unavailable_branch_and_expansion_inputs_pause |
| EXTRA-fanout-outputs | foreach 展开保留全部输出且有序 | 通过 | test_expansion_retains_all_outputs：output[item] == [a, b, c] |
| EXTRA-review-retry | Review 处置重试须凭已记录裁决证据，历史保留、attempt 递增 | 通过 | test_review_retry_requires_recorded_adjudication…：事件含 manual_review_retry_authorized |
| EXTRA-unknown-reopen | unknown 外部操作不可伪装成 Review 处置重开 | 通过 | test_unknown_external_action_cannot_be_reopened_as_review（runtime.py:110-130 ValueError） |

### 5.3 完整流程正负分支（test_flow.py，18 项 OK；模拟执行者+模拟扫描器，经落盘 task-dev 定义与九门禁）

| ID | 场景 | 结果 | 证据 |
|---|---|---|---|
| FF-01 | 无 finding：实现→并行双 Review→汇聚合并（单独记录）→处置→CodeCheck→交接→完成验收全部通过 | 通过 | test_ff_01：executed 顺序完整；/implementation 与 /codecheck 均有 execution_returned+verified 双事件；merged-review.json original_sha256 与 Journal 原件一致 |
| FF-02 | 有 finding（机械修复）：逐条 fixed 带依据→受影响测试重验→通过，无定向复核 | 通过 | test_ff_02：semantic_impact=none ⇒ 不触发复核；sources=["A-1"] |
| FF-03 | 高风险/语义修改：触发原 Reviewer 定向复核，报告独立且覆盖被复核 finding | 通过 | test_ff_03：targeted.re_review_of=["M-1"]、role=A |
| NEG-01 | 一方 Reviewer 报告无效（verdict=pass 带 findings）→ 汇聚拒绝，CodeCheck/交接不启动 | 通过 | test_neg_01：detail 含 'verdict=pass requires empty findings' |
| NEG-02 | 一方 Reviewer 未完成（重试耗尽）→ 汇聚拒绝 | 通过 | test_neg_02：/review/a attempts=2 后 failed |
| NEG-03 | finding 未逐条处置 / 谎报 code_changed 试图跳过重验 → 两条路都无最终成功 | 通过 | test_neg_03：(a) 'exactly one disposition (open: [M-1, M-2], disposed: [M-1])'；(b) 'code_changed must be True' 且重验零执行 |
| NEG-04 | 修复后重验失败（退出码 1）→ 闭环失败 | 通过 | test_neg_04：detail 含 'exited 1'——退出码语义来自受影响测试的真实退出结果，由 Verifier 门断言；task-dev SKILL.md「修复与重验」节（原 :129 附近）只规定「修改后执行受影响测试和必要构建」，未规定退出码语义，故不以该行作为退出码依据 |
| NEG-05 | 需定向复核但报告不覆盖被复核 finding → 闭环失败 | 通过 | test_neg_05：'must cover flagged findings [M-1] but covers []' |
| NEG-06 | 需定向复核但原 Reviewer 不可用 → 暂停/失败，不换人冒充 | 通过 | test_neg_06：attempts=2 后 failed（runtime.py:250） |
| NEG-07 | CodeCheck 为 mock：身份被识别并阻塞（退出码 0、verdict=pass 也不行）→ 无最终成功 | 通过 | test_neg_07：result unknown、detail 含 'mock-codecheck' |
| NEG-08 | CodeCheck 缺失（重试耗尽）→ 阻塞终态 | 通过 | test_neg_08：attempts=2 failed |
| NEG-09 | CodeCheck 异常输出（非原生报告）→ 验收失败 | 通过 | test_neg_09：'not a native result object' |
| NEG-10 | CodeCheck 失败（正式身份、退出码 1 带清单）→ 失败不得解释为通过 | 通过 | test_neg_10：detail 含 'exit 1'（code-check SKILL.md:15） |
| NEG-11 | go vet 输出替代正式扫描 → 身份不被承认 | 通过 | test_neg_11：detail 含 'go vet' 与 'official scan' |
| NEG-12 | 交接缺 tasks-overview 记录 / 状态非 Completed → 拒绝 | 通过 | test_neg_12：两次 run /delivery 均 failed |
| NEG-13 | 交接缺「实现期补充与残余风险」必填小节 → done 门拒绝 | 通过 | test_neg_13 |
| NEG-14 | 执行者自称成功但无验收证据 → 实现验收失败，Review 及之后全部不启动 | 通过 | test_neg_14：detail 指明 implementation.json 证据结构缺失 |
| NEG-15 | 中断后外部操作结果不明 → 停 unknown，不盲目重试、不可经 review 处置口重开 | 通过 | test_neg_15：二次恢复仍 unknown；authorize_review_retry('/codecheck') 抛 ValueError（runtime.py:110-130） |

### 5.4 iCode 适配层（test_adapt.py，13 项 OK；假 icode/假 go/假扫描器替身，同一内核同一九门禁）

| ID | 场景 | 结果 | 证据 |
|---|---|---|---|
| ADAPT-01 | 调用留证：argv/cmd.json、stdout/stderr、meta 落盘可查 | 通过 | test_adapt_01 |
| ADAPT-02 | 调用结束、执行成功、Verification 通过三者独立 | 通过 | test_adapt_02（三层断言） |
| ADAPT-03 | 超时被杀：分类 timeout，外部效果不明 → unknown 可续跑，恢复不盲目重试 | 通过 | test_adapt_03 |
| ADAPT-04 | 退出码非 0（错误信封）：分类 exit_nonzero，重试耗尽 → failed | 通过 | test_adapt_04（node attempts=2） |
| ADAPT-05 | stdout 非 --json 信封：分类 unparseable_output → unknown 阻塞，原文留证 | 通过 | test_adapt_05 |
| ADAPT-06 | Reviewer 回复缺结构化结论：分类 report_noncompliant，原始回复落盘 | 通过 | test_adapt_06 |
| ADAPT-07 | icode 可执行器不存在：分类 tool_missing → unknown，零调用零下游 | 通过 | test_adapt_07 |
| ADAPT-08 | Reviewer profile 含 filesystem.write：调用前拒绝，核验记录+问题清单落盘 | 通过 | test_adapt_08 |
| ADAPT-09 | 只读 profile（恰为 filesystem.read+search）核验通过：逐字节副本+sha256 落盘 | 通过 | test_adapt_09；T0 会话内直测本机 pinned `AAW Eval Reviewer A/B`：builtins=['filesystem.read','search'], problems=[]（T1 实测 profile YAML：`%APPDATA%/chrys/agents/AAW Eval Reviewer A.yaml` 第 9-12 行恰为 `tools:`/`builtins:`/`- filesystem.read`/`- search`，第 13 行起为 `skills: paths: []`，另有 `user_can_override: false`） |
| ADAPT-10 | 扫描器源码自称 mock：不执行、分类 scanner_mock_blocked → unknown 可续跑 | 通过 | test_adapt_10 |
| ADAPT-11 | 固定 argv 无 shell 无环境变量注入；argv 逐项一致 | 通过 | test_adapt_11；grep 三子串零命中（T0 实测） |
| ADAPT-12 | 受控端到端（模拟证据）：假执行者+声明正式身份的假扫描器经内核 passed | 通过 | test_adapt_12（**明确标注模拟，不构成真实扫描/Review 证据**） |
| ADAPT-13 | Review 有 finding：review 以有效 finding 完成，处置停 unknown；凭处置证据经 authorize_review_retry 显式重开 | 通过 | test_adapt_13（finding-adjudication 执行 2 次，codecheck 始终未执行） |

错误分类与边界（T0/T1 实测代码位置，交接素材所引行号已修正）：OUTCOME_CLASSES **八类**（ok、exit_nonzero、timeout、unparseable_output、report_noncompliant、tool_missing、permission、scanner_mock_blocked）见 icode_adapter.py:114-116；exit_nonzero 的识别（返回码非 0，**或 exit 0 但信封为错误对象**）在 icode_adapter.py:276-278，399-401 是实现调用消费方据此抛 `AdapterCallFailed` 的位置（识别与消费两层）；只读 profile 逐项核验（无 filesystem.write/shell、无 sub_agents、skills 关、user_can_override=false）见 icode_adapter.py:329-368；门禁继承（`class RealRunHarness(FlowHarness)`，门禁逻辑零复制）见 icode_adapter.py:643-645；角色与 task_id 由适配层注入不信任模型自报。

### 5.5 真实运行入口启动门禁（real_run.py）

| ID | 场景 | 结果 | 证据 |
|---|---|---|---|
| RUN-01 | 脏工作区诚实拒绝并列出 porcelain 状态 | 通过 | T0 复跑、T1 再复跑均一致：`python desktop/poc/skillsplice/real_run.py --workspace D:/dev/tmp/opscopilot-skillsplice-poc --evidence %TEMP%/rr-verify-8` → **exit 2**，'workspace is not the expected pristine baseline with only the untracked PoC test: [?? pkg/completion/cursor_bounds_poc_test.go, M pkg/completion/service.go]' |
| RUN-02 | 基线门禁：对已含上次修复的副本拒绝复现 panic | 通过（前序实测，本次未重跑——需在副本内执行 go test） | 前序阶段（T0 之前）直调 run_baseline → RuntimeError 'baseline did not reproduce the expected negative-Cursor panic; exit=0'；其前提（该副本含修复、非基线态）T0 实测一致（§3 旧副本行） |
| RUN-03 | 参数门禁：--resume 无 journal、workspace 形状不符均拒绝 | 通过 | T0 复跑、T1 再复跑均一致：`--resume --workspace …-t1 --evidence %TEMP%/rr-verify-8-empty` → **exit 2** '--resume needs an existing journal.sqlite and run-id.txt'；workspace 校验规则见 real_run.py:105-122 |
| RUN-04 | iCode 本机契约实测：headless 入口、--json 信封、退出码、agent 解析 | 通过 | T0 复跑（审读会话 T1 亦复验一致）：`icode --version` → 0.26.0；`icode run -a no-such-agent-id --json -C . "reply OK"` → **exit 1** + `{"error": "Agent profile not found: no-such-agent-id. …", "code": "profile_not_found"}`；适配器据此实现 exit 0 错误信封的双重识别（识别逻辑 icode_adapter.py:276-278，399-401 为消费方抛错位置）。前序另有一个只读 Explore profile 的极短 reply-OK 调用（exit 0），未重跑（会发起真实 Agent 调用） |

## 6. 真实运行

**真实运行未成功**：退出码 2，输出末尾 `real_run: --resume needs an existing journal.sqlite and run-id.txt under D:\dev\tmp\skillsplice-poc-evidence-2`（前序实测；同型拒绝路径本次已复跑确认，RUN-03）。没有任何 run 被创建——**run ID：不存在**。

### 6.1 本次尝试留下的真实证据（本次逐项读取核实）

- 修改前负数 panic 复现记录成立：`D:/dev/tmp/skillsplice-poc-evidence-2/baseline/go-test-baseline.log` 实含 `--- FAIL: TestCursorBoundsPoC/negative/tar_-c` 与 `panic: runtime error: slice bounds out of range [:-1]`（指向 opscopilot-skillsplice-t1/pkg/completion/service.go:29）；`exit-code.txt` = 1；`command.txt` 记录 `go test ./pkg/completion`、cwd、HEAD=3f5f4e6…、go1.25.5、时间 2026-11-02T18:10:02+0800。
- 工作区边界成立：t1 副本 porcelain 仅 `?? pkg/completion/cursor_bounds_poc_test.go`，HEAD=3f5f4e6…、无新增提交、暂存区干净（T0 实测）。
- 隔离副本来源绑定可核验：`baseline/copy-provenance.txt` 记录 clone 自 `D:/dev/tmp/OpsCopilot`、checkout 3f5f4e6…、复制前 status 干净、fixture 复制路径；`cmp` t1 副本 fixture 与仓库 fixture → IDENTICAL（T0 实测）。

### 6.2 证据缺口（7 项，本次 find/ls 实测确认不存在）

1. **同一次 run 的记录整体缺失**：`skillsplice-poc-evidence-2` 仅有 `baseline/`（本次 `ls -R` 实测）；全盘搜索无 journal.sqlite / run-id.txt / result.json / task-inputs/——run ID、定义与知识身份、输入绑定、每个 Call 与 Verification 状态、分支原因全部无记录。
2. **两份独立 Review 原件**：不存在；单独的合并报告：不存在；「处置未回写原报告」无法核验。
3. **每条 finding 的 fixed/rejected 处置及依据**：不存在；原 Reviewer 定向复核报告：不存在。
4. **TD-01～06 修改后的真实命令与输出**：不存在；`go test ./pkg/completion` 修改后输出：不存在——实现尚未发生（t1 的 service.go 未被修改，porcelain 实测干净）。
5. **TD-06 修改前基线对照**：缺失。基线日志在首个负数子测试 panic 时中止整个测试进程（fixture 顺序 negative→above→existing→valid），above/existing/valid 子测试在基线中从未执行；real_run.py:148-155 要求的独立正基线（baseline-positive.*）也不存在。正常位置修改前行为无独立记录。
6. **CodeCheck 原生结果或明确的阻塞记录**：两者都不存在（连按设计应有的 mock 阻塞记录也没有——run 未进入执行）。
7. **tasks-overview 执行记录（含「实现期补充与残余风险」小节）**：不存在；候选提交信息：不存在。

## 7. CodeCheck：具体阻塞（仅做过模拟）

- **真实原生结果：不存在。** 本机与仓库均无生产扫描器。
- 仓库配套脚本为恒 pass mock（T0 读取源码实测，审读会话 T1 复验一致）：
  1. `skills/code-check/scripts/codecheck.py:1` docstring 自述 *"Temporary CodeCheck CLI entrypoint replaced by the production scanner at release."*
  2. 报告 JSON 固定写 `"tool": "mock-codecheck"`、`"verdict": "pass"`（codecheck.py 约 28-34 行）。
  3. 不做任何扫描，无条件打印固定消息并 `return 0`（codecheck.py 约 42-45 行），对任何输入代码都通过。
  4. `skills/code-check/SKILL.md` 描述的契约（以退出状态和原生报告为结果、CLI 不可用/异常时停止、不得把失败解释为通过）是调用方要求，配套脚本本身未实现扫描器；translation-map §0 独立核实结论一致。
- 原型已正确 fail-closed：real_case.py:96-98 读该脚本源码，含 `mock-codecheck` 或 `Temporary CodeCheck CLI` 即拒绝当作真实结果；受控场景 NEG-07/NEG-11/ADAPT-10 验证门禁行为（mock 身份、go vet、字面 stdout 均不被承认）——**这些是模拟证据，不构成真实扫描**。
- 历史注记（非本次结果）：006 记录 run2 进入 CodeCheck 后停 unknown、AAW 工单 SR-998 保持 Blocked 未提交 completion.json；该状态本次未改变。

## 8. 交接与限制

- **交接未发生**：无 tasks-overview 执行记录、无候选提交信息、无最终 Verification 与实际结论（§6.2 缺口 7）。受控层的交接门禁（NEG-12/13、FF-01）只证明门禁行为。
- **补充测试**：四套门禁 70 项本次全绿（§5.0）；`py_compile` 三文件通过。
- **残余风险与边界（如实标注）**：
  - Reviewer 只读保证是**工具层**（profile 白名单恰为 filesystem.read+search、无 shell、无 sub_agents、skills 关闭、user_can_override=false；本机 pinned profile 实测通过）+ 落盘配置核验，**非 OS 级沙箱**：headless BYPASS 审批模式下若 profile 含 shell 工具则无法机制性阻止 shell 写文件（本机 pinned profile 不含 shell，风险不触发）。007 §6.3.3 的「隔离执行上下文」以独立进程+独立会话+工具白名单实现。
  - **只读核验是否每次调用强制、失败后 run 停在何处（回应审读追问，T1 实测代码位置）**：是，前置强制。全部 Reviewer 调用（reviewer-a/b，icode_adapter.py:677、681；定向复核 targeted-rereview 角色复用 A，:511）都走唯一入口 `reviewer_call`（:461），其第一步即 `check_reviewer_profile`（:465）——每次调用前重读落盘 profile 并逐项核验，不过即返回 `unavailable("permission")`，核验记录+问题清单落盘；`verify` 把 `unavailable` 映射为 `unknown`（:697-703），该 Reviewer Call 及其祖先停在 unknown、下游零执行，run 可续跑但重开须凭授权证据（ADAPT-08 实测：假 icode 未收到该 agent 调用）。**注入诱导场景**：Reviewer 进程根本未加载 filesystem.write/shell 工具，prompt 注入无法经工具层触发写路径；剩余暴露面是核验与调用之间 profile 文件被篡改（核验逐字节副本+sha256 落盘可事后发现，但不阻止当次调用）与 OS 进程层——两者都在工具层保证之外，如实标注。
  - 首次真实运行可能需按真实模型对 REVIEW_RESULT 信封的遵从率调整 prompt 措辞（前序判断；真实 Review 报告实际形状未经真实模型验证）。
  - 内核运行期不重复校验子 Unit 输入契约（仅加载期静态可满足性检查，FORMAT.md §5 如实记录）；恢复时 passed 节点复用未做定义/输入/工作区/证据适用性证明（runtime.py:164-166 无条件复用，§6.5 缺口在受控层未关闭，仅确认复用+unknown 停滞语义被测试）。
  - iCode 0.26.0 的 `-s` 会话恢复（原 Reviewer 会话续用）未被适配层使用：定向复核靠 pinned profile id 保证角色身份；单次会话跨 run 续用未验证。
  - 超时/中断后外部效果判定为保守 unknown，不探测部分写入；实现 Agent 中途超时后工作区可能已有部分修改，依赖 `--resume` 前人工检查。
- **约定遵守**：T0 与 T1 两个会话均只读，未修改仓库文件、未动 git 暂存/提交、未清理现有未提交内容；证据路径不含密钥；未虚构 CLI 返回、未把自管状态称作 AAW 工作单状态（007 §4.3、§6.3.5、§9.4）。

## 9. 下一步（解除阻塞或修复失败的最短动作）

1. **准备/使用合规隔离副本并发起真实运行**：t1 副本当前恰好满足启动门禁（porcelain 仅 `?? fixture`、HEAD=基线、暂存区干净，T0 实测）；执行 `python desktop/poc/skillsplice/real_run.py --workspace D:/dev/tmp/opscopilot-skillsplice-t1 --evidence D:/dev/tmp/skillsplice-poc-evidence-2`（无 --resume）。入口会先重跑负/正基线（real_run.py:148-155 的正基线校验将补上当前缺失的 TD-06 对照），再经 Bundle.create_run 进入真实 iCode 执行。运行前按 007 §5.1.1 检查 OpsCopilot 适用的 AGENTS.md，冲突即停止并记录。
2. **获取正式 CodeCheck 扫描器**（仓库外依赖，唯一硬阻塞）：没有它，真实运行必然停在 codecheck 门禁的 unknown 阻塞点。**来源与就位时间本报告无法承诺**——它随生产扫描器发布（codecheck.py:1 自述「replaced by the production scanner at release」），获取渠道属仓库外决策，本报告如实不预支。
3. 若首跑 Reviewer 信封遵从率低，仅调整 pinned profile 的 prompt 知识快照并重钉摘要（身份随之变化、旧版本仍可引用，DEF-06/08 机制），不需改内核。
4. 若运行中断出现 unknown：人工核验工作区状态后凭处置/确认证据走 `authorize_review_retry`（受控机制已验证，ADAPT-13、EXTRA-review-retry）；无法证明旧结果仍适用时用新隔离副本重跑，不拼接不同 run（007 §7.3）。

### 9.1 中间态 run 的验收标准（回应审读追问：CodeCheck 之前的真实证据能支撑什么结论）

**正式 CodeCheck 就位前，先跑完 CodeCheck 之前全部环节的中间态 run**（mock 在 codecheck 门禁按设计阻塞为 unknown，NEG-07/ADAPT-10 已验证该停点）——其证据**能否独立支撑部分结论，按下述标准验收，不满足就继续整体挂起**：

- **可支撑「实现与 Review 环节真实通过（唯扫描被阻塞）」的中间结论，须全部满足**（对应 007 §9 第 4 项证据清单 + §6.2 七项缺口逐项闭合）：
  1. 同一 run ID 的 `journal.sqlite` + `run-id.txt` 存在且事件链覆盖每个 Call 与 Verification（run ID、定义与知识身份、输入绑定可查）；
  2. 两份 Review 原件独立落盘 + 单独合并报告（original_sha256 与原件可对照）；
  3. 每条 finding 的 fixed/rejected 处置及依据落盘；需要时原 Reviewer 定向复核报告存在且覆盖被复核 finding；
  4. TD-01～06 修改后真实命令与输出、`go test ./pkg/completion` 真实输出、TD-06 修改前负/正独立基线齐全；
  5. tasks-overview 执行记录（含「实现期补充与残余风险」小节）与候选提交信息存在；
  6. CodeCheck 停点的**阻塞记录**存在（unknown + mock 识别证据），而非静默跳过。
- **即使上述全满足，也不改变的两点**：总体结论仍为「部分验证且阻塞」（007 §7.3：即使模拟链路全绿、部分环节真实通过，缺正式 CodeCheck 就不是端到端通过）；不得把中间态 run 的 Review/处置证据改述为「已含真实扫描」。
- **扫描器就位后**：按内核恢复语义 `--resume` 续跑同一 run（unknown 停点正是为此设计）；若工作区在停点期间被改动且无法证明旧结果仍适用，则弃用中间 run、以新隔离副本整体重跑，不把两段拼成一个通过（007 §7.3）。

## 10. 按 007 §9 第 5 项逐项回答

- **做了什么**：阶段 A–D 全部完成（翻译对照表、skillsplice-definition v1+加载校验器+落盘 task-dev/通用两份 bundle、未修改内核经落盘定义驱动、完整流程九门禁、iCode 适配层+真实运行入口）；阶段 E 仅完成启动门禁与修改前负基线复现，真实 run 未建立。演进策略评估结论：extend。
- **哪些真实执行过**：四套门禁 70 项（T0、T1 两次重跑全绿）；真实 `go test` 负基线复现（evidence-2/baseline，panic 与 exit 1 于 T0 读取核实）；t1 隔离副本与 fixture 逐字节核验（T0）；icode 契约探针（--version、no-such-agent → exit 1 错误信封，T0 复跑、审读会话 T1 复验）；real_run.py 启动门禁拒绝路径（exit 2 ×2，T0 复跑、T1 再复跑）；本机 pinned Reviewer profile 只读核验（T0 读 YAML、T1 复核行号）。
- **哪些是模拟**：test_flow.py 与 test_adapt.py 的全部执行者与扫描器均为替身（含 ADAPT-12 受控端到端）；受控场景中的 Review 内容、finding、CodeCheck 报告均为模拟证据，不冒充真实扫描或真实 Review（007 §7.1 分层定位）；test_poc.py 的 POC-13 完成验收字段为模拟。
- **与原 Skill 的差异**：§4（逐 Call 输入映射、多命名资源、verification 语义、复扫循环退出条件、单 Reviewer 片段结构门为新增约束、合并报告非全量 JSON Schema 校验、Reviewer 角色以 executor 名区分）。
- **失败/阻塞及影响**：真实 CodeCheck 缺失（唯一硬阻塞，端到端不可完成）；真实运行未建立（7 项真实证据缺口，§6.2）；只读保证限于工具层；passed 复用无适用性证明。影响：总体结论被压在「部分验证且阻塞」——即使受控链路全绿，按 007 §7.3 也只能作此结论。
- **后续最短动作**：§9（用 t1 副本发起真实运行跑通 CodeCheck 之前全部环节 + 获取正式扫描器后续跑）。

## 11. 补充复核批注（2026-11-02）

> 以下是对上述报告及当时工作区代码的独立复核意见。保留 §1～10 的原始记录；前文 T0/T1 测试结果属于其各自时点，不因本次复测结果而改写。代码与临时目录后续可能变化，修复时应重新核对。

### 11.1 对整体进度的判断

认可报告的总体结论 **「部分验证且阻塞」**：已经有独立定义、加载器、流程控制原型、iCode 适配器及受控测试；尚未建立一次由该定义驱动的真实 task-dev run。模拟测试和历史实验均不能替代这次真实运行。

但前文 §1、§9、§10 的「阶段 A–D 全部完成」「CodeCheck 是唯一硬阻塞」表述需要收窄：真实适配器仍有输入传递、finding 处置、定向复核、交接和恢复等影响目标达成的实现缺口。**正式 CodeCheck 是最终端到端验收的外部依赖之一，不能解释其他缺口。**

### 11.2 需要先处理的实现问题

| 复核项 | 代码事实与影响 | 建议验收方式 |
|---|---|---|
| 真实任务输入 | [real_run.py](../../poc/skillsplice/real_run.py) 的 `write_task_inputs` 生成任务文档，但 `AdapterConfig` 未传入 `task_inputs_dir`；[icode_adapter.py](../../poc/skillsplice/icode_adapter.py) 的 `implementation_prompt` 在该目录为空时不会装入设计/测试文档。`reviewer_prompt` 也未提供权威设计和测试规格引用。真实 Agent 可能只有 Task 编号、文件范围等信息，无法据此正确执行和审查。 | 检查真实入口实际构造的实现与两路 Review 输入，断言对应任务、设计、用例及必要上下文真实可访问，缺失时阻塞；补充经过真实入口的测试，而非仅在测试配置中注入目录。 |
| finding 处置 | `ICodeAdapter.finding_adjudication` 遇到 finding 固定返回 `needs_adjudication`，没有真实修复或读取有效处置结果的完整路径。[test_adapt.py](../../poc/skillsplice/test_adapt.py) 的 ADAPT-13 在授权重开后仍断言 `unknown`，只能证明节点被重试，不能证明处置闭环。 | 让 Runtime 驱动可追踪的裁决、修复或有依据拒绝、受影响测试和必要复核；测试有 finding 的真实适配路径，并证明下游只有在证据齐全时才能继续。 |
| 原 Reviewer 定向复核 | `targeted_rereview` 固定调用角色 A；对于 B 提出的 finding 不能证明由原 Reviewer 复核。适配器还自行写入 `re_review_of`，不能仅据此证明模型报告实际覆盖相关 finding。复用同一 profile 也不自动证明续用了原会话。 | 按 finding 来源路由到可确认的原 Reviewer，保留实际返回内容并核验复核对象；身份或复核内容无法确认时阻塞，不补写字段冒充通过。 |
| 恢复与续跑 | [runtime.py](../../poc/skillsplice/runtime.py) 遇到既有 `unknown` 节点直接暂停；`authorize_review_retry` 只接受特定的 `needs_adjudication` 节点，不能重开 CodeCheck 等任意 `unknown`。已通过节点恢复时也没有证明工作区与证据仍适用。§9.1 直接建议扫描器就位后 `--resume`，目前缺少代码能力及验证依据。 | 区分「尚未发起的依赖缺失」与「外部动作已发出、结果不明」；只有在完成适用性核验并有明确授权/证据的情况下才允许相应恢复，否则保守停止或新建 run。用真实停点和负向测试验证，不以重试入口存在代替安全恢复。 |
| 交接回填 | `ICodeAdapter.delivery` 生成 `handover.json` 和内存中的 `tasks_overview_record`，未实际写回 `tasks-overview.md`；`gate_handover` 主要验证对象字段。前文 §9.1 要求 CodeCheck 阻塞前已有最终交接，但定义将 delivery 放在 CodeCheck 之后。 | 正式完成时实际回填并验证任务文档，完成状态不得先于 CodeCheck 通过。若需在阻塞前交接，另行记录明确标识为阻塞/未完成的中间状态，不伪造最终 Completed。 |
| CodeCheck 接口与修复循环 | 扫描器仍为 mock；受控门禁中的 `codecheck-scanner/1.0` 是测试代码中的固定身份，不能预先证明与将来的正式 CLI 原生契约一致。低风险修复→测试→复扫的真实循环也尚未证明。 | 获取正式工具后以其真实调用方式和原生报告为准接入、验证；通过受控测试覆盖低风险修复、重验、复扫、超限与升级决策，不能把替身报告当作正式扫描。 |

上表中的代码审阅结论与 §4、§8 已披露的部分限制相互补充：它们并不否定定义加载、并行屏障等受控测试的价值，但意味着不能把受控流程的通过直接推广为真实适配链已具备相同行为。

### 11.3 测试和运行建议的复核

- 本次复跑 `test_poc.py`、`test_definition.py`、`test_flow.py` 分别为 **18、21、18 项通过**。`test_adapt.py` 在当时环境中没有复现 13 项全通过：默认环境有 2 项中文输出编码断言失败；设置 `PYTHONUTF8=1` 后这两项通过，但另有 1 项因并行 Reviewer 调用顺序与断言不一致而失败。需修复或明确测试的编码和并发假设后重新复测；不能以此否认报告中 T0/T1 的历史测试记录。
- §9 推荐的新运行证据目录 `D:/dev/tmp/skillsplice-poc-evidence-2` 在本次复核时已有 `baseline/`，而 `real_run.py` 新运行要求证据目录为空。实际运行前应新建未占用的证据目录和隔离副本，检查目标仓库适用的 `AGENTS.md`，并重新核对基线及环境；不要清空既有证据来满足门禁。
- 本次复核未发起新的真实 iCode 任务，也未获得真实 CodeCheck 结果。上表中「建议验收方式」是后续要求，并非已完成的验证。

### 11.4 建议的下一阶段交接边界

优先打通一条**可真实执行到 CodeCheck 阻塞点的垂直链路**：修复任务输入与真实适配器中的关键缺口，补充对应正负测试；在新隔离副本中，由 Runtime 加载独立 task-dev 定义、调用真实 iCode 完成实现与两路 Review，按实际 finding 完成必要处置和重验，记录同一 run 的证据，到真实 CodeCheck 不可用处如实暂停。若途中出现其他阻塞，应在实际位置停下并报告，不预设必然到达扫描环节。

阶段交接应包含：具体代码和定义变化、复现入口、测试结果、真实 run ID 与证据位置、已发生的 Review/finding、阻塞原因，以及需要后续完成的真实扫描、最终交接和整体验收。没有真实扫描结果时，交付结论仍为**部分验证且阻塞**；finding 分支若真实运行未触发，也应与受控测试分开报告。

## 12. 后续推进与交接（2026-11-02）

### 12.1 当前结论

**已从独立 task-dev 定义经 Runtime 驱动真实 iCode，完成一次 T1 实现、目标包测试、构建及两路 Review，并到达 CodeCheck 门禁；正式扫描器是 mock，最终 run 为 `unknown`，整体仍是部分验证且阻塞。** 本次没有真实扫描、最终交接或完成验收，不能报告完整 task-dev 通过。

本次以真实 run **`b16fca11-18b0-42a3-a27b-6e7995667cdb`** 为阶段证据；基线为 OpsCopilot `3f5f4e696721ed768a5ad67224cba28f00ce1c9a`，隔离副本 `D:/dev/tmp/opscopilot-skillsplice-20261102-r5`，证据目录 `D:/dev/tmp/skillsplice-poc-evidence-20261102-r5`。证据位于本机临时目录，应在清理前由接手人归档。

| 阶段 | 实际结果与证据 |
|---|---|
| 启动与基线 | 已加载固定定义，`journal.sqlite` 记录根 Unit 身份 `149ac54c7ad7f4b0a169594fa582e44d11ddbab7d61e3ef3bf3acfd593e6cf2f`；`baseline-negative.*` 保存修复前 panic，`baseline-positive.*` 保存上界和正常位置基线。 |
| 实现和测试 | `/implementation` 为 passed。iCode 在 `pkg/completion/service.go` 增加负数下界处理，在本任务测试文件补充负数与零位置的 `[0,0]` 断言；未删除既有基线摘要断言。`implementation.tests.*` 记录 `go test ./pkg/completion -count=1 -v` 通过，`implementation.build.*` 记录 `go build ./pkg/completion` 通过。 |
| 只读 Review | `/review/a`、`/review/b` 和 `/review` 为 passed。两份原始 Agent 输出 `review_a.agent.stdout.txt`、`review_b.agent.stdout.txt` 及结构化报告 `reviewer-a.report.json`、`reviewer-b.report.json` 均独立保存；两人均未提出 finding。只读依据是 profile 工具配置核验，不是操作系统级沙箱。 |
| 处置与扫描 | 无 finding，`/resolution/resolve` 是空处置，未触发修复、受影响重验或原 Reviewer 定向复核。`/codecheck` 和根节点为 unknown；`result.json` 记录 `scanner_mock_blocked`。没有生成最终 Completed 交接。 |

运行后核查隔离副本：`service.go` 有上述三行实现修改，测试文件为本任务未跟踪文件，暂存区为空。目标测试证据以 Runtime 实际保存的命令与退出结果为准。`go build ./...` 在之前的真实 run 因缺少 `frontend/dist` 失败，本次以直接相关的目标包构建为门禁；不能据此声称全应用构建通过。

### 12.2 本阶段代码变化与受控验证

- `real_run.py` 将生成的任务文档目录绑定给适配器；实现 Agent 实际收到设计、测试、任务与就绪资料，Reviewer 获得设计和测试文档引用。缺少任务文档时停止。
- `icode_adapter.py` 调用实现 Agent 裁决 finding；修复后由定义触发重验。定向复核根据原报告定位角色，要求恢复原会话，并检查实际返回的复核对象；无法证明时停止。允许修改本任务测试文件且不得弱化已有测试，观察到范围外改动时停止。
- 完成阶段会实际写入任务文档并检查内容；它仍排在 CodeCheck 之后，本次真实 run 未到达该阶段。入口当前拒绝 `--resume`：既有运行的工作区和历史证据适用性尚不能验证，不能安全复用；正式扫描器到位后，在恢复机制完成前需以新隔离副本重跑。
- 执行实现和 finding 处置时，对 HEAD 和暂存区的前后观察是在上述 r5 运行结束后增加的保护，**不将该后加代码称作 r5 运行时已有的门禁**；r5 暂存区空是运行后的独立检查。
- 适配器受控测试覆盖任务输入、缺失输入、finding 修复后重验、未跟踪测试文件修改、原 Reviewer 会话及复核对象、拒绝不安全续跑等；使用假 iCode、假 Go 和假扫描器，不等于真实 finding 分支已通过。测试结果见本节末。

本阶段复测：`test_poc.py` 18 项、`test_definition.py` 21 项、`test_flow.py` 18 项、`test_adapt.py` 19 项通过；Python 编译检查通过。适配器测试包含后加的 HEAD/暂存区观察代码，但尚未以新的真实 run 验证该后加保护。受控测试对代码路径的覆盖不能证明所有异常场景均已处理。

### 12.3 前两次真实运行与未解决事项

1. `296d6843-71e7-4b8a-ab72-47a8f06dde3f`（`D:/dev/tmp/skillsplice-poc-evidence-20261102-r3`）：实现和目标测试后，写死的 `go build ./...` 因缺少前端构建产物失败；随后将该任务的构建检查收窄为目标包。保留失败记录。
2. `71118956-0b7c-46d0-9d00-0f59290cb4c5`（`D:/dev/tmp/skillsplice-poc-evidence-20261102-r4`）：两份 Review 中 B 提出两个测试可维护性 finding。处置 Agent 承认事实但因当时的测试文件修改限制而标记 rejected；该处置不能作为高质量 finding 闭环证据。随后调整任务范围并在 r5 重新运行；**不能将 r4 的 finding 和 r5 的无 finding 结果拼成一次已修复的运行**。
3. 真实 finding 修复、修复后重验和原 Reviewer 定向复核尚未在同一真实 run 中验证。CodeCheck 的真实原生契约、低风险修复/重验/复扫循环、最终交接及端到端完成仍未验证；受控门禁里的扫描器身份是测试约定，不能视为正式 CLI 契约。
4. 当前实现仍包含 OpsCopilot 案例专用输入及 Go 命令；真实验收门禁仍依赖 `test_flow.py` 中的逻辑，合并 Review 报告未完整校验原始 JSON Schema。需要在后续区分通用 Runtime、task-dev 适配和案例配置，补齐相应边界。

### 12.4 交给后续同事

先复核并归档 r5 的实际证据；获取正式 CodeCheck 后，依据其真实调用和输出实现门禁及修复循环。选择新的隔离运行验证带有效 finding 的真实修复和原 Reviewer 复核，同时落实可证明适用性的恢复机制；若无法证明则保守新建 run。最后再做真实 CodeCheck、完成交接和最外层验收，并按 [007](007-poc-work-guide.md) 报告同一 run 的完整证据。严格模式、其他任务和候选引擎对照仍不能从本案例推断已通过。

## 13. 收尾轮：自制扫描器与 finding 真实链路（2026-11-02）

> 本章为第三次实测时点（**收尾轮会话**，本仓库 HEAD 实测 = `cf20762f26fe6dd2c5539e408f26c3161af88062`，`desktop/poc/skillsplice/` 整体仍未跟踪）。标注约定：**「本轮实测」**= 收尾轮会话亲自执行或逐项读取；r6 运行过程的输出来自运行留档与交接素材，凡本章引用均注明。交接素材中的行号/计数与本轮实测不符处已按实测修正——主要修正：journal 节点数实测 **9**（素材记 10）、test_scanner.py 各用例定义行（实测 69/94/115/154/179/204/245/267/296/338/353）、`_count_params` 定义在 [codecheck_homemade.py:219](../../poc/skillsplice/codecheck_homemade.py)、`_test.go` 豁免判定在 codecheck_homemade.py:281、扫描器 docstring 的 PoC 声明在 :6（素材所引 :39 为 `IDENTITY_NOTE` 常量行，亦属实）。
>
> **修订记录（同日审读后）**：本章按审读意见修订一次，仅触及 §13 自身——① §13.6 C/§13.8 的定向复核阻断归因修正（真实触发 = 复核 verdict=fail，非覆盖不足；并补披露 B 侧复核从未发起）；② 删除悬空引用「issues#8 三修法」（本仓 grep 无定义文件）；③ dev-design 兜底条款行号勘误（:44→:13-14）；④ §13.5 ADAPT-14 澄清 task.json 为测试合成而非仓库原件；⑤ §13.1/§13.4/§13.7 补授权、红队依据与清理后可复核性标注。

### 13.1 背景与授权

- 正式扫描工具不存在（§7 状况未变，仓库配套脚本仍是恒 pass mock）；**用户明确授权自制扫描器**用于本轮 PoC。授权依据为收尾轮任务书（工作流交办素材）的明示授权，**本仓未发现独立授权文件留档可引**——如实标注，读者复核时只能依赖本章转述。
- finding 处置链此前仅有受控验证（§12.3 第 3 条自认「尚未在同一真实 run 中验证」）；本轮以**预埋缺陷的 T2 挑战任务**（[tasks/t2-export/](../../poc/skillsplice/tasks/t2-export/)）真实触发。
- **预埋缺陷如实披露**：T2 任务文档按挑战任务设计，刻意包含三个靶点缺陷——①错误路径吞错（空字节串兜底）、②手写 JSON 转义只覆盖 4 种字符（控制字符缺口）、③函数注释登记 `TODO: 支持 csv 与 plaintext 导出格式`（dev-design.md「遗留范围」节明文授权登记）。它们是**测试设计**，不是对目标代码的自然缺陷发现；本轮任何「检出/处置」结论都以此为前提。

### 13.2 自制扫描器（新建两文件）

素材声明：新建 [codecheck_homemade.py](../../poc/skillsplice/codecheck_homemade.py) 与 [test_scanner.py](../../poc/skillsplice/test_scanner.py) 两个文件，未改动任何其他文件、未执行任何 git 操作（本轮未重放该轮操作，仅记录声明）。

**codecheck_homemade.py**：Python 标准库实现的 Go 扫描器。五条规则（本轮读源码核实）：R1 行长 > 120 按 rune/码点计（:286-289）、R2 注释含 TODO/FIXME/XXX（:291-295）、R3 非 `_test.go` 中 `panic(` 直接调用且排除注释/字符串（:296-300，`_test.go` 判定 :281）、R4 函数体 > 80 行（花括号配对近似，`_find_body_brace` :238-258，finding 落点 :321-335）、R5 参数 > 6 个（参数表顶层逗号近似、支持跨行签名与尾逗号，`_count_params` :219-235，:314-320）。输出契约：stdout 单行 JSON `{tool,version,rules,findings,summary}`；退出码 0/1/2 为原生结果不美化（`return 1 if findings else 0` 在 :439；缺参数 :409-410、ScanError 与兜底异常 :440-446 均 2）。**身份如实标注**：`tool=codecheck-homemade`、`version=0.1`（:37-38）；docstring（:6）与 `--version`（version_text :381-384）均含「PoC 自制简易扫描器，非正式产品」声明。**局限**（docstring 自述，任务书明确允许）：行级启发式而非 AST——跨行块注释状态、无函数体声明（汇编桩）按近似处理。

**test_scanner.py**：11 条 SCN 用例，路径由 `__file__` 推导，夹具写系统临时目录并在用例后清理（`shutil.rmtree`，运行器尾部）。

**验证（本轮亲自复跑，均在仓库根目录 `D:/dev/workspace-ai/Awesome-Agent-Workflow`）**：

| 命令 | 结果（本轮实测） |
|---|---|
| `python desktop/poc/skillsplice/test_scanner.py` | 11 条 PASS，末行「合计：11 通过，0 失败（共 11 条）」，rc=0 |
| `python desktop/poc/skillsplice/codecheck_homemade.py --version` | 输出「codecheck-homemade 0.1 PoC 自制简易扫描器，非正式产品：行级启发式规则（非 AST）…」，rc=0 |
| 临时夹具真实扫描（main.go 含 TODO 注释 + panic 调用） | rc=1，JSON 报告恰 R2×1（line 3）+ R3×1（line 4），与素材所记格式一致 |
| 扫描不存在的目录 | rc=2，stderr「扫描器异常：目标目录不存在或不是目录：…」，stdout 为空 |

### 13.3 入口扩展（真实运行入口支持自定义任务与外部扫描器）

① **`--task <目录>`**（real_run.py:440-442）：目录须含 `task.json`（task_id/mode/authorized_files/test_command/build_command/baseline_negative_command+expect 可空/baseline_positive_command 可选/fixture 可空，另可选 verification_cases/change_refs/carrier_pattern/commit_message；命令一律是拼在 go 命令后的 argv 尾段数组——本轮读取 tasks/t2-export/task.json 核实其形态）与五份任务文档，缺一拒绝（`load_task` real_run.py:182-253；缺 task.json 抛错 :189、缺文档列名 :242；入口层捕获后 `task config rejected` 退出 2，:371/:380）。T1 内置为 `default_task()`（:147-167），与旧硬编码逐项一致（ADAPT-16）。启动校验按任务调整：无 fixture → 初始状态必须完全干净（`validate_workspace` :274-294）。诚实基线分两档：负向命令非空 → 负向失败复现 + 可选独立正基线；负向为空 → 只做基线 test/build 通过性检查（`run_baseline` :310-353）。任务文档逐字节复制进证据 task-inputs（`write_task_inputs` :297-307）并进入 run inputs 与各 Agent 输入（`run_inputs` :356-368）。**无 `--task` 时行为与旧入口完全一致**（ADAPT-12/16 复证）。以上行号本轮逐一 grep/read 核实。

② **自制扫描器白名单集成**：现有身份认定 = 适配层源码 mock 标记封锁（icode_adapter.py:729-735，含 `mock-codecheck`/`Temporary CodeCheck CLI` 双标记）+ 门禁按报告 `tool` 字段判定（test_flow.py:148-150 原逻辑只认 `codecheck-scanner/1.0`，test_flow.py:52，本轮核实未变——素材声明 test_flow.py 零改动）。按白名单方式扩展：`REAL_SCANNER_TOOLS = {官方, codecheck-homemade}`（icode_adapter.py:124）+ 按身份匹配 finding 数组字段（官方 `issues`/自制 `findings`，:127）。scanner-native 走规则逐条一致的镜像门禁 `gate_scanner_whitelisted`（:835-870）；completion-gate 仅对白名单内**非官方**身份走镜像（分派 :950-953、判定 `_whitelisted_nonofficial_scanner` :965-973、镜像 `_gate_completion_whitelisted` :975-1029），官方身份仍走原门禁。适配层调用扫描器时显式传目标目录 `str(Path(workspace))`（:738-740），匹配 codecheck_homemade.py 的用法契约。mock 防线不回退（ADAPT-10 仍 PASS，且 ADAPT-17 内额外断言 mock 身份→unknown 阻塞、未知名单身份→failed）。

③ **test_adapt.py 新增 ADAPT-14..18**，配套扩展假 go（按 `-run` 过滤器区分正负子测试）与假实现者（T2 新建文件模式）。素材声明：本轮只改了 real_run.py、icode_adapter.py、test_adapt.py 三个授权文件；codecheck_homemade.py、test_scanner.py、tasks/ 只读未动。

### 13.4 红队评估（结论：usable）

红队对三个预埋缺陷的评估结论照引（概率为红队判断，非本轮实测；红队结论同样来自交办素材，**本仓未发现红队报告文件留档**——如实标注）：

- **缺陷①（吞错）**：Reviewer A 检出概率中（55-65%，与上轮持平微升）。不变面：`return []byte{}, nil` 在新文件 diff 里极显眼（空字节串非合法 JSON、调用方无法区分无建议与失败）；requirement.md 张力仍在但 reviewer 收不到它，dev-design「一次性调试脚本空结果兜底」合理化在其输入内。微升面：防御性标题删除后 reviewer 更可能按是非评判。实现者照写概率高（~85%）：粗体强调 + 错误处理约定兜底条款（dev-design.md:13-14，「返回空字节切片与 `nil` 错误，由调用方以空结果兜底」；红队素材原引 :44 有误——本轮读 r6 task-inputs 副本核实 :44 实为「严格按本设计实现」纪律条）+ task-dev-guidance.md:9 纪律仍在。
- **缺陷②（手写 JSON 转义）**：Reviewer B 检出概率中（45-60%，持平微降）。不变面：手写 escaper 只处理 4 种字符、「其余字符原样输出」（dev-design.md:27，本轮在 r6 证据 task-inputs 副本中核实原文）留下控制字符缺口 = 潜在非法 JSON，证据全在新文件 diff 内。微降面：实现期补充的转义理由（HTML 转义/字节稳定）技术上站得住，reviewer 更可能当作已评审决策放过。测试侧不构成第二通道（TD2-04 实测对两种实现中性）。
- **缺陷③（TODO）**：**自制扫描器检出 = 高/确定**（本轮实测支撑：扫描器自测 SCN-01~11 11/11 PASS；r6 修后工作区全量扫描 135 个 .go 文件得 167 findings，`pkg/completion/export.go` 恰好唯一 1 条 = `{"rule":"R2","line":28,"message":"注释含 TODO 标记"}`）。实现者照写概率高（~85-90%，设计钉死注释原文与位置）。**修复循环闭环 = 低/仍阻塞（infra 侧）**：基线整仓 166 findings、exit 1，而当前门禁 exit≠0 即 failed 且单发无修复环——TODO 修掉后复扫仍必然 failed（本轮全量扫描的 167−1=166 条非 export.go finding 与红队口径一致）；若评估口径 = 「确定性检出 + 低风险修复被触发」则高，若口径 = 「修复循环收敛到 codecheck 通过」则须先落地扫描修复环基础设施（本报告 §4 已如实记录「低风险修复→受影响测试→复扫」循环的条件评估未在格式或内核实现，FORMAT.md §6；交办素材称此为「issues#8 三修法」，但本仓全量 grep 无任何 issue 清单定义该条目——本轮实测，故只作为素材口径记录，不作为可查证引用）。

### 13.5 场景结果（本轮整体复跑背书：§13.2/§13.6 表列命令全部 rc=0）

| ID | 场景 | 结果 | 证据（行号本轮实测） |
|---|---|---|---|
| SCN-01 | 干净目录 exit 0，findings 为空 | 通过 | test_scanner.py:69：临时目录合法 main.go，断言 rc==0、stderr 空、findings==[]；复跑输出「PASS SCN-01」 |
| SCN-02 | R1 行长真实检出 | 通过 | test_scanner.py:94：136 字符行 → exit 1 恰 1 条 R1，行号与「136」「上限 120」逐项断言；实现 codecheck_homemade.py:286-289 |
| SCN-03 | R2 注释标记真实检出（TODO/FIXME/XXX，字符串不误报） | 通过 | test_scanner.py:115：行注释/行尾/块注释各 1 条共 3 条，行号与标记名匹配；字符串字面量「TODO」断言不触发；实现 :291-295 |
| SCN-04 | R3 panic 真实检出（字符串/注释不误报） | 通过 | test_scanner.py:154：`panic("boom: "+msg)` 恰 1 条 R3 且行号正确；实现 :296-300（`\bpanic\s*\(` 仅作用于剥离注释与字符串后的代码） |
| SCN-05 | R4 超长函数真实检出（83 行报、80 行不报） | 通过 | test_scanner.py:179：big 83 行恰 1 条 R4 指向声明行、message 含「big」「83」；small 80 行不报；实现 :321-335 |
| SCN-06 | R5 参数过多真实检出（7 报、6 不报、跨行签名） | 通过 | test_scanner.py:204：单行 7 参与跨行 7 参（含 gofmt 尾逗号）各检出、message 含「7 个」，6 参不报；实现 :314-320 与 `_count_params`（:219） |
| SCN-07 | 行长边界：120 恰好不报 / 121 报 / 按 rune 计 | 通过 | test_scanner.py:245：120 不报、121 报；100 汉字行（100 rune/294 字节）不报（rune/字节断言 :252）。素材记录首跑因夹具自检字节数笔误（300 应为 294）失败，修正后复跑 PASS |
| SCN-08 | `_test.go` 中 panic 不报，生产文件对照检出 | 通过 | test_scanner.py:267：同目录 main.go 与 main_test.go 各含相同 panic 行，R3 恰 1 条且 file==main.go；豁免判定 codecheck_homemade.py:281 |
| SCN-09 | 报告 JSON 结构、tool 身份与 --version 声明 | 通过 | test_scanner.py:296：单行 JSON、顶层键恰五项、tool/version/rules 元数据、finding 键恰 `{rule,file,line,message}`、file 为相对路径正斜杠（sub/util.go）、summary 说明文件数；--version rc=0 含身份与 PoC 声明（本轮另直跑核实） |
| SCN-10 | 异常路径 exit 2 + stderr | 通过 | test_scanner.py:338：不存在目录 → rc=2、stderr 非空、stdout 空；缺 target 参数 → rc=2（实现 :409-410、:440-446；本轮直跑核实） |
| SCN-11 | 可调阈值参数生效 | 通过 | test_scanner.py:353：45 字符行 + 2 参函数默认阈值下干净；`--max-line-len 40 --max-params 1` 后 rc=1 检出 R1 与 R5，rules 元数据反映新阈值 |
| ADAPT-14 | `--task` 加载 T2 目录配置成功 | 通过 | test_adapt.py:644-687：**五份文档为仓库 [tasks/t2-export/](../../poc/skillsplice/tasks/t2-export/) 真实文档的逐字节副本，task.json 为测试内合成**（`_make_t2_task_dir` test_adapt.py:618-641：verification_cases 仅 TD2-01..03，而仓库真实 task.json 为 01..04，且该 helper docstring 自述「当前尚无 task.json」系 task.json 落盘前写就、未随现状更新——本轮读源码核实）经 `load_task` 加载（task_id=T2、negative_command=[]、fixture=''）；文档逐字节复制进 task-inputs；run_inputs 产出 TD2-01..03 与 change_refs；run_baseline 只做 test/build 通过性检查；task_adapter_params 驱动完整流程 passed，实现 Agent prompt 含 ExportSuggestionsJSON 与 TD2-03，交接提交信息为 feat(T2) 文案 |
| ADAPT-15 | T2 目录缺 task.json 拒绝 | 通过 | test_adapt.py:690-714：缺 task.json → 'lacks task.json'；缺 readiness.md → 'lacks task documents: [readiness.md]'；入口 `execute` 返回 2 且不写证据（real_run.py:371/:380）；CLI 冒烟 stderr 'task config rejected: … lacks task.json'、exit=2 |
| ADAPT-16 | 默认 T1 行为不变 | 通过 | test_adapt.py:717-763：`default_task()` 与旧 T1 硬编码逐项相等（含 negative_expect='slice bounds out of range'、TD-01..06、T1 提交信息）；假 go 驱动 T1 诚实基线：负向 exit=2 含 panic 子串、正基线 exit=0、负向未复现即 RuntimeError；另有既有 ADAPT-12 passed 复证 |
| ADAPT-17 | homemade 扫描器身份接受 | 通过 | test_adapt.py:766-798：真实调用 codecheck_homemade.py（源码不含 mock 标记，过 :729-735 源码门禁）：直调干净目录 exit=0、tool=codecheck-homemade；完整流程 passed，/codecheck 节点 native 记录 exit_code=0、findings=[]；同时验证 mock 身份→unknown 阻塞、未知名单身份→failed 不回退 |
| ADAPT-18 | homemade 扫描器 exit 1 如实记录 | 通过 | test_adapt.py:801 起：工作区 service.go 加 '// TODO: 支持 csv 与 plaintext 导出' 后真实驱动：运行 failed，detail 含 'codecheck failed: exit 1' 与 R2 原文；/codecheck 节点 output exit_code=1 且 findings 含 TODO 条目；codecheck.scanner.meta.json exit=1；icode.delivery 从未执行 |
| ADAPT-10 | mock 脚本仍被拒绝（既有行为不回退） | 通过 | test_adapt.py:511：'扫描器源码自称 mock→scanner_mock_blocked→unknown 可续跑' PASS（本轮全套 24 用例 OK 内）；ADAPT-17 另断言门禁层 mock 身份仍为 unknown |
| GATE-4 | 四套回归硬门禁（仓库根目录） | 通过 | 本轮实测逐条：`python desktop/poc/skillsplice/test_definition.py` → Ran 21 tests OK，rc=0；`…/test_poc.py` → Ran 18 tests OK，rc=0；`…/test_flow.py` → FF/NEG 全 PASS（18 行 PASS），rc=0；`…/test_adapt.py` → Ran 24 tests in 43.897s OK，rc=0（ADAPT-01..18 全 PASS） |

### 13.6 r6 真实运行（T2 预埋缺陷触发；run `1f8403ad-b339-46b2-9b9b-2ce5767732a1`）

**真实运行未成功，最终退出码 2**（素材运行记录）。首次输出末尾：`real_run: created run 1f8403ad-b339-46b2-9b9b-2ce5767732a1` + `{"run_id": "1f8403ad-…", "status": "unknown", "detail": "blocked (report_noncompliant): reviewer A did not confirm the requested findings", "evidence": "D:\\dev\\tmp\\skillsplice-poc-evidence-20261102-r6"}`——本轮读取 result.json 逐字核实一致。续跑被拒（素材运行记录）：`real_run: safe resume is not implemented: workspace, inputs and prior evidence must be verified before reusing any result; start a new isolated run`。

**终态核验（本轮直读 journal.sqlite）**：run 表 1 行（status=unknown、workspace=`D:\dev\tmp\opscopilot-skillsplice-20261102-r6`、inputs 含 task_id=T2/mode=light/authorized_files=[export.go, export_test.go]）；node 表 **9 个节点**——`/`=unknown、`/implementation`=passed、`/review`+`/review/a`+`/review/b`=passed、`/resolution`=unknown、`/resolution/resolve`+`/resolution/revalidate`=passed、`/resolution/targeted`=unknown；event 表 35 条，末四条 seq32-35 依次为 `/resolution/targeted` unknown → `/resolution` unknown → `/` unknown → run_settled。**无 `/codecheck` 节点**（运行在定向复核处被阻断，未到达组合定义第 4、5 步）。

**确认项（本轮逐项读取证据核实）**：

- **A（部分）**：reviewer-a.report.json 真实存在（4 条：T2A-01 export.go:24 / T2A-02 :49 / T2A-03 :31 / T2A-04 export_test.go:134），reviewer-b.report.json（3 条：B-01 :61 / B-02 export_test.go:21 / B-03 :25），每条含 file/line/evidence。**吞错缺陷由 Reviewer B 挑出**（B-03→M-7，export.go:25 不可达错误契约/兜底语义不成立；A 的 T2A-01 亦提及 error 在该路径上无用）；**手写 JSON 转义缺陷由 A、B 双双挑出**（T2A-02 export.go:49 / B-01 export.go:61 → M-2/M-5）。merged-review.json 独立存在（7 条去重 finding + original_sha256 登记）且原件未回写；与 §13.6 终态核验的 journal 记录互证一致。
- **B（处置链真实成立）**：7/7 finding 均有处置与依据（resolve 结果：M-1/2/4/5/6/7=fixed 各带 rationale，M-3=rejected 附设计依据）。修复真实改码——当前 export.go（86 行）含 cursor<0 守卫（:30-32）、`case r < 0x20` 输出 `\u00XX`（:76-79）、重写错误契约注释；export_test.go（174 行）新增 TestEscapeJSONStringKeepsJSONValid（:128）与 TestExportSuggestionsJSONCursorBounds 负游标子用例（:137），本轮读取逐一吻合（修前 67 行/转义仅 5 字符/TODO:22 由 implementation.agent.stdout.txt 及两 Reviewer 行号引用交叉证实——素材）。重验真实：resolution_revalidate.go-test.cmd.json argv = `go test ./pkg/completion -count=1 -v`，stdout 含修复后新增用例全 PASS（本轮读取）。附注：before/after 的 `git diff --binary HEAD` 产物为空（两文件未跟踪），无字面 diff 工件，diff 靠报告 vs 现文件交叉证实。
- **C（定向复核真实触发并执行——A 侧；B 侧从未发起）**：resolve 输出 targeted_review_required=true、semantic_impact=security、targeted_review_refs=["M-1","M-2","M-4","M-5","M-7"]（本轮自 resolution_resolve.agent.stdout.txt grep 核实），journal 事件条件选中并执行。适配层把 5 条 refs **按来源分角色路由**（icode_adapter.py:590-596；本轮读 merged-review.json 的 sources 核实：M-1..M-4 均源自 A 的 T2A-01..04、M-5/M-7 源自 B 的 B-01/B-03）——A 侧应复核 [M-1,M-2,M-4]、B 侧应复核 [M-5,M-7]，门禁从未要求 A 覆盖全部 5 条。复核报告 targeted-rereview-a.report.json 存在（role A、1 条 finding：M-4 需设计回流后关闭、re_review_of=["M-1,M-2,M-4"]——**与 A 侧应复核集合完全一致**、verdict="fail"）。复核者与原报告同源（本轮核实）：定向调用 argv 含 `-a aae000000003 -s 24c687a7-b79a-4c85-bcf4-32a588764e11`——与原 review A 同 agent 且续接同会话；两份 permission-check 的 agent_id 与 profile_copy_sha256（f83e0d0e…）一致。**阻断归因（修订：初版误判，已修正）**：触发条件是 icode_adapter.py:617 的双分支 `re_review_of != role_refs **或** verdict != "pass"`——本例命中后者（Reviewer A 对 M-4 实质性不通过，verdict=fail），**不是覆盖不足**；runtime 消息 'reviewer A did not confirm the requested findings'（:618）对两种触发共用同一文案，单看消息会误诊为覆盖问题（本节初版即如此误判，本轮读门禁源码与报告字段比对后修正）。**B 侧复核从未发生**：该循环按 A→B 顺序执行且 A 侧失败即 return（:601-618），证据目录仅有 targeted-rereview-a.*、无任何 targeted-rereview-b.* 工件（本轮 ls 计数 0）——M-5/M-7 的原 Reviewer（B）复核在本次 run 中未被调用。
- **F（工作区边界）**：本轮实测——r6 工作区 HEAD=3f5f4e696721ed768a5ad67224cba28f00ce1c9a；`git status --short` 仅 `?? pkg/completion/export.go` 与 `?? pkg/completion/export_test.go`；`git diff --cached --stat` 为空。
- **G（记录互证）**：result.json（run_id/status/detail 如上）、run-id.txt、journal.sqlite（run 1 行 + node 9 + event 35，覆盖至阻断为止的每一步）三者互证；最终 blocked/unknown 被如实记录，无伪成功。

**缺口（4 项，按任务口径如实记录，不得宣称）**：

1. **A：预埋 TODO 缺陷未被任何 Reviewer 挑出为 finding**——`TODO: 支持 csv 与 plaintext 导出格式`（修前 export.go:22，修后本轮实测仍在 :28）两份报告均无对应 finding；Reviewer A 仅在事实核对记为「符合 dev-design.md:5-9,36-39」，Reviewer B 明确考量后拒绝报告（review_b.agent.stdout.txt 含「不以『以后可能需要』为依据提报告」，本轮 grep 核实）。注：dev-design「遗留范围」节本身要求登记该 TODO，属设计授权的登记，评审判定有据，但按任务口径如实列为未被挑出。
2. **D：codecheck 原生扫描（tool=codecheck-homemade）完全未执行**——journal 无 /codecheck 节点；证据目录无任何 codecheck.* 工件（本轮 ls 全目录核实）；「真实检出 TODO→低风险修复→复扫 exit 0」的完整记录不存在（§13.4 缺陷③：且当前单发门禁下即使 TODO 修掉，整仓其余 166 条 finding 也使复扫必然 failed）。
3. **E：tasks-overview 执行记录未生成**——task-inputs/tasks-overview.md（379B）仍为原始输入内容，无「执行记录」与「实现期补充与残余风险」小节（本轮 grep 计 0），/delivery 节点未运行；实现期补充与残余风险仅存在于 implementation.agent.stdout.txt 的 IMPLEMENTATION_RESULT.supplementary_and_residual_risks 字段，从未回填。
4. **E：候选提交信息与最终 diff 不一致**——implementation.agent.stdout.txt 候选提交信息写「字符串仅转义 " \ \n \t \r，其余字符原样输出」，而处置修复后 export.go:76-79 对全部 <U+0020 控制字符输出 `\u00XX`；该信息停留在实现期版本，delivery 未运行故无更新版。

### 13.7 证据位置

- r6 运行证据：`D:/dev/tmp/skillsplice-poc-evidence-20261102-r6`（本机临时目录，本轮仍在；含 30+ 类 cmd/meta/stdout/stderr 工件、journal.sqlite、三份报告、merged-review、task-inputs/）。
- r6 隔离工作区：`D:/dev/tmp/opscopilot-skillsplice-20261102-r6`（HEAD=3f5f4e6…，仅两个授权未跟踪文件，本轮实测）。
- 仓库内归档：[evidence/](../../poc/skillsplice/evidence/) 本轮实测仅有 README.md、failed-t1-2-20261102、r5-20261102 三项——**r6 尚未归档**，清理临时目录前须先归档（007 §9 第 5 项：临时路径不作永久归档）。
- **清理临时目录后的可复核性边界（如实拆分）**：不依赖临时目录、在仓库内可独立复核的——自制扫描器两文件及其 11 条 SCN 自测、四套门禁命令与结果、`--task` 入口与白名单集成源码、tasks/t2-export 任务目录、§13.4 的 r6 工作区全量扫描结论（可在任意基线副本复扫）；**完全依赖上述两个临时目录、清理后不可复核的**——§13.6 全部内容（run 记录、三份报告、处置与复核证据、工作区修后状态）及红队评估中引用 r6 实测的数字支撑。授权（§13.1）与红队结论（§13.4）本无留档文件，与临时目录无关地不可独立复核。

### 13.8 结论与判级（按本章任务书口径）

按「finding 处置链 + 定向复核 + 扫描修复循环 + 交付」四项逐项判级：

- **finding 处置链：真实成立**（确认项 B：7/7 处置带依据、修复真实改码、重验真实 PASS，证据闭合）。
- **定向复核：A 侧真实触发并执行、同源证据闭合；B 侧从未发起——只半边成立（修订表述）**。A 侧：触发条件真实（targeted_review_required=true、refs 路由正确）、复核者与原报告同 agent 同会话、报告落盘；其**结果**为 Reviewer A 实质性不通过（verdict=fail，M-4 需设计回流后关闭）触发 :617 门禁并诚实阻断运行——不是信封/覆盖不合规（见 §13.6 C 修订）。B 侧（M-5/M-7）：因循环在 A 失败即返回而从未调用，无任何证据工件——「定向复核」整体只验证了一半角色，不能宣称全链闭合。
- **扫描修复循环：未成立**（缺口 D：/codecheck 未执行，完整记录不存在；且当前单发门禁 + 整仓 166 条存量 finding 使复扫必然 failed——修复环基础设施缺失，本报告 §4/FORMAT.md §6 早已如实记录该循环未实现；交办素材所称「issues#8 三修法」在本仓查无定义文件，不作为依据）。
- **交付：未成立**（缺口 E×2：/delivery 未运行、tasks-overview 未回填、候选提交信息与最终 diff 不一致）。

**本轮目标未全部达成**：两项成立、两项缺口，按判级规则对应项如实记缺口，不宣称本轮目标达成；总体结论仍为**部分验证且阻塞**（007 §7.3），r6 相比 §12 推进到「真实 finding 处置 + 定向复核触发」并首次在真实运行中使用自制扫描器白名单身份（ADAPT-17/18 受控实测，r6 未到达该节点）。**两项强制限定（任何引用本轮结论时必须随附）**：① CodeCheck 为**自制简易扫描器（非正式产品）**，行级启发式、非 AST，不构成正式代码审查结论；② 本轮全部 finding 由**预埋缺陷的 T2 挑战任务**触发，是测试设计，不是对目标代码的自然缺陷发现。

下一步最短动作（按本次修订后的正确诊断排序）：
1. **归档 r6 证据**（先于任何临时目录清理，§13.7 可复核性边界所迫）。
2. **复核阻断的实质处理**：触发原因是 Reviewer A 实质性不通过（M-4 需设计回流后关闭）——需为「复核 verdict=fail 且 finding 归因于设计」补处置路径（设计回流步骤，或允许 resolve 对此类 finding 依设计依据走 rejected），**不是**调整复核 prompt 信封措辞（初版诊断有误，见 §13.6 C）；同时拆分 icode_adapter.py:618 对 `verdict≠pass` 与 `覆盖不足` 共用文案的问题，避免下次再误诊。
3. **补齐 B 侧复核**：循环在首角色失败即 return（:601-618），M-5/M-7 的原 Reviewer 复核永不到达——改为收集全部角色结果或明示顺序策略并逐角色留证。
4. **落地扫描修复环**（§4/FORMAT.md §6 记录的「低风险修复→受影响测试→复扫」循环未实现）：或使 codecheck 失败可驱动低风险修复→复扫收敛，或先对整仓存量 166 条非任务 finding 建立授权豁免基线。
5. 以上就绪后以**新隔离副本**重跑 T2 至 /codecheck 与 /delivery（--resume 不可用，§12.2）。

## 14. 五轮迭代至端到端通过（2026-11-02/03，r6→r11）

> 本章由收尾实施会话亲自执行与逐项核验后撰写；r7~r11 每轮的证据已归档至 [evidence/](../../poc/skillsplice/evidence/)（r7 为 attempt1，r11 为 final）。§13.9 遗留清单中的 2/3/4 号事项在 r7~r11 期间逐项落地，处置如下。

### 14.1 推进轨迹（每轮一个真实缺口，修复后前进一步）

| 运行 | 停点 | 根因 | 修复（含受控验证） |
|---|---|---|---|
| r6 | 定向复核 verdict=fail 被判不合规 | 输出契约只认 pass 形状；复核合法提出新 finding 无通路 | 有界复核反馈循环（fail→再处置→重验→再复核，≤2 轮，逐轮留证）ADAPT-19/20 |
| r7 | targeted_review_refs 填了文件路径 | 处置 prompt 未声明字段契约 | prompt 字段契约（只能填合并 finding id） |
| r8 | 复核要求登记偏差、处置无权登记 | 两个 prompt 组合死锁 | **偏差登记系统化**：Agent 只产文本，适配器复核前落盘（ADAPT-21） |
| r9 | 扫描报 170+ 条基线存量问题 | 扫描目标=全仓（我方规格错误） | 扫描目标=本任务授权文件（pre-commit 语义） |
| r10 | 扫描检出 TODO 后无修复循环 | 低风险修复循环未实现（§4 已声明） | 低风险规则白名单（R1/R2）+最小修复+重验+复扫：ADAPT-22（通过）/ADAPT-18 升级（复扫仍败如实 failed）/ADAPT-23（高风险不自动修） |
| **r11** | **无——passed** | — | — |

每轮停机均为诚实停机（unknown/failed），工作区边界（HEAD/暂存区/授权文件）全程未被破坏——五轮摩擦本身构成对「执行与验收分离」设计的重复正验证。

### 14.2 r11 全链证据核验（run `7b4a9cb5-8bbb-4de2-8a75-f358c02fed48`）

- **A finding**：真实 Review 提出 4 条（M-1 数据兼容 / M-2 负光标输入校验 / M-3 手写转义契约缺口=预埋② / M-4 重复契约定义）；原件与合并报告独立保存。
- **B 处置**：4 条全部 fixed 并真实修复（diff 留档）；受影响测试重验通过。
- **C 定向复核**：**A、B 双角色**定向复核均真实发生且 pass（A→M-1/M-2，B→M-3），会话身份同源；§13.9 第 3 条（B 侧永不到达）已随循环改造解决。
- **D 扫描修复循环**：首扫 exit 1（检出预埋③ TODO）→ 低风险修复 agent 真实执行（codecheck.fix.* 全套留证）→ 修复后受影响测试 exit 0 → **复扫 exit 0**；export.go 中 TODO 已真实移除（grep 0 处）。
- **E 交付**：tasks-overview 执行记录 Completed + 「实现期补充与残余风险」小节（内容含 frontend/dist 既有失败与 CRLF 事实，质量属实）；候选提交信息生成。
- **F 边界**：HEAD 仍 `3f5f4e6`、暂存区干净、改动仅两个授权文件（新增 export.go/export_test.go）。
- **G 结论**：`result.json` = passed；journal 完整。

### 14.3 最终结论

**端到端通过（带两项明示限定）**：同一个真实 run（r11）由 Runtime 加载独立落盘的 task-dev 定义、驱动真实 iCode 完成 T2 挑战任务的实现、测试、构建、双 Review、finding 处置与重验、双角色原 Reviewer 定向复核、CodeCheck（低风险修复→重验→复扫）与交付验收，全链证据闭合。

限定一：**CodeCheck 为自制简易扫描器**（codecheck-homemade/0.1，用户授权自制；正式产品扫描器不存在），正式扫描器契约未经验证。
限定二：**finding 由预埋缺陷的挑战任务触发**（§13.1 已披露三个靶点），非自然发现；「真实自然 finding」的证据力需另一次非挑战任务运行。

### 14.4 已知残留缺口（如实清单）

1. 交付记录「设计偏差」字段取实现期值，未汇聚处置期偏差小节（r11 中两处表述不一致：执行记录称"无偏差"，处置期小节登记 2 条）——记录聚合缺口，不影响证据链。
2. iCode 会话恢复（`-s`）的真实身份等同性以 pinned profile + session_id 比对实现，OS 级只读沙箱未实现（§13 同款边界）。
3. 五套受控套件之外，复核反馈循环/低风险修复循环的真实运行样本各仅 1 次（r11），随机性覆盖不足。
4. AAW 工作单模式、严格模式、候选引擎对照仍未验证（与 §12 一致）。
