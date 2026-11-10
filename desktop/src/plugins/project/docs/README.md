# project

项目插件持有项目资料、会话目录及产品身份、草稿、消息投影、队列、审批和表单状态。

| 模块 | 职责 |
| --- | --- |
| `workspaceStore.ts`、`sessionIndexes.ts`、`catalog.ts` | 工作区、会话目录、活动与归档状态 |
| `composer/`、`conversation/` | 草稿、消息投影、会话运行视图和搜索 |
| `interactions/` | 审批、问答、表单和待办 |
| `ui/`、`workbenchViews.tsx` | 项目树、项目总览、会话入口及工作台注册 |

组件用选择器订阅状态，产品命令通过 `ProjectService` 访问。协议资源和产品投影的迁移进度见[迁移记录](../../../../docs/cordis-plugin-migration.md)。
