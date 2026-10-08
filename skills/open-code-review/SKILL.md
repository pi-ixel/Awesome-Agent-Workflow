---
name: open-code-review
version: "2.3.2.0"
description: 使用 alibaba/open-code-review（ocr CLI）对 Git 变更执行 AI 代码评审：OCR 以确定性工程完成文件选择与规则匹配，产出行级定位、按严重度分级的结构化意见（bug/安全/性能等）。默认委托模式由当前 Agent 执行评审，无需配置额外 LLM；也可切换 OCR 托管模式。适用于功能实现后、提交或交付前的语义级代码评审，也可独立调用。
---

# Open Code Review

`ocr` CLI（alibaba/open-code-review）以确定性工程决定「审哪些文件、套什么规则」，评审判断由 LLM 完成，输出按 severity（critical/high/medium/low）与 category 分级的行级意见。本 Skill 是对官方便携技能的 AAW 化薄壳，命令、参数与故障处理以 references/ 为准：

- `references/delegate-mode.md` — 委托模式（默认）：OCR 只做文件选择与规则解析（`ocr delegate preview` / `ocr delegate rule`），评审由当前 Agent 按规则组逐文件执行并按统一 schema 输出。OCR 侧无需配置 LLM。
- `references/ocr-managed-mode.md` — OCR 托管模式：`ocr review` 由 OCR 自行调用其已配置的模型完成评审。用户明确要求 OCR 引擎评审、或环境已配置 provider 时使用；未配置时按该文档引导用户完成 `ocr config provider`，不得代填密钥。

用户未指定模式时选择委托模式。

## 业务上下文

评审前先收集业务上下文并随命令传入，可显著提升评审质量：

- 工作流内（存在 `.sdd/{SR}/`）：优先把 `dev-design.md` 或 `模块详细设计说明书.md` 经 `--background-file` 传入；超过 CLI 尺寸上限时按参考文档的「恢复超大背景上下文」流程摘要后重试，不得静默截断设计文档。
- 独立调用：从需求描述或 commit message 提炼一句业务背景，经 `--background` 传入。

## 执行纪律

- 以 `ocr` 的原生输出与退出状态为评审结果，不另建包装报告；CLI 不可用、执行异常或结果无法判断时，停止并说明阻塞，不得把失败解释为通过。
- 不得通过 `--no-filter`、删除规则、放宽排除项或改写结果来获得「无问题」结论；`--exclude` 仅限与评审目标无关的路径（生成物、测试数据等），且须向用户说明理由。
- 委托模式必须覆盖 preview 返回的每个 reviewable file：逐文件标记 reviewed 或带具体理由的 skipped，报告中给出 total/reviewed/skipped 与覆盖率。
- 默认只评审不修改；用户明确要求修复时，仅处理 critical/high（含 medium 需用户确认），并遵循与 CodeCheck 相同的边界——修改不触及业务行为、公共契约、数据兼容、安全边界或已评审设计时，可直接修复并复验；触及任一边界或需多种取舍时，停止并呈报证据、影响与可选方案，等待用户决策。不得为通过评审关闭规则、弱化检查或改写结果。
- 定位失败（start_line 与 end_line 均为 0）的意见：先读目标文件定位相关代码再处理，不得因定位失败丢弃意见。

## 内置工具与运行约束

`ocr` CLI 已随 Skill 内置于 `vendor/bin/`（Windows amd64 与 Linux amd64：Windows 用 `vendor/bin/ocr.exe`，Linux x64/WSL 用 `vendor/bin/ocr`），从项目根目录以绝对路径直接调用，无需安装、无需 PATH、无需网络。references/ 文档中的 `ocr` 命令一律替换为该绝对路径执行；其中的 npm 安装路径面向上游通用环境，本环境一律忽略。其他平台未内置时参照 `vendor/README.md` 补充，在此之前该平台按阻塞处理，不得临时联网下载。前置要求 Git >= 2.41；二进制缺失或执行异常时，说明阻塞并停止，不得降级为无工具的自由评审并冒充本 Skill 的结果。

运行约束（本环境禁止任何云服务）：

- 默认且优先使用委托模式：OCR 侧仅做本地 Git 操作与规则文件解析，不发起任何 LLM 调用；评审由宿主 Agent 按其既有模型完成。
- 遥测保持默认关闭（`telemetry.enabled` 缺省即 false）；托管模式仅允许经 `providers.<name>.url` 指向内网模型端点，禁止配置任何公网端点。
- 评审产物只落本地：会话与记录在 `~/.opencodereview/`，报告写入工作区，不得上传至外部服务。
