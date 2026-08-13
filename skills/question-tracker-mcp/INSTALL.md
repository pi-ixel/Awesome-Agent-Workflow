# question-tracker 安装指南

question-tracker 是一个 MCP（Model Context Protocol）服务器，为 AI Agent 提供"问题池"能力：批量记录待澄清问题、跟踪答案、维护答案历史、按会话隔离持久化。Go 静态编译，零运行时依赖。

## 1. 前置条件

- Agent 宿主：Claude Code / Chrys / Codex / OpenCode 之一
- **无其他依赖**：不需要 Python、uv、fastmcp 或任何运行时

## 2. 文件结构

```
question-tracker-mcp/
├── bin/
│   ├── linux/mcp_server       # Linux 可执行文件（静态编译，零依赖）
│   └── windows/mcp_server.exe # Windows 可执行文件
├── go/                        # Go 源码（开发用，不参与安装）
├── python/                    # Python 实现（已冻结 legacy，不再维护）
└── INSTALL.md                 # 本文档
```

## 3. 安装

### 3.1 推荐：install.sh 一键安装

在 Awesome-Agent-Workflow 仓库根目录执行：

```bash
./install.sh --target=claude --user --copy     # Claude Code
./install.sh --target=chrys --user --copy      # Chrys
./install.sh --target=codex --user             # Codex（仅注册 MCP）
./install.sh --target=opencode --user --copy   # OpenCode
```

install.sh 会自动完成：复制 skills、按平台选择二进制、向 Agent 配置文件注册 MCP。

### 3.2 手动注册（可选）

将本目录复制到目标位置后，向 Agent 的 MCP 配置中添加（command 为二进制的**绝对路径**，全部使用正斜杠）：

**Claude Code**（`~/.claude.json`）：

```json
{
  "mcpServers": {
    "question-tracker": {
      "command": "/absolute/path/to/question-tracker-mcp/bin/linux/mcp_server",
      "args": [],
      "env": {}
    }
  }
}
```

**Chrys**（`~/.chrys/agents/Code.yaml`）：

```yaml
tools:
  mcp:
    - name: question-tracker
      transport: stdio
      command: /absolute/path/to/question-tracker-mcp/bin/linux/mcp_server
      args: []
      enabled: true
```

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.question-tracker]
command = "/absolute/path/to/question-tracker-mcp/bin/linux/mcp_server"
args = []
```

**OpenCode**（`opencode.json`）：

```json
{
  "mcp": {
    "question-tracker": {
      "type": "local",
      "command": ["/absolute/path/to/question-tracker-mcp/bin/linux/mcp_server"],
      "enabled": true,
      "environment": {}
    }
  }
}
```

Windows 平台将 `linux/mcp_server` 换成 `windows/mcp_server.exe`。

注册后重启 Agent 宿主生效。

## 4. 数据目录

问题池持久化在用户主目录下，与 Agent 类型无关：

```
~/.question-tracker/
  <项目目录名>-<hash6>/           # 项目维度（按 MCP 进程工作目录推导）
    <session>/state.json          # 活跃问题池
    .archive/                     # finalize 完成后的归档池
      <session>-<yyyyMMdd>/state.json
```

- **根目录覆盖**：设置环境变量 `QUESTION_TRACKER_HOME` 可改变根目录位置（测试与高级部署用）
- **池文件格式**：JSON（`questions` + `next_id`），可直接阅读审计
- **多项目隔离**：不同项目目录（CWD 不同）的问题池天然隔离

### 4.1 调试日志（现场取证）

MCP 调用异常时，在 Agent 的 MCP 配置 `env` 中加入并重启宿主：

```json
"env": { "QUESTION_TRACKER_DEBUG": "1" }
```

此后所有原始请求/响应逐行追加到 `~/.question-tracker/debug.log`（设置了 `QUESTION_TRACKER_HOME` 时为其下的 `debug.log`）；把该文件交给维护者即可定位问题。取值为自定义路径时（如 `D:\logs\qt.log`）写入指定文件。日志写入失败不会影响 MCP 正常工作；排查完毕后删除该环境变量即可。

## 5. 工具一览

| 工具 | session | 作用 |
|---|---|---|
| `create_session` | 必填 | 新建问题池（唯一建池入口；同名池已存在时幂等返回） |
| `add_questions` | 必填 | 批量添加问题；池须已存在（先 `create_session` 建池） |
| `answer_question` | 必填 | 记录用户答案 |
| `update_answer` | 必填 | 修改已记录问题的答案（保留历史） |
| `get_status` | 必填 | 查看所有问题及状态（含已答答案） |
| `finalize_questions` | 必填 | 闭环确认；ready 后该池自动归档至 `.archive/` |
| `reset_questions` | 必填 | 重置问题池 |
| `list_sessions` | 不需要 | 列出当前项目下所有问题池（发现与审计入口） |
| `reopen_session` | 必填 | 将已归档的池重开回活跃区 |
| `delete_session` | 必填 | 删除活跃池（需 confirm: true） |
| `cleanup_sessions` | 不需要 | 归档池受控清理（默认只列不删，purge 需 confirm: true） |

### 调用纪律

1. **session 必填**：所有池操作必须传 session。忘记池名时先 `list_sessions`，不得随意起名另开新池。
2. **命名规范**：`<工作单元编号>-<语义关键词>`（如 `sr001-用户认证`、`sr001-ar002-支付回调`）。
3. **list-first**：启动时先 `list_sessions` 检查目标池是否存在，存在则续用，不存在再 `add_questions` 新建。
4. **无法确定时问人**：凭语义无法唯一确定目标池时，不得猜测，必须将 `list_sessions` 的结果展示给用户，请用户指定。
5. **池名不含敏感信息**：同一 project 下池名对所有调用方可见，不得包含密码、密钥、个人隐私。

## 6. 验证安装

直接运行二进制验证 stdio 握手与建池（Linux/Git Bash 示例）：

```bash
export QUESTION_TRACKER_HOME=/tmp/qt-verify
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'; \
 echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_session","arguments":{"session":"verify-pool"}}}'; \
 echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_questions","arguments":{"session":"verify-pool","questions":["验证问题？"]}}}'; \
 echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_status","arguments":{"session":"verify-pool"}}}'; \
 sleep 2) | /path/to/mcp_server
```

预期：initialize 响应 `protocolVersion: "2024-11-05"`；create_session 返回 `created: true` 与 `pool_location`；add 返回 `added_count: 1`；get_status 返回 `total: 1, pending: 1`。池文件出现在 `/tmp/qt-verify/<项目>-<hash>/verify-pool/state.json`。

未传 session 或池名不存在时，工具不报错，而是返回 `action_required: "select_session"` 选池指引（附 `available_sessions` 列表与 `guidance`），引导调用方选择已有池、向用户确认或用 `create_session` 新建。

## 7. 卸载

1. 从 Agent 配置中移除 `question-tracker` 条目（或执行 `./install.sh --uninstall --target=<agent>`）
2. 数据目录 `~/.question-tracker/` 包含历史决策记录：默认保留；确认不需要后可手动删除
