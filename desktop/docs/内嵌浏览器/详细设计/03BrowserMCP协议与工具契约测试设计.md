# Browser MCP 协议与工具契约测试设计

## 文档控制

| 项目 | 内容 |
|---|---|
| 文档编号 | AAW-DSK-BR-TD-003 |
| 版本 | 1.1 |
| 状态 | 待复审 |
| 最近更新 | 2026-11-12 |
| 对应详设 | `03BrowserMCP协议与工具契约详设.md` |
| 测试目标 | MCP 生命周期、工具参数、结果、错误、文档、图片和兼容性 |
| 核心验收 | AC-002、AC-003、AC-009、AC-012、AC-015、AC-016、AC-019、AC-023、AC-024 |

## 修订记录

| 版本 | 日期 | 修订原因 | 修订内容 |
|---|---|---|---|
| 1.1 | 2026-11-12 | 浏览器操作身份只由会话端点决定，不再存在父子登记写入者 | 更新交叉面清单，保留工具协议、跨会话身份和失效验证。 |

## 1. 测试策略

黑盒维度是本文重点，所有协议测试使用独立外部 MCP 客户端，不引用业务代码或方法。集成与装配测试使用真实 HTTP MCP、公共运行时入口和真实页面，禁止 Mock；仅持久化数据断言可标记为集成。单元测试覆盖参数校验、文档生成、错误映射和兼容规则。手工维度验证真实 Agent 对话、工具卡和结果可读性。

断言规范以数据字段、集合、状态和外部证据描述；非手工用例还必须同时提供文末的具体断言代码。断言值必须由返回值、原始响应正文或持久化数据直接产出，禁止中间转换或聚合。

## 2. 测试前提与数据

- 准备独立 MCP 客户端、真实 AAW 会话、两个浏览器空间和本地测试页面。
- 准备合法/非法参数、旧版合法样本、未知工具和不支持图片的 Agent 配置。
- 外部客户端只能知道测试分配的端点，不读取内部注册代码。
- 记录协议请求、响应、运行时操作、页面事实、图片产物和日志。

## 3. 手工测试

| 用例 | 测试场景 | 前提 | 测试步骤 | 可验证的预期结果 | DeskPilot 覆盖 |
|---|---|---|---|---|---|
| TD-03-M01 | 真实 Agent 工具闭环 | 当前 Agent 支持 MCP 和图片 | 要求 Agent 打开页面、读取 DOM、输入、点击并截图 | 工具卡顺序与页面行为一致；最终截图可见；无手工调用私有命令 | 是 |
| TD-03-M02 | 错误恢复说明可读 | 页面存在重复按钮 | 要求 Agent 点击模糊目标 | 工具卡显示歧义而非点击第一个；恢复说明要求增加约束 | 是 |
| TD-03-M03 | 不支持图片的诚实反馈 | Agent 无图片能力 | 执行截图并查看工具卡和回复 | 用户可见图片产物；Agent 明确未读图；不以占位文本冒充图片理解 | 是 |
| TD-03-M04 | 不支持工具不出现 | 当前运行时禁用部分能力 | 让 Agent 查看可用工具并尝试相关任务 | 未发布能力不出现在有效文档；界面解释实际可用范围 | 是 |

## 4. 黑盒测试

| 用例 | 测试场景 | 前提 | 测试步骤 | 预期结果 | 断言规范 | DeskPilot 覆盖 |
|---|---|---|---|---|---|---|
| TD-03-B01 | 初始化与工具发现 | 使用有效会话端点 | 外部客户端初始化；发送初始化完成；发现工具 | 协议能力和工具清单与真实能力一致 | 初始化状态为就绪；工具集合等于公开有效集合；来源为 MCP 响应 | 不需要 |
| TD-03-B02 | 未初始化调用 | 新连接尚未初始化 | 直接调用工具 | 调用被拒绝且页面无副作用 | 错误分类为协议未就绪；页面动作计数不变 | 不需要 |
| TD-03-B03 | 未知方法和工具 | 已初始化 | 调用未知方法和未知工具 | 返回不支持，不泄漏堆栈或内部字段 | 错误分类为不支持；敏感字段集合为空；页面无副作用 | 不需要 |
| TD-03-B04 | 参数校验 | 已初始化且页面可用 | 分别提交缺失、错误类型、空值、非法枚举、未知字段和超限参数 | 每种非法输入均返回参数错误，不执行页面动作 | 错误字段类别与输入一致；页面动作计数为零 | 不需要 |
| TD-03-B05 | 只读工具无状态变更 | 本地页面有操作计数 | 执行发现、状态、快照、定位和截图 | 返回页面事实，无点击、输入或提交等状态变更 | 状态变更计数为零；返回字段与页面事实一致 | 不需要 |
| TD-03-B06 | 取消与副作用结果 | 页面支持长等待和已下发动作 | 分别在动作前和动作后取消 | 动作前为无副作用；动作后按实际情况为完成或不确定 | 取消状态与副作用字段符合页面证据；不虚假回滚 | 不需要 |
| TD-03-B07 | 端点撤销 | 会话已建立 MCP 连接 | 关闭会话或切换 Agent；使用旧端点再次调用 | 旧端点失效，不能进入新会话或新代次 | 错误分类为失效；新会话状态不变；来源为外部响应 | 不需要 |
| TD-03-B08 | 图片外部结果 | 页面可截图 | 调用截图；读取模型图片和产物引用 | 图片非空、类型正确、产物来源匹配；历史只保留引用 | 图片大小在预算内；产物元数据与会话/标签/请求一致；历史不包含 Base64 正文 | 不需要 |

