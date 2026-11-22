# 远程项目技术穿刺记录

验证日期为 2026-11-22。独立原型在 Windows 上通过标准 ACP 驱动真实 OpenCode 会话，通过项目 MCP 和 OpsCopilot SSH/SFTP 内核操作远端 Linux 测试目录。

## 实测结果

| 场景            | 证据                                                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自动放行        | 会话 `ses_dfc25a4abffea219jC7I7wJcPn`。Agent 实际调用项目工具读取、保存和跑测试。两个审批请求均由 AAW 的自动放行策略处理。远端由 `retryLimit=2` 改成 `retryLimit=3`，测试输出 `retryLimit=3 verified`，退出码为 `0`。Git diff 显示对应改动，本机同名对照文件仍为 `retryLimit=2`。 |
| 需要确认并拒绝  | 会话 `ses_dfc26bff0ffet03ZRo4TiSy4jX`。Agent 读取远端配置后请求保存。测试宿主按需确认模式返回拒绝。远端值仍为 `2`，Git diff 为空，本机对照文件保持原样。                                                                                                                          |
| 需要确认并同意  | 会话 `ses_dfc214322ffeIPe97ne3vhUoJP`。测试宿主分别回应保存和跑测试的审批请求。远端值改为 `3`，Git diff 匹配，测试退出码为 `0`，本机对照文件保持原样。                                                                                                                            |
| 项目 MCP 认证   | OpenCode 通过 ACP 声明 HTTP MCP 能力，使用会话收到的项目工具。未携带凭据的 MCP 请求返回 HTTP `401`。                                                                                                                                                                              |
| Windows sidecar | `ops-sidecar.exe` 和独立预验证程序均在 Windows 构建。现有 sidecar 使用独立的 `OPSCOPILOT_DATA_DIR` 启动，`connections/list` 返回成功。                                                                                                                                            |

三次会话使用 OpenCode `1.19.5` 和 `zhipuai-coding-plan/glm-5.3-flash`。三次都发送相同的任务描述，要求读取 `settings.txt`、将 `retryLimit` 改为 `3`、跑项目测试。Agent 自行选择项目 MCP 工具。Windows 上的 OpenCode 配置、会话目录和监听端口都是本次验证专用。自动放行和拒绝的远端项目是 `/tmp/aaw-remote-project-spike.CPyQNZJr`，同意路径使用独立副本 `/tmp/aaw-remote-project-spike.SzYL2vHW`。

## 实现约束

- 在 ACP 会话创建时通过现有会话工具登记点注入 HTTP MCP。项目凭据在测试进程内绑定目标和目录。测试工具只处理样例配置和固定测试命令。
- SFTP 通道使用文件操作的上下文。若把 SSH 启动的限时上下文用于长期 SFTP 通道，模型思考期间可能关闭通道，下一次文件操作会失败。
- 固定主机密钥要与 Go SSH 实际协商的密钥算法匹配。本次按 Windows 已信任的 ECDSA 主机密钥完成验证。多算法主机的通用处理留给连接适配。

## 复验入口与范围

AAW 基线为 `29975706`，入口是 [run-acp.mjs](../spike/run-acp.mjs)。脚本复用现有会话工具登记点和自动审批决策。OpsCopilot 基线为 `1e49e3c`，在独立副本用 `go build ./cmd/ops-project-spike` 构建预验证程序。SSH 凭据由运行环境临时传入，项目工具只收到本机 MCP 会话凭据。

本记录覆盖独立原型的真实远端读改跑、单独的 Windows sidecar 启动和测试宿主审批。工作台实测见后文。现有 `remoteOps` 插件装配、发布配对打包和真实本地项目对照仍待联合验收。此轮使用提供的 Linux 服务器，未检查远端外发网络。

## 工程检查

- AAW 类型检查和 ESLint 通过。Vitest 在本次进程内设置 `NODE_OPTIONS=--dns-result-order=ipv4first` 后通过，2233 项通过，2 项跳过。
- 预验证代码和本记录通过定向 Prettier 检查。全仓格式检查仍有基线格式问题，范围包括此前恢复的方案文档。
- OpsCopilot 的 `opssidecar`、`core/ops`、`filetransfer`、`sshclient` 测试通过。

## AAWD 工作台联调

