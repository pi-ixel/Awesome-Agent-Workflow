# Desktop 工作流服务

Rust 工作流服务按定义调度 Agent 和 Python 节点。Desktop 管理服务进程、主会话和流程运行视图；Agent 通过 ACP 运行，节点结果及恢复记录保存在 SQLite 中。

## 流程定义

AAW dev 的定义位于 [`definitions/aaw-dev.json`](definitions/aaw-dev.json)，节点知识位于 [`knowledge/`](knowledge/)。开发环境从这两处读取；构建时将定义和知识复制到服务资源目录。一次运行固定其定义和知识，之后修改模板不影响该运行。

定义由 `nodes`、`phases` 和可选的 `flows` 组成。执行节点的 `kind` 为 `agent` 或 `python`；`flow` 节点用于调用子流程。Agent 可以附带知识文件和结果 schema，Python 节点指定脚本及参数。

阶段的 `run` 列出节点，`edges` 声明节点之间的依赖：没有相互依赖的节点可并行，每个节点在其所需上游就绪后启动；多个上游指向同一节点时等待这些上游。条件连线可跳过分支，汇合时可声明哪些上游允许跳过。阶段间的 `routes` 根据结果选择下一阶段，也可以返回先前阶段形成有界循环。`edges` 本身必须是无环图，循环通过阶段路由表达。流程图和运行状态读取同一份定义与运行记录。

以下是结构示例，实际节点还可以声明自己需要的字段和路由条件：

```json
{
  "id": "example",
  "name": "Example",
  "entry": "work",
  "nodes": {
    "work": { "kind": "agent", "actor": "worker", "prompt": "完成任务" },
    "check": { "kind": "python", "actor": "checker", "script": "check.py" }
  },
  "phases": {
    "work": { "run": ["work"], "routes": [{ "next": "check" }] },
    "check": { "run": ["check"], "routes": [{ "next": "$complete" }] }
  }
}
```

`routes` 从上至下匹配；条件可以读取 `vars`、节点最近结果 `latest` 和当前阶段结果 `batch`。路由可通过 `set` 更新变量。阶段可设 `maxVisits`；未指定时上限为 1000，达到上限后停止并反馈。需要用户决策时由 Agent 在会话中提问并等待答复。

子流程通过 `flows` 声明入口和输出；调用方可以明确映射输入。阶段调用子流程时可用 `foreach` 根据运行时数组创建实例，并用 `maxConcurrency` 控制并发；结果按输入顺序汇集。每个实例有独立的输入、结果、执行路径和会话范围。`$return` 返回子流程，`$complete` 完成根流程。完整示例见 [`definitions/aaw-enterprise.json`](definitions/aaw-enterprise.json)。

节点可省略输入要求；需要强制前置条件时，在 `requires` 中声明条件和缺失提示。结果默认为 JSON 对象，节点可自行定义字段；只有配置了 `schema` 的节点才按其约束验证。支持的 schema 关键词为 `type`、`enum`、`properties`、`required`、`additionalProperties`、`items`、`title` 和 `description`；不支持的关键词会被拒绝。

Python 脚本以 UTF-8 JSON 从标准输入读取 `vars` 和 `latest`，标准输出须为一个 JSON 对象。脚本可以在定义中写路径，也可以用 `$input:名称` 声明启动时的脚本绑定；AAW dev 的检查器使用 `scanner` 绑定。引擎在启动运行时固定脚本摘要，执行前校验；进程异常退出或输出无效时阻塞，超时或失联按结果不明处理。只含 Python 的流程不需要 ACP Agent 或问题池进程。

## 节点结果与成果物

每次节点执行分别保留结果、节点标识、执行序号和流程定义提供的实例上下文。Agent 可以调用 `list_workflow_results` 查看结果目录，使用 `get_workflow_result` 读取原始结果；自定义字段不会因下游产生摘要而丢失。

对需要固定内容版本的成果物，`capture_workflow_artifact` 接受本地文件路径、`file:` 地址或 HTTP(S) 地址，将内容固定到当前运行并返回不可变引用与 SHA-256。`read_workflow_artifact` 按引用分片读取；每个文件上限 25 MiB，每次读取上限 64 KiB。HTTP 地址可以使用查询参数，保存的来源信息不包含查询参数；HTTP 认证头配置不由这两个工具提供。没有显式捕获的普通路径仍指向原文件，不承诺文件内容固定。

## 问题池和 ACP 会话

每次运行启动独立的 question-tracker MCP 进程，所有 Agent 节点通过受限工具共享同一问题池；进程结束后记录由问题池持久化。正常 ACP 文本交互会记录上一轮 Agent 文本和用户回复；结构化提问也会记录问题与答案。节点可通过问题池工具查询和补充记录。

Agent 节点通过标准 ACP 会话执行，用户交互位于 Desktop 主会话区；同一子流程实例内符合定义的逻辑角色可以复用会话，不同子流程实例不会共用会话。流程面板展示运行状态并提供节点到会话的导航。

## 构建和测试

在 `desktop/` 执行 `npm run workflow:build:debug` 构建开发服务，或执行 `npm run workflow:build` 构建发布服务。资源目录包含 `workflow_service`、独立的 `question-tracker`、流程定义和知识文件。Windows 使用对应的 `.exe`。Node 仅用于构建脚本，不是工作流服务的运行时依赖。

Rust 常规测试在本目录执行 `cargo test`。需要 Python 和受控 ACP 替身的服务测试通过 `cargo test --test service_protocol -- --ignored --skip real_icode` 显式执行；它们验证协议和调度，不代表真实 Agent 的执行质量。`real_icode` 冒烟用例会调用已配置的真实模型，需单独显式运行。

Desktop 使用应用数据目录下的 `workflow-engine/workflow-runs.sqlite`。动作执行前先持久化在途状态；中断后需核验结果并登记或授权重试，不会自动假定外部动作未发生。服务启动日志写入 `workflow-engine/service-stderr.log`。