## 5. 集成与装配测试

I04、I06 为 `[集成]`，最终断言来自历史记录、证据或真实文件；I01～I03、I05、I07～I09 均为 `[装配]`，实现类以 `Assembly` 命名且不得添加 `integration` 标记。用例编号中的 I 是稳定标识，不代表测试层级。

| 用例 | 测试场景 | 前提 | 测试步骤 | 预期结果 | 断言规范 | DeskPilot 覆盖 |
|---|---|---|---|---|---|---|
| TD-03-I01 | 工具到页面真实路由 | 使用真实 MCP 和公共运行时 | 调用导航、快照、输入、点击和截图 | 每项结果对应同一标签真实页面，状态与证据一致 | 会话/标签/代次在各响应和状态数据中一致；页面后置条件满足 | 不需要 |
| TD-03-I02 | 有效文档与运行时一致 | 当前实例有部分能力限制 | 生成文档；逐项调用发布能力；尝试未发布能力 | 发布能力真实可用，未发布能力明确不支持 | 文档集合与可用集合相等；无必然失败占位 | 不需要 |
| TD-03-I03 | 错误跨层映射 | 可触发未找到、歧义、失效、超时和取消 | 逐项触发并读取 MCP 与运行时记录 | 公共分类和恢复语义一致，操作 ID 贯穿 | 错误映射与预期一致；敏感载荷不存在；操作 ID 一致 | 不需要 |
| TD-03-I04 | 结果与证据持久化 | 已完成截图和动作 | 读取当前会话、重启历史、删除产物后再读取 | 当前与历史状态一致；历史只存引用；删除后明确不可用 | 历史产物 ID 相等；历史无 Base64；失效状态正确 | 不需要 |
| TD-03-I05 | 版本兼容 | 保存旧版合法调用样本 | 在当前实现执行旧样本；执行破坏性变更校验 | 合法旧样本行为不变；破坏性变更不会被静默接受 | 兼容结果与契约规则一致；无默认身份或权限回退 | 不需要 |

## 6. 单元测试

| 用例 | 测试场景 | 前提 | 测试步骤 | 预期结果 | 断言规范 |
|---|---|---|---|---|---|
| TD-03-U01 | 参数模式校验 | 准备所有工具的合法和非法输入矩阵 | 执行参数校验函数 | 合法通过，非法返回对应字段类别，未知字段被拒绝 | 校验结果矩阵与预期一致 |
| TD-03-U02 | 错误映射 | 准备所有运行时错误和副作用状态 | 转换为 MCP 结果 | 分类、恢复建议和副作用语义保持 | 映射结果与契约表一致 |
| TD-03-U03 | 能力交集 | 准备运行时与 Agent 的不同能力组合 | 生成有效工具和文档 | 仅双方真实支持的能力被发布；不支持原因明确 | 工具集合等于预期交集；降级说明存在 |
| TD-03-U04 | 空态生成 | 无浏览器、无标签或无对话框 | 调用对应读取工具 | 返回明确空态而非错误或伪造对象 | 空集合或空态标识正确；无虚构 ID |
| TD-03-U05 | 快照与图片预算 | 准备超大快照、图片和文本 | 执行结果预算处理 | 节点、文本和图片均按规则截断或派生，标记不可隐瞒 | 大小和截断标记符合预算；无空图片 |
| TD-03-U06 | 历史内容投影 | 准备包含图片和文本的工具结果 | 生成历史快照 | 只保存图片产物引用与必要文本，不保存 Base64 | 历史字段集合和引用值符合预期 |
| TD-03-U07 | 兼容性分类 | 准备可选新增、必填新增、枚举变更和工具删除 | 执行契约兼容校验 | 仅兼容变更通过，其余进入破坏性变更结果 | 兼容分类与预期一致 |