AAW 已快进到远端 `main` 的 `77e96968`（0.1.55）。Windows 调试实例使用独立应用标识和数据目录，使用该版本的工作台和原生 ACP 宿主。Tauri 启动由 `cmd/ops-sidecar` 构建的程序，以调试模式提供绑定测试目录的项目工具。

- 登录等待。自动等待 45 秒后进入最多 10 分钟的人工登录等待。完成开发身份登录后，脚本从实际工作台继续运行。产品已有的登录流程保持原样。
- 同意路径。由工作台点「新建会话」并发送任务。原生 ACP 启动 OpenCode，通过会话工具登记点挂载项目 MCP。会话 `ses_dfc0a473affec1jXTAi3r00ve2` 中，工作台分别显示远端文件保存和远端测试的权限审批。点击两次「允许」后，实际测试输出 `retryLimit=3 verified`、退出码 `0`。本机同名文件不变。远端测试目录是 `/tmp/aaw-remote-project-spike.HTRGetGS`。
- 拒绝路径。会话 `ses_dfc05e7c5ffe1JcdyI73PArvRg` 在工作台收到保存审批，点击「拒绝」后 sidecar 拒绝写入。通过独立 SSH 复核，远端 `retryLimit` 仍为 `2`，Git 工作区保持干净。远端测试目录是 `/tmp/aaw-remote-project-spike.DkoCRlw9`。
- 工程检查。最新基线上的 Vitest 有 2318 项通过。Rust 有 265 项通过、2 项忽略。Windows 调试构建成功。

复验入口为 [run-native-spike.mjs](../spike/run-native-spike.mjs)。测试使用专用 Vite 和 WebView2 调试端口，远端登录秘密由本机运行器传入。普通发布包、生产项目配置与文件和 Git 面板仍待后续适配。

## 通用工具与本地审批对照

测试基线为 AAW `77e96968`、OpsCopilot `1e49e3c` 和 OpenCode `1.19.5`。从 AAWD 工作台开始，给本地和远端同一条指令：定位重试配置、将默认值改为 `3`、新建 `CHANGELOG.md`、按项目说明运行测试。AAW 审批模式均为「每次询问」。

项目 MCP 暴露 `read_file`、`edit_file`、`write_file`、`run_command`。OpenCode 自行选择文件和命令，远程会话经 `run_command` 搜索并执行 `node --test`。成功输出为 `AAW_RETRY_TEST_OK`，退出码为 `0`。远程会话本机的同名配置保持 `2`。另通过独立 SSH 核对两个远端目录，配置值均为 `3`，`CHANGELOG.md` 均已新建，服务器上复跑测试均为 1 通过、0 失败。

| OpenCode 权限配置 | 本地                                       | 远端                                                                                      |
| ----------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 默认 build        | `ses_dfbd088e2ffeVPyVyaG2A55fFo`，0 次审批 | `ses_dfbc878e4ffeRWKuVw6OBlNTDM`，0 次审批，目录 `/tmp/aaw-remote-project-spike.O0pLfUEH` |
| 文件编辑需要询问  | `ses_dfbcbfa99ffe0WTmhwyYOM8RY4`，2 次审批 | `ses_dfbc6b926ffeLg7QS0aTdPYOvV`，2 次审批，目录 `/tmp/aaw-remote-project-spike.7OYnJfiY` |

两边各在修改配置和新建变更说明时显示审批，搜索和跑测试直接执行。远端审批复用工作台现有弹窗，显示改动预览及「允许」「本会话总是允许」「拒绝」。对照选择了逐次允许。

首轮对照曾出现本地 0 次、远端 5 次。远端验证桥此前把写文件和命令一律送进审批，因此增加了提示。修正后，调试桥按同一份已知 OpenCode 配置判断操作是否需要询问，再由当前 AAW 会话处理审批。默认行为以及按工具启用询问的方式可对照 [OpenCode 1.19.5 权限实现](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/agent/agent.ts#L111-L145)。

这里覆盖 Windows 调试工作台、OpenCode 的两种配置、真实远端操作及审批体验。任意 Agent 的权限适配、自定义路径与命令规则、发布打包仍需后续验证。独立测试实例使用自己的 Windows 实例锁，并跳过全局 `aaw://` 注册。样例命令在远端低权限账号下运行。
