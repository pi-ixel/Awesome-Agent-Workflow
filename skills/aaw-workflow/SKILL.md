---
name: aaw-workflow
version: "2.3.2.2"
description: 配置驱动的 AAW 工作流 CLI 入口技能。读取 aaw CLI 返回的自描述工作单，按工作单调用子技能、执行 prompt、检查交付件并推进流程。
---

# AAW 工作流

本 skill 只负责驱动 CLI 工作单，不包含具体业务节点知识。节点、入口、后继关系、变量映射、prompt、子 skill 调用和数据 schema 均由 CLI 读取配置后返回。

CLI 统一通过 `uv run` 调用（uv 按机器自身配置自动解析 Python 与依赖）；环境中没有 `uv` 时可退回 `python <skill-dir>/scripts/aaw.py ...`，此时需自行保证已安装 `typer` 与 `pyyaml`。

## 版本更新

每次会话开始、执行任何其他命令之前，先显式更新 skills：

```bash
uv run <skill-dir>/scripts/aaw.py update --json
```

按返回的 `status` 处理：

- `up_to_date`：已是最新，继续后续流程。
- `updated`：skills 已被替换为新版本（包括本 SKILL 文件）。重新读取本 SKILL 文件，按新版内容继续。
- `failed`（退出码 1，常见于网络不可达）：向用户提示更新失败原因，继续以当前版本执行。
- `recovery_required`（退出码 2）：安装可能不一致，停止执行，向用户转述错误信息与恢复指引。

即使跳过了这一步，`status` 命令也会自动检查并应用更新作为兜底；但显式执行 `update` 是首选路径，能让用户明确看到版本变化。

## 入口意图判定

当用户通过本 skill 但没有给出明确指令（例如空输入、只说“使用 aaw-workflow”、只贴需求但没说明继续还是新建）时，不要因为仓库中存在进行中的 workflow 就自动继续执行。

先执行：

```bash
uv run <skill-dir>/scripts/aaw.py status --json
```

然后按以下规则处理：

1. 如果用户明确说“继续 / 恢复 / 查看进度 / 处理 SR-XXX”，进入恢复流程。
2. 如果用户明确说“新建 / 启动 / 从 SR 入口 / 从 AR 入口”，进入启动流程。
3. 如果用户明确说“回退 / 返工 / 重做 / 重新执行某个阶段”，先定位目标 SR 和 step，再执行不带 `--artifacts` 的 `rollback --json` 获取回退预览；向用户展示 CLI 返回的两种成果物策略，等待用户明确选择后执行所选 `command_argv`。预览阶段不得修改 workflow 或文件。
4. 如果用户意图不明确且已有 workflow，列出已有 SR，并询问用户是继续已有 workflow，还是新开 SR/AR workflow；等待用户选择，不要执行 `next`。
5. 如果用户意图不明确且没有已有 workflow，询问用户选择 SR 入口还是 AR 入口，并收集启动所需变量。
6. 如果用户要继续但没有指定 SR，且存在多个 workflow，列出候选 SR 并让用户选择。

启动新 workflow 前必须确认新的 `SR`；不要复用已有 `.sdd/<SR>/workflow.yaml`，除非用户明确表示要继续该 SR。

## 恢复上下文

当用户明确要继续某个 workflow，或已在入口意图判定中选择继续后，执行：

```bash
uv run <skill-dir>/scripts/aaw.py status --json
uv run <skill-dir>/scripts/aaw.py next --sr SR-XXX --json
```

`next --json` 返回的 `ready` 就是当前可执行工作单。不要依赖记忆判断下一步，始终以 CLI 返回为准。

## 启动流程

使用入口启动一条工作流：

```bash
uv run <skill-dir>/scripts/aaw.py start --entry sr --sr SR-XXX --requirement-file <需求文件> --json
uv run <skill-dir>/scripts/aaw.py start --entry ar --sr SR-XXX --ar AR-XXX --title "AR描述" --json
```