## 7. 覆盖、证据与退出准则

- 协议与参数：TD-03-B01～B04、U01。
- 只读、取消和错误：TD-03-B05、B06、I03、U02。
- 文档与能力：TD-03-M04、I02、U03、U04。
- 图片与历史：TD-03-M01、M03、B08、I04、U05、U06。
- 失效与兼容：TD-03-B07、I05、U07。

保存完整外部 MCP 记录、页面结果、工具卡截图、错误映射、图片产物和历史快照。任何未知调用假成功、未授权字段生效、无效能力发布、图片占位冒充已读或取消后虚报无副作用均为阻断失败。


## 8. 非手工用例断言代码

以下断言使用 Vitest。变量在测试步骤完成后绑定到外部响应、页面记录、状态快照、历史数据或函数输出。

### 8.1 黑盒断言代码

```typescript
// TD-03-B01
expect(initializeResult.lifecycle).toBe("ready");
expect(listToolsResult.tools).toEqual(effectiveContract.tools);
expect(initializeResult.capabilities).toEqual(effectiveContract.mcpCapabilities);

// TD-03-B02
expect(response.error.code).toBe("MCP_NOT_INITIALIZED");
expect(pageRecord.actionCount).toBe(0);

// TD-03-B03
expect(unknownMethod.error.code).toBe("METHOD_NOT_SUPPORTED");
expect(unknownTool.error.code).toBe("TOOL_NOT_SUPPORTED");
expect(unknownMethodRawBody).not.toContain(secretMarker);
expect(unknownToolRawBody).not.toContain(secretMarker);

// TD-03-B04
expect(missingArgument.error.code).toBe("MISSING_ARGUMENT");
expect(wrongTypeArgument.error.code).toBe("INVALID_ARGUMENT_TYPE");
expect(nullArgument.error.code).toBe("INVALID_ARGUMENT_TYPE");
expect(invalidEnumArgument.error.code).toBe("INVALID_ARGUMENT_VALUE");
expect(unknownArgument.error.code).toBe("UNKNOWN_ARGUMENT");
expect(overLimitArgument.error.code).toBe("ARGUMENT_LIMIT_EXCEEDED");
expect(pageRecord.actionCount).toBe(0);

// TD-03-B05
expect(pageRecord.stateChangeCount).toBe(0);
expect(response.facts).toEqual(expectedPageFacts);
expect(response.evidence.artifactId).toBeTruthy();

// TD-03-B06
expect(beforeDispatch.status).toBe("cancelled");
expect(beforeDispatch.sideEffect).toBe("none");
expect(afterDispatch.sideEffect).toBe(expectedObservedSideEffect);
expect(afterDispatch.status).toBe(expectedObservedStatus);

// TD-03-B07
expect(response.error.code).toBe("ENDPOINT_INVALIDATED");
expect(newSessionSnapshot).toEqual(newSessionBefore);

// TD-03-B08
expect(response.image.byteLength).toBeGreaterThan(0);
expect(response.image.byteLength).toBeLessThanOrEqual(imageBudgetBytes);
expect(response.evidence.sessionId).toBe(expectedEvidence.sessionId);
expect(response.evidence.tabId).toBe(expectedEvidence.tabId);
expect(historySnapshot).not.toHaveProperty("base64");
expect(historySnapshot.artifactId).toBe(response.evidence.artifactId);
```

### 8.2 集成与装配断言代码

