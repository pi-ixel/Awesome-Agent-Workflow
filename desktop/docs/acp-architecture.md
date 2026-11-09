# AAW Desktop 软件架构与 Agent 方言扩展指南

主窗口通过 `project → acpRuntime → acpConnection → host` 装配项目与 ACP 服务。项目目录的选中归属、标题和缓存由 `project` 管理，远端 `session/list` 分页由 `acpRuntime` 执行。各阶段的落点和过渡入口见[迁移工作流](cordis-plugin-migration.md)。

**所有 Agent 都通过同一套标准 ACP 与 AAW 对话。方言是可选的翻译器，只给选中的 Agent 增加对其专有消息和字段的支持。** 例如，使用 ICode 时，创建会话、发送消息和接收回复仍走标准 ACP。收到 ICode 专有的提问请求时，方言才把它翻译成 AAW 的问答卡，并把用户的答案按 ICode 要求的格式回传。

## 方言怎么加载

1. **开发时注册。** 每个内置 Agent 有一份适配器，描述它的 ID、启动命令和可选的方言创建函数 `createDialect`。ICode 的适配器以 `chrys` 为 ID，随应用编译，并登记在[内置注册表](../src/plugins/agents/builtins.ts)。
2. **连接时按选择查找。** 用户在设置里选好 Agent，AAW 建立连接时用所选 ID 查找对应适配器。选内置 ICode 会找到上述注册项；选本机发现的 OpenCode 或自定义命令，则得到只描述如何启动进程的通用适配器。即使自定义命令填写了 `icode acp`，启用的仍是自定义配置。[查找逻辑](../src/plugins/agents/registry.ts)
3. **为会话创建方言实例。** 运行时通过 `AgentsService` 获取适配器与启动描述，创建 ACP 会话时调用 `adapter.createDialect?.(...)`。适配器提供这个函数时，该会话获得独立方言实例。双方通过 `initialize` 握手确认图片、历史加载等标准能力。[Agent 服务](../src/contracts/agents.ts) · [连接装配](../src/plugins/project/sessionCoordinator.ts)

## 收到消息后谁处理

| Agent 发来的内容 | AAW 怎么处理 |
| --- | --- |
| 普通回复文字 | 通用 ACP 层解析为消息，显示在对话里。ICode 和其他 Agent 走同一路径。 |
| 标准工具更新，另带厂商专有字段 | 通用层先解析工具名称和状态。若当前方言认识额外字段，再为工具卡补充子代理进度等信息。 |
| ICode 私有提问 `_chrys/request_input` | ICode 方言识别方法并调用问答面板。其他 Agent 的连接没有这个处理器，遇到这个私有请求会返回“方法不支持”。 |

界面只需要知道“这是一条消息、一次工具调用或一个问题”。厂商的方法名和字段含义由对应方言解释。[协议处理](../src/plugins/acpRuntime/protocol/session.ts) · [ICode 方言实例](../src/plugins/agents/enhancements/icode/chrysDialect.ts)

## 下一个 Agent 怎么接

1. **先跑标准连接。** 在设置中添加它的 ACP 启动命令，验证对话和所需的标准能力。如果这些能力已经够用，到这里就完成接入。
2. **有专有能力时再写方言。** 取一条真实协议样本，在 `src/plugins/agents/enhancements/<厂商>/` 中实现翻译。私有通知用 `translateNotification`，需要答复的私有请求用 `serverRequestHandlers`，给标准事件补字段用 `enhanceEvent`。只认领本厂商定义的内容。[接口定义](../src/contracts/agentAdapter.ts)
3. **注册并做对照验证。** 为新 Agent 分配稳定 ID，在其适配器中提供 `createDialect`，加入内置注册表。分别以新适配器和通用自定义配置运行同一份样本：两边都应能完成标准对话，只有选中新适配器时才出现专有增强。[隔离测试](../tests/agents/dialectWireIsolation.test.ts) · [能力覆盖矩阵](../../docs/acp-coverage-matrix.md)
