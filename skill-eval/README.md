# AAW Skill Eval

AAW Skill Eval 是独立的本地 Agent Skill A/B 测试平台。它从同一个干净 Git commit
创建一次性工作区，对比无 Skill、上一基准版本和当前候选版本，并保存盲评得分、
hard gate、运行轨迹与证据包。Runner 和 Judge 支持 Codex 与 Chrys，默认使用同一
平台和模型，也可以分别选择。

创建测试时，“预期效果”既可以直接填写，也可以导入不超过 2 MB 的 `.md` 或
`.markdown` 文件。文件只在浏览器本地读取，Markdown 原文会填入文本框并作为
Judge 的预期效果输入。

## 启动

```powershell
cd skill-eval
python -m pip install -e ".[test]"
aaw-skill-eval
```

浏览器访问 `http://127.0.0.1:18110`。服务默认只监听本机。

数据保存在 `skill-eval/.skill-eval-data/`。可通过环境变量
`AAW_SKILL_EVAL_DATA_DIR` 指向其他目录。

## Runner 与 Judge

- Codex 与 Chrys 都可独立担任 Runner 或 Judge；仅安装其中一个也可以运行；
- Chrys 模型从 `chrys models --json` 自动加载，实验创建时会固化模型、Runtime 版本、
  Agent 配置哈希、隔离和评分配置；排队后配置发生变化会让实验明确失败；
- Chrys 会维护 `%APPDATA%\chrys\agents\AAW-Eval-Runner.yaml` 与
  `AAW-Eval-Judge.yaml`，不会修改用户的 Code 或 QA Agent；
- Chrys Runner 继承当前有效 Code Agent 的指令和脚本扩展，但关闭子 Agent、外部 MCP
  与 `ask_user`；Judge 不配置工具、Skill 或工作区访问；
- 仪表盘按 `Skill × 项目 × 完整 Profile` 展示最近得分，不混合不同 Runner、Judge、
  模型、版本或隔离配置的结果；历史 Codex 实验按 legacy Profile 继续展示。

## 当前范围

- 正式实验每组 3 次，快速检查每组 1 次；
- 项目必须是干净的 Git 工作区；
- Skill 以完整目录快照和 SHA-256 内容哈希标识；
- 执行 Agent 看不到预期效果、Rubric、隐藏验证器或其他组结果；
- 自动分、hard gate 与人工复核彼此独立保存；
- 可选执行时间计分：用例配置 `time_scoring`（`target_seconds` / `limit_seconds` / `weight`）后，
  run 总耗时线性折算为「执行效率」分量计入质量分（≤target 满分、≥limit 零分，超时未完成 0 分）；
  未配置不计分，历史实验不受影响；
- 实验详情提供固定的实时日志控制台：可查看实验准备与每个 run/重试的阶段、Runner、验证器和 Judge 输出，并支持通道筛选、暂停、搜索、复制和原始日志下载；
- 成功工作区立即清理，失败工作区保留 7 天后在服务启动时自动清理，证据包不受影响；
- 仅基础设施错误允许由调用方重新排队，Agent 失败不会被静默丢弃。

## 安全边界

Codex 默认使用 `workspace-write` 沙箱、`approval_policy=never`、禁用网络、Web Search、
Apps、远程插件、自动安装 Skill 依赖和多 Agent。测试定义中的 setup、preflight 与
command grader 是用户明确配置的本地可信命令，运行前会在页面展示。

Chrys 使用一次性 Git 工作区和受管 Agent Profile 做软隔离，但 Chrys Runtime 当前
不提供与 Codex 等价的强制网络沙箱，因此页面会明确标记 `soft / uncontrolled`。
不要把不可信项目或需要严格断网的任务交给 Chrys Runner。