SR 入口必须提供 `--requirement-file`（原始需求文件），CLI 会将其原样保存为
`.sdd/{SR}/original-requirement.md`，作为 `sr-design` 和 `sr-design-gate` 的正式输入。
启动前按以下方式准备需求文件：

1. 提取用户明确作为原始需求提供的文本，保持原文，不总结、不改写、不做设计性加工；
   需求分布在多个段落时按原顺序完整保存。普通讨论、Agent 的解释和设计推导不得混入。
2. 将原文写入一个临时 Markdown 文件，用它调用 `start`。
3. 无法判断用户是否已提供原始需求时，先向用户收集需求，不得以空内容或臆造内容启动。
4. `start` 成功后，向用户回显已保存的 `original-requirement.md` 内容（较长时回显开头
   若干行并注明总行数），请用户确认与其提供的需求一致。用户指出不一致时，停止推进，
   不要执行 `next`；让用户提供或确认正确原文后，修正当前 workflow 的
   `.sdd/{SR}/original-requirement.md`，重新回显核对，再继续当前 workflow。不要重新执行
   `start`，因为该 SR 的 `workflow.yaml` 已经存在。

AR 入口要求当前仓库已经执行过 `repo-init`，并且存在 `.sdd/software_architecture.md`。如果该文件缺失，`next --json` 会在工作单的 `inputs` 中标记 blocked，且 `done` 会失败。

也可以使用通用变量形式：

```bash
uv run <skill-dir>/scripts/aaw.py start --entry ar --var SR=SR-XXX --var AR=AR-XXX --var TITLE="AR描述" --json
```

## 工作单字段

每个 `ready` 工作单包含：

- `id` / `type` / `name`：步骤标识。
- `execution`：执行方式，常见值为 `skill`、`prompt`、`manual`、`noop`。
- `skill`：需要加载的子技能列表。
- `prompt`：需要按自然语言或结构化步骤执行的指令。
- `data` / `data_prompt`：完成 step 时需要构造的 `--data` 结构说明。
- `data_file`：需要 `--data-file` 时的建议 JSON 文件路径；文件位于 `.sdd/<SR>/.aaw/data/`。
- `input` / `output`：输入和交付件列表；路径项会带 `exists`。
- `inputs`：required 输入检查结果；若 `blocked=true` 或 `missing_required` 非空，不要执行该工作单，也不要执行 `done`。
- `deliverables`：强制交付件检查结果；它只用于说明已有成果和执行 `done` 前的交付校验，不能决定是否跳过当前 step。`commands.done` 会校验 required output，缺失时 CLI 会拒绝推进。
- `user_confirm`：当前工作单完成后，流转到下游时的用户确认策略；`skip` 表示直接放行，`ask` 表示默认询问用户，`must` 表示必须用户确认。
- `commands.done`：完成当前 step 的可执行命令模板；若需要数据，默认使用 `--data-file <JSON_FILE>`。
- `commands.done_argv`：同一命令的参数数组形式，便于工具调用。
- `commands.done_inline`：使用 `--data '<JSON>'` 的备用命令；仅在确认当前 shell 引号行为可靠时使用。

当 `next --json` 返回 `status=awaiting_user_confirm` 时，说明上一工作单已经完成，但下游尚未放行。此时不要执行任何子 skill，也不要尝试重复 `done`；应向用户说明待放行的来源 step 和下游 step，用户确认后执行返回的 `commands.user_confirm`。

## 执行循环

每一步都按以下协议执行：

