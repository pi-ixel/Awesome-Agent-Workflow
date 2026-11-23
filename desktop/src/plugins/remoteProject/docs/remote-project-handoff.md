# AAW 远程项目工作交接

**现状**　Windows 调试工作台已跑通真实的远程开发任务。AAW 启动本机 OpsCopilot sidecar，经内置 ACP 给 OpenCode 会话挂载项目 MCP，Agent 自行找到远端代码、修改已有文件、新建文件并运行测试。下一项产品工作是实现「添加远程项目」和只读文件浏览。

目标体验是添加项目时选一次 SSH 连接和 Linux 目录，之后沿用普通项目的会话、文件、Git 和终端入口。本机 Agent 负责模型调用，sidecar 用 SSH/SFTP 操作远端。文件与 Git 工作区以远端为准，会话和面板状态保存在本机。[适配方案与实施计划](remote-project-adaptation-plan.md)

## 接手工作区

| 仓库       | 本机目录                                                       | 分支                         | 已验证基线 |
| ---------- | -------------------------------------------------------------- | ---------------------------- | ---------- |
| AAW        | `D:\dev\workspace-ai\Awesome-Agent-Workflow-remote-project-wt` | `codex/remote-project`       | `77e96968` |
| OpsCopilot | `D:\dev\workspace-go\OpsCopilot-remote-project`                | `codex/remote-project-spike` | `1e49e3c`  |

**两边的穿刺改动均未提交，包含未跟踪文件。** 同机接手直接打开这两个目录。跨机器交接时，将所需改动分别整理到两边分支，校对 `git status --short --untracked-files=all` 后再转交。AAW 并行开发目录 `D:\dev\workspace-ai\Awesome-Agent-Workflow-flow` 由另一项工作使用。

交接时，AAW 的本地远端跟踪引用 `publicOrigin/main` 已到 `efdd7178`，当前独立分支仍位于已实测的 `77e96968`。新提交涉及 `SessionFactory`、`sessionCoordinator` 和会话 UI。更新基线时先保全两仓变更，重点检查会话工具挂载和审批入口，再按下文复验。设计文档中的 `4b88d480` 是参考 checkout 的 `remoteOps` 实现，完整运维插件还未合入当前分支。

## 已验证的结果

使用 OpenCode 1.19.5，从 AAW 工作台给本地项目和绑定远端目录的项目发送同一任务。Agent 自行定位重试配置、将默认值从 `2` 改为 `3`、新建 `CHANGELOG.md`，再运行 `node --test`。两边均通过，远端文件和测试结果已通过独立 SSH 复核。

| OpenCode 配置    | 本地审批 | 远端审批 |
| ---------------- | -------- | -------- |
| 默认 build       | 0 次     | 0 次     |
| 文件修改需要询问 | 2 次     | 2 次     |

