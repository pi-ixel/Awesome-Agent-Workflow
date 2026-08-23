---
name: repo-init
description: Use when the user asks for 软件实现设计/software_architect/初始化代码仓/sdd/初始化/init/更新代码仓软件架构/更新代码仓软件实现设计.
version: "2.3.2.1"
---

# Repo Init
Make a todo list to follow this workflow below.

## 复用已有架构基线

若工作单返回 `existing_output_reusable=true`，先读取已有 `.sdd/software_architecture.md`，不执行下方完整初始化。确认它能够作为下游架构基线：重点关注会影响模块范围、职责、依赖方向、数据归属或运行边界理解的未决项、冲突和明显失效信息。

- 没有疑点时，不修改现有成果，直接执行工作单的 `commands.done`。
- 有疑点时，说明发现依据和影响，集中向用户提问；不要用固定问卷代替判断。疑点澄清且无需修改后直接完成；需要修订时只更新受影响的架构内容，并按 Phase 6、Phase 7 收尾。
- 文件不可用或用户明确要求刷新时，执行下方完整初始化。回滚或重试时 CLI 不会给出复用标记，因此仍会完整执行。

### Phase 1 Launch a subagent to initiate directory
excute `<skill-dir>/scripts/create_sdd_structure.py` in the skill to initiate directory

### Phase 2 Launch a subagent to copy file
```
if (./AGENTS.md)文件不存在
    Copy `<skill-dir>/references/AGENTS.md` to `./`
if (./.sdd/software_architecture.md)文件不存在
    Copy `<skill-dir>/references/software_architecture.md` to `./.sdd/`
```

### Phase 3 Launch a subagent to copy spec
Launch a subagent to survey the codebase to make sure what the program language is？
if `c`:
|__ Copy `<skill-dir>/assets/c-spec.md` to `./.sdd/spec.md`
if `c++`:
|__ Copy `<skill-dir>/assets/C++-spec.md` to `./.sdd/spec.md`
if `java`:
|__ Copy `<skill-dir>/assets/java-spec.md` to `./.sdd/spec.md`
if `python`:
|__ Copy `<skill-dir>/assets/Python-spec.md` to `./.sdd/spec.md`
if `javascript`:
|__ Copy `<skill-dir>/assets/js-spec.md` to `./.sdd/spec.md`

### Phase 4 Launch a subagent to Write software_architecture.md
if software_architecture.md is existed in './.sdd/'
- 读取并更新现有文件，不得因文件存在而跳过。

else
- Launch a subagent to survey the codebase，Fill in all placeholders '{{***}}' in software_architecture.md，IMPORTANT: do NOT modify or fill in any placeholders in 'section 1.2' and 'section 1.3' and 目录.
### Phase 5 Launch a subagent to Write AGENTS.md
if AGENTS.md is existed in './'
- 读取并更新现有文件，只修改过期或缺失内容。

else

Launch a subagent to survey the codebase
Detect:
- Build, test, and lint commands (especially non-standard ones)
- Languages, frameworks, and package manager
- Project structure (monorepo with workspaces, multi-module, or single project)
- Code style rules that differ from language defaults
- Non-obvious gotchas, required env vars, or workflow quirks
- Existing .claude/skills/ and .claude/rules/ directories
- Formatter configuration (prettier, biome, ruff, black, gofmt, rustfmt, or a unified format script like `npm run format` / `make fmt`)

Exclude:
- File-by-file structure or component lists (Claude can discover these by reading the codebase)
- Standard language conventions Claude already knows
- Generic advice ("write clean code", "handle errors")
- Detailed API docs or long references — use `@path/to/import` syntax instead (e.g., `@docs/api-reference.md`) to inline content on demand without bloating CLAUDE.md
- Information that changes frequently — reference the source with `@path/to/import` so Claude always reads the current version
- Long tutorials or walkthroughs (move to a separate file and reference with `@path/to/import`, or put in a skill)
- Commands obvious from manifest files (e.g., standard "npm test", "cargo test", "pytest")

Be specific: "Use 2-space indentation in TypeScript" is better than "Format code properly."

Do not repeat yourself and do not make up sections like "Common Development Tasks" or "Tips for Development" — only include information expressly found in files you read.

Write a minimal AGENTS.md according to the .sdd/AGENTS.md.

### Phase 6 **update '目录'**
Update section '目录' with correct line numbers after all content is assembled. Do NOT fill in placeholders.

### Phase 7 Confirm key content with the user

If this run created or modified `.sdd/software_architecture.md`, output the reminder
below and wait for the user to confirm the listed items before completing. If the file
already existed and was not modified in this run, output the reminder for reference and
continue without waiting.

```
⚠️ **Important Reminder**

Auto-generated documents from repo-init have low accuracy. Please manually review the following key items to avoid omissions:

**`.sdd/software_architecture.md`**:
- **Module list**: Check if all modules are correctly identified — no missing or extra modules
- **Configuration list**: Verify config files, env vars, startup parameters are all covered
- **Tech stack**: Confirm language versions, framework versions, and other key tech info are correct
- **Table of contents**: Ensure line numbers in the 目录 section match actual content

**`AGENTS.md`**:
- **Build/Test commands**: Verify commands match what the project actually uses
- **Code style rules**: Confirm indentation, formatting, and other style rules match the project
- **Project structure**: Verify monorepo/multi-module/single-project classification is correct

Please review each item before proceeding with subsequent workflow steps.
```

`.sdd/software_architecture.md` is the architecture baseline for the entire downstream
workflow: `module-asis-analysis` treats it as the only source of module boundaries and
aborts when it is missing or conflicting. When this run generated or changed it, do not
report completion until the user confirms the review.

## 完成后回调

> 若不处于 `aaw-workflow` 编排中，请忽略此节。

本 skill 由 `aaw-workflow` 编排调用。交付件生成后：

1. 若本轮创建或修改了 `.sdd/software_architecture.md`，先完成 Phase 7 的用户确认，再执行工作单中的 `commands.done`。
2. 若 `.sdd/software_architecture.md` 本轮未发生变化，直接执行 `commands.done`。
