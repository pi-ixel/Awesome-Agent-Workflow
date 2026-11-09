# src/aaw — AAW 集成层

把「AAW 工作流」这个领域接进客户端：aaw CLI、AAW skills、项目 `.sdd/`
流程状态。本层是领域逻辑层，产出领域模型，不产出 UI 状态。

## 已实现

- `workflowModel.ts`：aaw CLI `status` / `next` `--json` 输出的类型化
  模型与宽收窄解析器（unknown 进入、逐字段守卫、失败返回 null）；
  含门禁判定（type 以 `-gate` 结尾）、步骤条相位推导与命令行预览。
- `entryWizard.ts`：入口启动向导领域逻辑——三入口（sr / ar / dev）
  元数据与中文场景说明、变量校验、首条中文 prompt 生成（含「进入
  工作流」意图与入口变量，交给会话侧 aaw-workflow 技能执行 start）。
- `skills.ts`：内置 skills 安装器领域逻辑（对齐仓库根 install.sh 的
  chrys 分支）：清单扫描 + 已安装检测、逐项「先删后拷」覆盖复制、
  `.aaw-target` 标记写入、进度回调；文件系统能力经注入的
  `HostRuntime`（src/core/host.ts）完成。
- `processRunner.ts`（+ `tauriProcessRunner` / `nodeProcessRunner`）：
  工作区健康检查与 aaw CLI 调用的进程执行抽象——必须携带 cwd（aaw
  依赖 cwd 定位 `.sdd/`）与超时，且非 Tauri 环境仍要真探测（Node
  子进程）；与 `core/host.ts` 的 HostRuntime 分工互补，共用同一组
  Rust command（`run_command` / `path_exists`）。
- `healthChecks.ts`：工作区健康检查领域逻辑——uv / aaw CLI
  （`uv run <aaw.py> --help` 只读探测）/ `.sdd/` 存在性三项，逐项产出
  通过/警告/失败 + 中文修复指引；uv 失败时
  aaw 项短路；含从 skills 源目录推导 aaw.py 路径的 `deriveAawScriptPath`。
- `aawCli.ts`：aaw CLI 只读查询的统一出站封装（`runAawJsonQuery`：
  命令组装 + stdout → JSON 抽取）与 `extractJsonObject`；命令的组合
  由 `statusLoader.ts` 的 `AawStatusLoader` 承担。
- `statusLoader.ts`：`AawStatusLoader` 契约（listSrs / readStatus /
  readNext）及其 CLI 实现；工作流状态面板的唯一数据源。

## 职责

- **aaw CLI 调用**：工作流的创建、推进、查询等动作经 aaw CLI 完成
  （进程调用封装、参数构造、退出码与输出解析）。
- **流程状态读取**：解析项目目录 `.sdd/` 下的流程状态文件，
  转成类型化的领域模型（阶段、产物路径、阻塞点等）。
  GUI 复用设置中的 `uv` / `aaw.py`，以所选项目作为 cwd；配置改变立即
  重绑查询器。脚本未配置或不可访问时给出工具路径提示，不使用开发者目录
  兜底。列表成功即可选择 SR，详情整轮成功后更新快照；刷新失败保留同项目、
  同 SR 的上次结果并标注，CLI 的非零退出优先展示 JSON 错误码与完整原因，
  只有成功返回空列表才显示暂无工作流。切项目会清空快照，旧查询不得回写。
- **AAW skills 发现**：列出可用 skills 及其元数据，供 UI 选择与注入。
- 与 agent 会话的桥接：把工作流上下文（如当前阶段说明、待办产物）
  组装成发给 chrys 的 prompt 材料。

## 边界

- 不直接和 ACP wire 打交道（需要 agent 做事时经 `src/agents` +
  `src/runtime/acpBase/protocol` 提供的高层会话接口）；
- 不持有 React 状态：产出的模型交给 `src/stores` 的领域 store；
- CLI 调用与文件解析都要有结构化日志（走 `core/logger` 的 `aaw` 通道）。