远端的两个审批分别对应修改旧文件和新建文件，复用工作台弹窗并显示改动预览。较早的固定样例也验证了桌面点击拒绝后，远端文件和 Git 状态保持原样。当前通用工具的对照覆盖两套已知 OpenCode 配置，自定义路径和命令规则、其他 Agent、普通发布包均待实测。[回放记录与会话 ID](remote-project-spike-results.md#通用工具与本地审批对照)

Agent MCP 的最小集已确定为 `read_file`、`edit_file`、`write_file`、`run_command`。搜索、Git 查询和测试可以通过 `run_command` 完成。文件树的列目录能力由 Desktop 项目接口提供。

## 穿刺代码入口

| 入口                                                                                                                                                                                      | 当前实现                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| AAW [原生 sidecar 宿主](../../../../src-tauri/src/ops_service.rs)                                                                                                                         | Tauri 从暂存目录启动 `ops-sidecar`，通过 stdio 传递操作与审批事件。验证使用调试启动参数 `--project-spike`。             |
| AAW [会话工具入口](../../project/sessions/sessionTools.ts) 和 [会话协调器](../../project/sessions/sessionCoordinator.ts)                                                                  | 用已有登记点给 ACP 会话挂载工具，提供当前会话的审批入口。                                                               |
| AAW [测试桥](../spike/native-fixture.mjs) 和 [权限配置](../spike/approval-profile.mjs)                                                                                                    | 测试桥绑定项目、会话和 MCP 凭据，按两套已知 OpenCode 配置判断操作是否需要询问。需要询问时交给 AAW 现有会话审批。        |
| OpsCopilot [sidecar 入口](D:/dev/workspace-go/OpsCopilot-remote-project/cmd/ops-sidecar/main.go) 和 [项目工具](D:/dev/workspace-go/OpsCopilot-remote-project/pkg/projectspike/project.go) | 提供四个工具、校验路径和文件版本，经 SSH/SFTP 执行，并按宿主的决策继续操作。调试 fixture 通过低权限账号运行远端 Shell。 |

**权限适配落在 AAW 一侧。** 当前映射属于验证代码。产品接入时，需要按当前 Agent 的实际权限与当前会话设置判定，从同一类操作的本地行为验收。测试桥采用的固定 OpenCode 配置是复验基准。

**并行调试使用独立的应用标识、用户数据、端口及实例锁。** 调试运行器设置 `AAW_DEV_INSTANCE_DIR`，独立实例跳过全局 `aaw://` 通知链接注册。见 [Windows 通知入口](../../../../src-tauri/src/notification_links.rs)。

## 接手后的第一项工作

1. **做通「添加远程项目」。** 复用 Ops 连接存储和 SSH/SFTP，完成连接新建、测试、编辑、主机指纹确认，以及浏览并选中远端目录。项目记录以 `connectionId` 与 `remoteRoot` 绑定目标。
2. **将只读文件树和预览接到同一项目上下文。** 文件、会话、标签页和缓存使用项目 ID 区分。用同一主机的两个 SSH 账号验收连接隔离，再验证重启后远程项目和本地项目历史均能恢复。
3. **随后接正式远程项目会话。** 将四个工具挂到普通会话，验收文件编辑、测试、右侧 Git diff 和权限一致性。继续验证自定义 Agent 规则、断线和保存冲突，最后完成配对 sidecar 的 Windows 发布包验证。

连接、目录选择及架构的已评审参考稿保存在本机。[交互原型](C:/Users/15802/.codex/visualizations/2026/11/18/01a1efe2-1b9e-7941-a52d-674b524ff957/remote-project-prototype.html) · [架构图](C:/Users/15802/.codex/visualizations/2026/11/18/01a1efe2-1b9e-7941-a52d-674b524ff957/remote-project-architecture.html)

## 复验入口

主入口是 [run-native-spike.mjs](../spike/run-native-spike.mjs)。同一脚本可跑本地和远端两类用例。[project-fixture.mjs](../spike/project-fixture.mjs) 定义样例项目和任务；[run-acp.mjs](../spike/run-acp.mjs) 可独立排查 ACP/MCP 传输。远端复验用新建的 `/tmp/aaw-remote-project-spike.XXXXXXXX` 项目，末尾为 8 位字母或数字。按样例落文件并建立 Git 初始提交，再运行试验。SSH 用户凭据通过安全渠道获取，运行时输入。OpenCode 使用本机已配置的模型。

在 AAW 独立目录的 `desktop` 下构建。

```powershell
npm ci
$env:OPSCOPILOT_REPO = 'D:\dev\workspace-go\OpsCopilot-remote-project'
node scripts/build-ops-sidecar.mjs
npm run workflow:build:debug

$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'src-tauri/target'
$env:TAURI_CONFIG = '{"identifier":"com.aaw.remote-project-spike","build":{"devUrl":"http://127.0.0.1:14713"},"bundle":{"resources":{"../workflow-engine-rs/dist/":"workflow-engine/","../ops-sidecar/dist/":"ops-sidecar/"}}}'
cargo build --locked --manifest-path src-tauri/Cargo.toml --bin desktop
```

同一权限配置下先跑本地，再传入测试连接跑远端。`build-default` 和 `ask-edits` 分别复验上表两行。`$hostKey` 传入已核验的完整 SSH 公钥，不是指纹文本。当前运行器使用 SSH 22 端口。

```powershell
$runner = 'src/plugins/remoteProject/spike/run-native-spike.mjs'
$opencodeExe = Join-Path $env:APPDATA 'npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe'
$env:AAW_SPIKE_PERMISSION_PROFILE = 'ask-edits'
node node_modules/tsx/dist/cli.mjs $runner $opencodeExe

$testHost = Read-Host '测试服务器地址'
$testUser = Read-Host 'SSH 用户'
$testProject = Read-Host '远端测试项目路径'
$hostKey = Read-Host '已校验的 SSH 主机公钥'
$env:AAW_SPIKE_SSH_PASSWORD = Read-Host -MaskInput 'SSH 密码'
try {
  node node_modules/tsx/dist/cli.mjs $runner $opencodeExe $testHost $testUser $testProject $hostKey
} finally {
  Remove-Item Env:AAW_SPIKE_SSH_PASSWORD -ErrorAction SilentlyContinue
}
```

Vite 使用 `14713`，WebView2 调试使用 `14714`。测试窗口等待自动登录 45 秒，随后给手动登录留 10 分钟。开发身份登录使用现有的用户名和工号表单。

已实测基线的工程门禁为 AAW Vitest 2318 项通过，Rust 265 项通过、2 项忽略，OpsCopilot 相关 Go 测试通过。前端全量复跑使用 `NODE_OPTIONS=--dns-result-order=ipv4first` 和 `npm run test -- --maxWorkers=2`。全仓 Prettier 存在基线告警，本轮验证代码通过定向检查。
