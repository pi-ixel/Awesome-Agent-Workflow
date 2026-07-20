---
name: aaw-workflow
version: 1.1.1.0
description: 配置驱动的 AAW 工作流 CLI 入口技能。读取 aaw CLI 返回的自描述工作单，按工作单调用子技能、执行 prompt、检查交付件并推进流程。
---

# AAW 工作流

本 skill 只负责驱动 CLI 工作单，不包含具体业务节点知识。节点、入口、后继关系、变量映射、prompt、子 skill 调用和数据 schema 均由 CLI 读取配置后返回。

CLI 统一通过 `uv run` 调用（uv 按机器自身配置自动解析 Python 与依赖）；环境中没有 `uv` 时可退回 `python <skill-dir>/scripts/aaw.py ...`，此时需自行保证已安装 `typer` 与 `pyyaml`。

## 入口意图判定

当用户通过本 skill 但没有给出明确指令（例如空输入、只说“使用 aaw-workflow”、只贴需求但没说明继续还是新建）时，不要因为仓库中存在进行中的 workflow 就自动继续执行。

先执行：

```bash
uv run <skill-dir>/scripts/aaw.py status --json
```

然后按以下规则处理：

1. 如果用户明确说“继续 / 恢复 / 查看进度 / 处理 SR-XXX”，进入恢复流程。
2. 如果用户明确说“新建 / 启动 / 从 SR 入口 / 从 AR 入口”，进入启动流程。
3. 如果用户意图不明确且已有 workflow，列出已有 SR，并询问用户是继续已有 workflow，还是新开 SR/AR workflow；等待用户选择，不要执行 `next`。
4. 如果用户意图不明确且没有已有 workflow，询问用户选择 SR 入口还是 AR 入口，并收集启动所需变量。
5. 如果用户要继续但没有指定 SR，且存在多个 workflow，列出候选 SR 并让用户选择。

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
uv run <skill-dir>/scripts/aaw.py start --entry sr --sr SR-XXX --json
uv run <skill-dir>/scripts/aaw.py start --entry ar --sr SR-XXX --ar AR-XXX --title "AR描述" --json
```

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
- `deliverables`：强制交付件检查结果；`commands.done` 也会校验 required output，缺失时 CLI 会拒绝推进。
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
6. 若 `deliverables.can_skip=true`，说明强制交付件已存在；不要重复执行子 skill。若 `data` 为空，可直接执行 `commands.done`；若 `data` 不为空，仍需先按 `data.fields` 构造数据文件。
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
- 不通过/阻塞时默认原地修正 ASIS/TOBE/测试设计成果物，然后重新执行 gate。不要自动 rollback；只有用户明确要求重走上游节点，或已经生成了需要废弃的下游 step 时，才执行 `rollback`。

## 命令速查

```bash
# 启动
uv run <skill-dir>/scripts/aaw.py start --entry sr --sr SR-XXX --json
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

# 回退
uv run <skill-dir>/scripts/aaw.py rollback --sr SR-XXX <id> --json
```

## 会话建议

每完成一个 step 后建议用户新开会话，并通过：

```bash
uv run <skill-dir>/scripts/aaw.py next --sr SR-XXX --json
```

从 CLI 状态恢复，不需要依赖上一轮上下文。
