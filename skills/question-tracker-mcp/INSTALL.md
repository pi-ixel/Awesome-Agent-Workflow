# sr-design 安装指南

## 1. 前置条件

- Python 3.8+（开发环境为 3.11.9）
- fastmcp 库：`pip install fastmcp`（开发环境为 3.3.1）
- 目标环境对 Skill 目录有读写权限

## 2. 文件结构

```
sr-design/
├── SKILL.md
├── mcp_server.py
├── test_mcp_server.py
├── test_blackbox.py
├── INSTALL.md
└── .question_state.json  # 运行时自动生成
```

## 3. 安装步骤

### 3.1 复制目录

将整个 `sr-design/` 目录复制到目标位置（通常是 Claude Code 的 skills 加载路径，如 `~/.claude/skills/`）。

### 3.2 安装 Python 依赖

```bash
pip install fastmcp
```

### 3.3 注册 MCP Server

在 Claude Code 的 `~/.claude.json`（或 `~/.claude/claude_desktop_config.json`）、opencode 的 `.opencode.json` 中添加：

```json
{
  "mcpServers": {
    "question-tracker": {
      "command": "python3",
      "args": ["/absolute/path/to/sr-design/mcp_server.py"]
    }
  }
}
```

> 也可以直接跑仓库根目录的 `./install.sh`，它会自动处理复制、依赖安装和 MCP 注册。

### 3.4 重启 AI 编码助手

重启后 MCP Server 将自动加载。

## 4. 验证安装

### 4.1 Skill 触发验证

在 AI 编码助手中输入触发词，如"帮我写一份功能设计文档"。

确认 Skill 被触发，开始分析代码仓库并提问。

### 4.2 测试验证（可选）

运行测试验证 MCP Server 功能正常：

```bash
cd sr-design
pip install pytest
python -m pytest test_mcp_server.py -v
python -m pytest test_blackbox.py -v
```

预期结果：23 passed (UT/IT) + 5 passed (BB) = 28 passed

## 5. 卸载

### 5.1 移除 MCP Server 注册

从 MCP 配置文件中移除 `question-tracker` 条目。若通过 `install.sh` 安装，可直接运行 `./install.sh --uninstall`。

### 5.2 删除目录

```bash
rm -rf /absolute/path/to/sr-design
```

### 5.3 卸载 fastmcp（可选）

```bash
pip uninstall fastmcp
```
