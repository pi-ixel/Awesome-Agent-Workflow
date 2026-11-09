# ICode ACP 增强模块

`adapter.ts` 是功能入口，注册表只负责注册和查找。`../types.ts` 定义通用适配能力，不引用本模块类型。普通 ACP Agent 不自动获得这些能力。

| 功能                               | 实现位置                                                          | 通用层接收的内容                          |
| ---------------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| 私有通知、结构化提问、错误和警告   | `chrysDialect.ts`、`types.ts`                                     | 通用会话事件、问题模型                    |
| 运行时、模型、技能候选与调用文本   | `chrysRuntime.ts`、`skillCatalog.ts`                              | `RuntimeSnapshot`                         |
| 用量统计                           | `chrysDialect.ts`、`usageTypes.ts`                                | 带统计口径的用量事件                      |
| 子代理识别、生命周期、进度         | `subagentTool.ts`、`subagentLifecycle.ts`、`subagentTelemetry.ts` | 通用子代理展示模型                        |
| 审批工具名、工具类型、编辑差异     | `adapter.ts`、`editPayload.ts`                                    | 标准化审批信息和 `EditPayload`            |
| 压缩历史、旧版会话文件解析         | `chrysArchive.ts`、`chrysSessions.ts`                             | 通用历史事件；不作为其他 Agent 的列表兜底 |
| 启动命令、可执行路径探测、连接检测 | `launch.ts`、`probe.ts`、`settings.ts`                            | 适配器能力和设置状态                      |
| 旧路径字段迁移                     | `legacyConfiguration.ts`                                          | 兼容后的持久化值                          |
| 技能安装目录、覆盖和标记规则       | `skillsInstaller.ts`                                              | `SkillInstallation`                       |

目录命名由增强模块指定：调用通用 `HostRuntime.userDataDir("chrys", "skills" | "sessions")`。宿主只按平台解析命名空间目录并验证路径片段，不知道 ICode。原有磁盘目录保持不变。

厂商实现由 `builtins.ts` 注册。用例直接引用本增强，通用模块通过公开契约接收归一化数据。

通用设置 store 只管理 `agentSettings[agentId]` 持久化数据和 `agentSettingsState[agentId]` 临时状态，不导入本模块，不持有 ICode 字段或动作。适配器通过 `settingsDefaults`、`migrateSettings` 注册默认值与迁移；`settings.ts` 解释自身数据并提供探测/校验动作，`launch.ts` 向设置页提供通用编辑接口。只有当前适配器声明初始化能力时才自动探测。

旧顶层 `chrysPath` 由 ICode 迁移器读取为 `agentSettings.chrys.executablePath`。新记录存在时以新记录为准（包括空路径），避免重置或清空后被旧值覆盖；保存通用设置时保留原始旧字段，但运行时不再使用该字段。工作区通用 store 对所有未知字符串键只保留、不解释；`launch.ts` 独立解释旧 `chrysCommand`，将空值和旧默认值 `chrys` 迁移为 `icode`，显式配置优先。宿主专属目录方法及 IPC 已替换为通用 `userDataDir` / `user_data_dir`。

`tests/agents/icodeBoundary.test.ts` 检查通用协议、领域、store 和 UI 中没有可执行的 `_chrys/*` 或 `_meta.chrys` 解释，并验证普通 Agent 不获得 ICode 审批、历史读取和配置初始化能力。对应功能测试继续覆盖转换后的内容。
