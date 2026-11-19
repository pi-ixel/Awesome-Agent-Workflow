# Desktop 界面功能参考

主窗口由 `src/bootstrap/installDesktopWorkbench.ts` 装配。Workbench 管理界面贡献、导航、面板和窗口退出，各业务插件注册自己的界面与操作。

| 功能 | 所属插件 | 入口与内容 |
| --- | --- | --- |
| 项目与对话 | Project | 项目树、会话列表、草稿、消息流、工具调用、审批和表单 |
| 文件与文档 | Documents | 文件树、预览、Markdown 编辑、搜索和批注 |
| 版本控制 | Git | 项目变更、差异视图和审阅 |
| 终端 | Terminal | 终端面板、标签和进程连接 |
| 工作流 | Workflow | 工作流状态、时间线和入口向导 |
| Agent 与技能 | Agents、Skills | Agent 选择和配置、技能来源与安装 |
| 桌面管理 | Workbench、Account、Updates、Diagnostics | 外观与导航、登录、更新和独立诊断窗口 |

具体插件职责与资源所有权见 [Cordis 插件架构](../architecture/cordis-plugin-architecture.md)。视觉与交互规则见[前端风格约束](../engineering/frontend-style.md)。[文档批注](document-annotations.md)和[会话状态悬浮卡](session-status-card.md)记录对应功能的行为。历史界面说明保存在[旧参考](../history/ui-reference-legacy.md)。