```typescript
// TD-03-I01 [装配]
expect(navigationResult.sessionId).toBe(targetSessionId);
expect(snapshotResult.sessionId).toBe(targetSessionId);
expect(inputResult.tabId).toBe(targetTabId);
expect(clickResult.tabId).toBe(targetTabId);
expect(screenshotResult.tabGeneration).toBe(currentGeneration);
expect(finalPage.postconditions).toEqual(expectedPostconditions);

// TD-03-I02 [装配]
expect(documentedTools).toEqual(availableTools);
expect(unpublishedResponse.error.code).toBe("TOOL_NOT_SUPPORTED");
expect(publishedNavigation.error).toBeUndefined();
expect(publishedSnapshot.error).toBeUndefined();
expect(publishedScreenshot.error).toBeUndefined();

// TD-03-I03 [装配]
expect(notFoundResult.error.code).toBe("NOT_FOUND");
expect(ambiguousResult.error.code).toBe("AMBIGUOUS_TARGET");
expect(staleResult.error.code).toBe("STALE_GENERATION");
expect(timeoutResult.error.code).toBe("TIMEOUT");
expect(cancelledResult.error.code).toBe("CANCELLED");
expect(notFoundResult.operationId).toBe(notFoundOperationId);
expect(ambiguousResult.operationId).toBe(ambiguousOperationId);
expect(staleResult.operationId).toBe(staleOperationId);
expect(timeoutResult.operationId).toBe(timeoutOperationId);
expect(cancelledResult.operationId).toBe(cancelledOperationId);
expect(rawMcpResponseText).not.toContain(secretMarker);
expect(rawRuntimeLogText).not.toContain(secretMarker);

// TD-03-I04 [集成：历史记录与证据文件]
expect(currentEvidence.artifactId).toBe(originalEvidence.artifactId);
expect(restoredEvidence.artifactId).toBe(originalEvidence.artifactId);
expect(restoredEvidence).not.toHaveProperty("base64");
expect(deletedEvidence.status).toBe("unavailable");

// TD-03-I05 [装配]
expect(legacyNavigationResult.error).toBeUndefined();
expect(legacySnapshotResult.error).toBeUndefined();
expect(breakingChangeResult.compatibility).toBe("breaking");
expect(breakingChangeResult.acceptedByDefault).toBe(false);
```

### 8.3 单元断言代码

```typescript
// TD-03-U01
expect(actualValidationMatrix).toEqual(expectedValidationMatrix);
expect(unknownFieldResult.error.code).toBe("UNKNOWN_ARGUMENT");

// TD-03-U02
expect(actualMappings).toEqual(expectedErrorMappings);

// TD-03-U03
expect(generated.tools).toEqual(expectedCapabilityIntersection);
expect(generated.degradations).toEqual(expectedDegradations);

// TD-03-U04
expect(noBrowser.browsers).toEqual([]);
expect(noTabs.tabs).toEqual([]);
expect(noDialog.dialog).toBeNull();

// TD-03-U05
expect(result.nodeCount).toBeLessThanOrEqual(nodeBudget);
expect(result.textLength).toBeLessThanOrEqual(textBudget);
expect(result.imageBytes).toBeLessThanOrEqual(imageBudget);
expect(result.truncated).toBe(true);
expect(result.emptyImage).toBe(false);

// TD-03-U06
expect(history.artifactId).toBe(originalEvidence.artifactId);
expect(history).not.toHaveProperty("base64");
expect(history.text).toBe(expectedText);

// TD-03-U07
expect(actualCompatibility).toEqual(expectedCompatibilityMatrix);
```


## 9. P1 文件、诊断读取与高权限补充用例

### 9.1 手工补充用例

| 用例 | 测试场景 | 前提 | 测试步骤 | 预期结果 | DeskPilot 覆盖 |
|---|---|---|---|---|---|
| TD-03-M05 | 文件、脚本与坐标权限 | 准备虚拟文件、上传控件、受限脚本和 Canvas 坐标目标 | 分别执行上传、下载、脚本和坐标操作；检查审批；取消一次 | 审批绑定文件/目标/动作；下载不自动执行；坐标使用最近截图；取消后无未说明副作用 | 部分，系统文件选择器可由 DeskPilot 操作；原生限制需标注 |

### 9.2 黑盒补充用例

| 用例 | 测试场景 | 前提 | 测试步骤 | 预期结果 | 断言规范 | DeskPilot 覆盖 |
|---|---|---|---|---|---|---|
| TD-03-B09 | 上传绑定具体文件与动作 | 本地虚拟文件和上传控件已准备 | 未批准、批准、更换文件后分别执行上传 | 只有明确批准的文件和动作执行；更换文件使旧批准失效；无目录隐式扩展 | 未批准无副作用；批准后仅目标文件被使用；更换后旧批准失效 | 部分 |
| TD-03-B10 | 下载不自动执行且可追踪 | 页面提供虚拟下载 | 批准下载；读取保存文件和元数据 | 保存位置、来源和状态可见；文件内容正确；没有执行下载对象 | 文件内容等于预期；元数据字段一致；无下载执行进程 | 部分 |
| TD-03-B11 | 控制台与网络最小读取 | 页面产生控制台错误和网络失败 | 读取当前标签错误；检查载荷 | 只含有界类型、级别、摘要、脱敏来源、方法和状态；无 Cookie、正文或敏感头 | 字段集合符合契约；秘密不存在；截断与归属正确 | 不需要 |
| TD-03-B12 | 脚本与坐标高权限约束 | 准备受限脚本和坐标目标 | 无审批执行；批准后执行；改变缩放或代次后使用旧坐标 | 无审批拒绝；批准仅执行当前目标；旧坐标失效；无原始 CDP/Node 入口 | 未批准无副作用；批准后结果正确；旧坐标失效；工具清单无禁止入口 | 不需要 |

