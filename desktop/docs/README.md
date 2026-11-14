# Desktop 文档

## 架构

- [Cordis 插件架构与职责](architecture/cordis-plugin-architecture.md)说明各插件服务、依赖和资源所有权。
- [插件依赖图](architecture/cordis-plugin-dependencies.md)列出插件之间的依赖。原始图源为同目录的 `cordis-plugin-dependencies.mmd`，架构测试会核对两者及实际装配。
- [ACP 架构与 Agent 方言扩展](architecture/acp-architecture.md)说明协议分层和 Agent 增强。

## 开发与维护

- [工程约定](engineering/conventions.md)和[前端风格约束](engineering/frontend-style.md)。
- [工作流界面修改指导](workflow/ui-guide.md)说明改工作流界面时怎么想、怎么查、怎么改、怎么验。
- [Windows CI/CD](engineering/CI-CD.md)说明构建、签名和发布。
- [开发运行与 ACP 宿主](engineering/development.md)说明开发入口和原生进程管理。
- [Desktop 项目入口](../README.md)列出本地开发命令。

## 功能说明

- [界面功能参考](features/ui-reference.md)。
- [文档批注](features/document-annotations.md)。
- [会话状态悬浮卡](features/session-status-card.md)。
- [用户登录](features/auth-login/README.md)。

## 历史记录

- [Cordis 迁移与验收记录](history/cordis-plugin-migration.md)。
- [ACP Runtime 阶段设计与实施记录](history/acp-runtime-design.md)。
- [迁移前架构](history/architecture.md)、[历史交接手册](history/HANDBOOK.md)、[旧界面参考](history/ui-reference-legacy.md)和[右栏第一版规则](history/right-panel-v1.md)。这些记录保留当时的状态和验证证据。
