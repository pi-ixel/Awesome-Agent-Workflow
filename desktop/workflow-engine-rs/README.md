# Desktop 工作流服务

Rust 工作流服务按定义调度 Agent 和 Python 节点。Desktop 管理服务进程、主会话和流程运行视图；Agent 通过 ACP 运行，节点结果及恢复记录保存在 SQLite 中。

## 工作流与源码

工作流以目录形式存放：`workflow.yaml` 写名称、起点、阶段和初始变量，`flows/*.yaml` 一个文件一个流程，`knowledge/*.md` 是节点引用的知识文件。格式与表达式写法见 [`docs/workflow-format.md`](docs/workflow-format.md)。

- **预置工作流**在 [`workflows/`](workflows/)：`aaw-dev`（轻量开发）与 `aaw-enterprise`（完整开发，含 SR / AR 两个起点）。开发构建直接读这个目录；发布构建把它复制到服务可执行文件旁的 `workflows/`。
- **用户的工作流**在应用数据目录的 `workflow-engine/workflows/<id>/`，由「复制为我的」得到。
- 运行前引擎把源码编译成内部定义（`source.rs`，表达式见 `expr.rs`），编译时检查引用、条件、字段与可达性，诊断带文件和行号。`workflow_service check <目录> [--emit]` 在命令行做同样的检查。
- 启动一次运行时，编译产物连同内容哈希与起点一起存进运行记录；之后修改源码不影响这次运行。

内部定义（编译产物）的执行语义：

阶段的 `run` 列出节点，`edges` 声明节点之间的依赖：没有相互依赖的节点可并行，每个节点在其所需上游就绪后启动；多个上游指向同一节点时等待这些上游。条件连线可跳过分支，汇合时可声明哪些上游允许跳过。阶段间的 `routes` 根据结果选择下一阶段，也可以返回先前阶段形成有界循环。`edges` 本身必须是无环图，循环通过阶段路由表达。

`routes` 从上至下匹配；条件可以读取 `vars`、节点最近结果 `latest` 和当前阶段结果 `batch`。路由可通过 `set` 更新变量。阶段达到访问上限后停止并反馈。需要用户决策时由 Agent 在会话中提问并等待答复。

子流程声明入口和输出；调用方可以明确映射输入。阶段调用子流程时可用 `foreach` 根据运行时数组创建实例并控制并发；结果按输入顺序汇集。每个实例有独立的输入、结果、执行路径和会话范围。`$return` 返回子流程，`$complete` 完成根流程。

节点需要强制前置条件时，在 `requires` 中声明条件和缺失提示。只有声明了结果字段的节点才按其约束验证。

Python 脚本以 UTF-8 JSON 从标准输入读取 `vars` 和 `latest`，标准输出须为一个 JSON 对象。引擎在启动运行时固定脚本摘要，执行前校验；进程异常退出或输出无效时阻塞，超时或失联按结果不明处理。只含 Python 的流程不需要 ACP Agent 或问题池进程。

## 服务请求

Desktop 经 stdin / stdout 的 NDJSON 与服务通信。与工作流库相关的请求：

| 请求 | 作用 |
|---|---|
| `workflows` | 列出预置与用户的工作流（编译失败的附诊断） |
| `workflow` `{id}` | 一个工作流的元信息、各起点的画布目录与源码文件 |
| `workflow-copy` `{id}` / `workflow-delete` `{id}` | 复制为我的 / 删除我的 |
| `start` `{input: {cwd, workflow, entry, inputs, title?, command, mcpServers}}` | 按工作流与起点启动运行 |
| `start-flow` `{input: {cwd, definition, inputs, …}}` | 直接用编译好的定义启动（测试与调试） |
| `resume` / `stop` / `recover` / `authorize-retry` / `reconcile` | 运行控制 |
| `list` / `snapshot` / `session-links` | 运行列表（含标题、需求、起点、时间）、运行详情、节点会话关联 |

## 节点结果与成果物

每次节点执行分别保留结果、节点标识、执行序号和流程定义提供的实例上下文。Agent 可以调用 `list_workflow_results` 查看结果目录，使用 `get_workflow_result` 读取原始结果；自定义字段不会因下游产生摘要而丢失。

对需要固定内容版本的成果物，`capture_workflow_artifact` 接受本地文件路径、`file:` 地址或 HTTP(S) 地址，将内容固定到当前运行并返回不可变引用与 SHA-256。`read_workflow_artifact` 按引用分片读取；每个文件上限 25 MiB，每次读取上限 64 KiB。HTTP 地址可以使用查询参数，保存的来源信息不包含查询参数；HTTP 认证头配置不由这两个工具提供。没有显式捕获的普通路径仍指向原文件，不承诺文件内容固定。

## 问题池和 ACP 会话

每次运行启动独立的 question-tracker MCP 进程，所有 Agent 节点通过受限工具共享同一问题池；进程结束后记录由问题池持久化。正常 ACP 文本交互会记录上一轮 Agent 文本和用户回复；结构化提问也会记录问题与答案。节点可通过问题池工具查询和补充记录。

Agent 节点通过标准 ACP 会话执行，用户交互位于 Desktop 主会话区；同一子流程实例内符合定义的逻辑角色可以复用会话，不同子流程实例不会共用会话。流程面板展示运行状态并提供节点到会话的导航。

## 构建和测试

在 `desktop/` 执行 `npm run workflow:build:debug` 构建开发服务，或执行 `npm run workflow:build` 构建发布服务。资源目录包含 `workflow_service`、独立的 `question-tracker` 和预置工作流目录 `workflows/`。Windows 使用对应的 `.exe`。Node 仅用于构建脚本，不是工作流服务的运行时依赖。

Rust 常规测试在本目录执行 `cargo test`。需要 Python 和受控 ACP 替身的服务测试通过 `cargo test --test service_protocol -- --ignored --skip real_icode` 显式执行；它们验证协议和调度，不代表真实 Agent 的执行质量。`real_icode` 冒烟用例会调用已配置的真实模型，需单独显式运行。

Desktop 使用应用数据目录下的 `workflow-engine/workflow-runs.sqlite`。动作执行前先持久化在途状态；中断后需核验结果并登记或授权重试，不会自动假定外部动作未发生。服务启动日志写入 `workflow-engine/service-stderr.log`。