### 9.3 集成与装配补充用例

| 用例 | 测试场景 | 前提 | 测试步骤 | 预期结果 | 断言规范 | DeskPilot 覆盖 |
|---|---|---|---|---|---|---|
| TD-03-I06 | 文件权限与真实文件结果 | 使用公共文件工具和真实文件系统 | 执行上传、取消、下载和更换文件 | 文件、审批、会话、标签和结果一致；取消无未说明副作用 | 文件记录与审批字段一致；取消结果正确；实际文件内容符合预期 | 部分 |
| TD-03-I07 | 诊断读取的归属与脱敏 | 当前页面产生控制台和网络错误 | 读取并检查运行时、MCP 和日志数据 | 三处归属一致；敏感载荷不存在；数量与文本预算生效 | 会话/标签一致；秘密不存在；截断标记正确 | 不需要 |
| TD-03-I08 | 坐标证据与缩放失效 | 使用真实截图和坐标目标 | 批准后执行；改变页面缩放；再次使用旧截图坐标 | 当前截图下目标正确；缩放后旧证据和坐标失效，无误点 | 首次目标计数为一；第二次失效；其他目标无点击 | 部分 |
| TD-03-I09 | 受限脚本审批与结果 | 使用公共受限脚本入口和真实页面 | 未批准、批准、超时和取消分别执行 | 仅有效批准执行；结果和副作用真实；取消不虚假回滚 | 各结果与页面证据一致；无越权字段或隐藏执行 | 不需要 |

### 9.4 单元补充用例

| 用例 | 测试场景 | 前提 | 测试步骤 | 预期结果 | 断言规范 |
|---|---|---|---|---|---|
| TD-03-U08 | 文件授权范围 | 准备文件、目录、目标站点、动作和更换文件数据 | 校验上传/下载授权 | 仅精确文件、站点和动作匹配；目录不隐式展开；更换失效 | 授权结果与预期矩阵一致 |
| TD-03-U09 | 诊断读取预算与脱敏 | 准备超长、多错误、敏感 URL、头和正文 | 生成控制台/网络读取结果 | 字段、数量、文本和脱敏符合预算，未知不伪造 | 输出字段与预期一致；秘密不存在；截断正确 |
| TD-03-U10 | 坐标证据有效性与换算 | 准备截图代次、缩放、区域、滚动和坐标组合 | 校验并计算坐标动作 | 只有当前截图和有效区域可用；缩放/代次变化失效；换算正确 | 有效性结果与预期一致；失效分类正确 |
| TD-03-U11 | 受限脚本边界 | 准备允许能力、原始 CDP、Node 执行和超时输入 | 校验脚本请求 | 仅明确受限能力通过；禁止入口全部拒绝；超时有界 | 校验结果与预期一致；禁止入口无执行 |

## 10. P1 补充断言代码