1. 执行 `next --sr SR-XXX --json`。
2. 若 `done=true`，流程结束。
3. 若 `status=awaiting_user_confirm`，向用户确认是否放行到 `pending_user_confirm.planned_next`；用户确认后执行 `commands.user_confirm`，然后回到第 1 步。
4. 若有多个 `ready`，向用户列出 `id/name/type/input/output` 并让用户选择。
5. 若 `inputs.blocked=true`，先补齐 `inputs.missing_required` 中列出的 required 输入；缺失时不要执行子 skill，也不要执行 `commands.done`。
6. 无论交付件是否存在，只要当前 step 位于 `ready` 中，就必须执行。若 `output` 中存在 `exists=true` 的路径，先完整读取并评估已有成果，把它作为本轮修改基线；可按当前要求局部修改或整体重写，但必须写回原路径，不得仅因文件存在而跳过子 skill 或直接执行 `done`。已有成果中仍然有效的信息和已确认答案应复用，只询问当前无法确定的信息。
7. 按 `execution` 执行：
   - `skill`：加载并完整执行 `skill` 中列出的子技能；若同时存在 `prompt` 或 `data_prompt`，在子技能完成后继续按其说明收集数据。
   - `prompt`：按 `prompt` 执行。
   - `manual`：等待用户或外部动作完成。
   - `noop`：无需额外执行，按工作单继续推进。
8. 对照 `deliverables.required` 检查强制交付件；缺失时不要执行 done。
9. 若 `data` 不为空，根据 `data.fields` 和 `data_prompt` 构造 JSON，写入 `data_file.path`，然后执行 `commands.done`。
10. 执行 `commands.done`。若返回 `state=awaiting_user_confirm`，向用户确认后执行 `commands.user_confirm`；否则回到第 1 步。

### 门禁节点

`module-design-gate` 是准入门禁，不是普通直通节点。执行 gate skill 后必须先生成工作单 `output` 指定的门禁结果文件。

- 若门禁结论为 `通过`，向 CLI 提交 `{"gate_result":"pass", ...}`，`done` 成功后进入 `task-split`。
- 若门禁结论为 `不通过` 或 `阻塞`，不要推进到 `task-split`；可提交 `gate_result=fail/blocked` 获取 CLI 拒绝提示，但 step 会保持未完成。
- 不通过/阻塞时默认原地修正 ASIS/TOBE/测试设计成果物，然后重新执行 gate。不要自动 rollback；只有用户明确要求重走上游节点时，才获取 rollback 预览并让用户选择保留成果物返工或删除成果物重做。

## 回退

用户要求回退时，先执行：

```bash
uv run <skill-dir>/scripts/aaw.py rollback --sr SR-XXX <id> --json
```

无 `--artifacts` 的命令只返回预览，不修改 workflow 或文件。向用户展示 `target_step`、`invalidated_step_ids`、`managed_artifacts` 和 `choices`，明确询问：

- `preserve`：保留目标及下游登记成果；重新执行时读取并修改原文件。
- `discard`：删除目标及下游由 CLI 登记的普通成果文件；重新执行时从有效上游输入创建。

用户选择后，直接执行对应 choice 的 `command_argv`，不要自行拼接、替换或推测策略。CLI 只能处理 `managed_artifacts` 中列出的成果；未登记的代码、目录或其他文件不在自动删除范围内。

## 命令速查

```bash
# 更新（每次会话开始先执行）
uv run <skill-dir>/scripts/aaw.py update --json

# 启动
uv run <skill-dir>/scripts/aaw.py start --entry sr --sr SR-XXX --requirement-file <需求文件> --json
uv run <skill-dir>/scripts/aaw.py start --entry ar --sr SR-XXX --ar AR-XXX --title "AR描述" --json

# 查看
uv run <skill-dir>/scripts/aaw.py status --json
uv run <skill-dir>/scripts/aaw.py status --sr SR-XXX --json
uv run <skill-dir>/scripts/aaw.py next --sr SR-XXX --json

# 推进
uv run <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json
uv run <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --data-file data.json --json
uv run <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --data '<JSON>' --json  # 备用
uv run <skill-dir>/scripts/aaw.py user-confirm --sr SR-XXX --json

# 回退预览（不修改状态或文件）
uv run <skill-dir>/scripts/aaw.py rollback --sr SR-XXX <id> --json

# 用户明确选择后执行返回的 command_argv
uv run <skill-dir>/scripts/aaw.py rollback --sr SR-XXX <id> --artifacts preserve --json
uv run <skill-dir>/scripts/aaw.py rollback --sr SR-XXX <id> --artifacts discard --json
```