```typescript
// TD-03-B09
expect(unapprovedUpload.sideEffect).toBe("none");
expect(approvedUpload.fileId).toBe(targetFileId);
expect(approvedUpload.actionCount).toBe(1);
expect(replacedFileResult.error.code).toBe("APPROVAL_INVALIDATED");
expect(directoryExpansion).toEqual([]);

// TD-03-B10
expect(savedFile.content).toBe(expectedFileContent);
expect(downloadMetadata.origin).toBe(expectedOrigin);
expect(downloadMetadata.location).toBe(expectedLocation);
expect(downloadExecutionProcesses).toEqual([]);

// TD-03-B11
expect(actualDiagnosticFields).toEqual(expectedDiagnosticFields);
expect(rawDiagnosticResponseBody).not.toContain(secretMarker);
expect(diagnosticResults.truncated).toBe(expectedTruncated);
expect(diagnosticResults).toEqual(expectedDiagnosticResults);

// TD-03-B12
expect(unapprovedHighPrivilege.sideEffect).toBe("none");
expect(approvedHighPrivilege.status).toBe("completed");
expect(staleCoordinates.error.code).toBe("STALE_EVIDENCE");
expect(toolNames).not.toContain("raw_cdp");
expect(toolNames).not.toContain("node_execute");

// TD-03-I06 [集成：真实上传与下载文件]
expect(fileResult.approvalId).toBe(expectedApprovalId);
expect(fileResult.sessionId).toBe(currentSessionId);
expect(fileResult.tabId).toBe(currentTabId);
expect(fileResult.content).toBe(expectedFileContent);
expect(cancelResult.sideEffect).toBe(expectedCancelSideEffect);

// TD-03-I07 [装配]
expect(runtimeDiagnostic.sessionId).toBe(mcpDiagnostic.sessionId);
expect(runtimeDiagnostic.tabId).toBe(mcpDiagnostic.tabId);
expect(rawDiagnosticLogText).not.toContain(secretMarker);
expect(mcpDiagnostic.truncated).toBe(true);

// TD-03-I08 [装配]
expect(firstCoordinateResult.targetHits).toBe(1);
expect(staleCoordinateResult.error.code).toBe("STALE_EVIDENCE");
expect(otherTarget.hitCount).toBe(0);

// TD-03-I09 [装配]
expect(actualScriptResults).toEqual(expectedScriptResultMatrix);

// TD-03-U08
expect(actualFileAuthorizationResults).toEqual(expectedFileAuthorizationMatrix);

// TD-03-U09
expect(actualDiagnosticProjection).toEqual(expectedDiagnosticProjection);
expect(rawDiagnosticProjectionText).not.toContain(secretMarker);

// TD-03-U10
expect(actualCoordinateResults).toEqual(expectedCoordinateMatrix);

// TD-03-U11
expect(actualScriptValidationResults).toEqual(expectedScriptValidationMatrix);
```


## 11. 交叉面清单

| 触及对象 | 所有其他写入者、读取者与超时点 | 覆盖用例或豁免理由 |
|---|---|---|
| MCP 生命周期 | 写入：外部客户端初始化、断开、重连；读取：工具路由、ACP；超时点：未初始化、旧端点、迟到响应 | TD-03-B01～B03、B07；重连交叉由 TD-04-B08、I07 覆盖 |
| 工具有效清单 | 写入：运行时能力、Agent 能力、权限策略；读取：外部 Agent、UI 文档；超时点：切换 Agent 后旧文档 | TD-03-M04、B01、I02、U03 |
| 工具参数与请求 ID | 写入：外部客户端；读取：参数校验、去重、取消和诊断；超时点：重复请求、超时、取消 | TD-03-B04、B06、U01；TD-09-B09 |
| 浏览器操作身份 | 写入：端点注册、会话切换；读取：所有同会话主、子 Agent 工具；超时点：端点撤销和代次失效 | TD-03-I01；TD-04-B01、B02、B03、B06、B08 |
| MCP 错误正文 | 写入：运行时映射、MCP 适配；读取：Agent、UI、日志；超时点：超时、取消、不支持 | TD-03-B03、I03、U02；原始正文直接断言，禁止序列化转换 |
| 图片结果与证据文件 | 写入：截图、保留策略、数据清理；读取：模型、UI、历史；超时点：过期、删除、磁盘失败 | TD-03-B08、I04；故障交叉由 TD-09-B10、I10 覆盖 |
| 会话历史记录 | 写入：工具结果投影、重启恢复、清理；读取：Agent、UI；超时点：失效产物读取 | TD-03-I04、U06；TD-08-I03 |
| 文件授权与真实文件 | 写入：用户批准、更换文件、取消、下载；读取：上传控件、证据与审计；超时点：批准失效 | TD-03-B09、B10、I06、U08 |
| 诊断读取结果 | 写入：控制台、网络、脱敏与预算；读取：MCP、UI、诊断日志；超时点：截断、日志拥塞 | TD-03-B11、I07、U09；TD-09-I05 |
| 高权限脚本与坐标 | 写入：审批、缩放、滚动、frame 与代次；读取：页面、证据、审计；超时点：旧截图和旧批准 | TD-03-B12、I08、I09、U10、U11；DPI/frame 交叉由 TD-05-B09 覆盖 |
| 契约旧样本 | 写入：版本升级；读取：兼容校验与发布门禁；超时点：不适用 | TD-03-I05、U07 |
