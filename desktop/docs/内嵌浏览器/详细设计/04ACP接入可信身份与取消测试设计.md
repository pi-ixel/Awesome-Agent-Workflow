# ACP 接入、可信身份与取消测试设计

## 文档控制

| 项目 | 内容 |
|---|---|
| 文档编号 | AAW-DSK-BR-TD-004 |
| 版本 | 1.0 |
| 状态 | 已基线 |
| 最近更新 | 2026-11-11 |
| 对应详设 | `04ACP接入可信身份与取消详设.md` |
| 测试目标 | ACP 注册、端点身份、父子 Agent、主动取消、重连和切换 |
| 核心验收 | AC-006、AC-009、AC-011、AC-017、AC-018、AC-022、AC-023、AC-024 |

## 1. 测试策略

使用两个真实 ACP 会话、每会话独立 HTTP MCP 端点和真实浏览器页面验证身份。黑盒测试只使用外部 ACP/MCP 客户端；装配测试使用公共会话注册和运行时入口，禁止 Mock，但不将注册表快照冒充持久化数据层；单元测试覆盖映射、生命周期和取消分类；手工测试使用 DeskPilot 验证真实用户操作。

所有断言先用字段、集合、状态和页面证据描述；非手工用例还必须同时提供文末的具体断言代码。断言值必须直接来自公开入口返回值、原始响应或持久化数据，禁止中间转换或聚合。

## 2. 测试前提与数据

- 准备会话 A/B、对应 MCP 端点、可记录身份的 MCP 测试工具和长等待工具。
- 准备父子 Agent 场景、可取消轮次和可重连运行时。
- 外部测试客户端不能读取内部身份注册实现。
- 记录 ACP/MCP 消息、端点分配、会话归属、请求阶段、取消结果和页面副作用。

## 3. 手工测试

| 用例 | 测试场景 | 前提 | 测试步骤 | 可验证的预期结果 | DeskPilot 覆盖 |
|---|---|---|---|---|---|
| TD-04-M01 | 双会话真实 Agent 隔离 | A/B 均有独立 Agent 会话 | 在 A 打开页面；在 B 执行浏览器任务；切回 A 查看 | B 无法看到或操作 A；两边页面、工具卡和截图均归属正确 | 是 |
| TD-04-M02 | 用户接管触发直接取消 | Agent 正在执行持续浏览器动作 | 用户直接在页面输入或点击 | Agent 未决动作停止，控制状态变为用户，页面无后续自动操作 | 是 |
| TD-04-M03 | 关闭 Agent 开关取消既有请求 | 开关已开启且存在未决请求 | 在设置中关闭 Agent 浏览器控制 | 新旧会话均不能使用工具；未决请求取消；人工页面保持 | 是 |
| TD-04-M04 | Agent 切换后的可见行为 | 原 Agent 已绑定浏览器 | 切换到另一 Agent 或重连；观察页面与工具状态 | 旧绑定失效，新 Agent 需重新发现；人工页面不关闭 | 是 |
| TD-04-M05 | 子 Agent 结束后页面保留 | 父会话允许子 Agent 使用浏览器 | 让子 Agent 创建页面并结束；观察父会话 | 页面归属父会话且仍保留，子 Agent 后续调用被拒绝 | 部分，父子任务可由测试工具驱动 |

## 4. 黑盒测试

| 用例 | 测试场景 | 前提 | 测试步骤 | 预期结果 | 断言规范 | DeskPilot 覆盖 |
|---|---|---|---|---|---|---|
| TD-04-B01 | 双端点身份不可混淆 | A/B 端点均可调用身份工具 | 分别调用身份工具；比较结果与分配记录 | A 返回 A，B 返回 B；即使请求 ID 相同也不串结果 | 返回身份与各自端点注册相等；来源为外部 MCP 响应 | 不需要 |
| TD-04-B02 | 模型参数不能伪造身份 | 使用 A 端点 | 在参数中填写 B 的会话和标签信息 | 调用仍归属 A 或被拒绝；B 无副作用 | 实际会话与 A 端点相等；B 页面动作计数不变 | 不需要 |
| TD-04-B03 | 未登记子 Agent | 父会话存在但未登记子 Agent | 使用未登记子身份发起浏览器调用 | 请求被拒绝且父页面无变化 | 错误分类为未登记或拒绝；父页面无副作用 | 不需要 |
| TD-04-B04 | ACP 取消后的直接运行时取消 | 长等待请求已开始 | 通过 ACP 取消轮次；观察 MCP 和运行时 | AAW 直接取消未决请求，不依赖 Agent 发送 MCP 取消 | 运行时请求状态为取消；取消来源正确；等待未正常完成 | 不需要 |
| TD-04-B05 | 已下发动作取消 | 页面记录动作执行阶段 | 在动作下发后取消；读取页面和工具结果 | 结果为不确定或已完成，与实际一致；不虚假无副作用 | 副作用字段与页面证据一致；终态不被覆盖 | 不需要 |
| TD-04-B06 | 旧端点在切换后失效 | 旧 Agent 会话端点有效 | 切换 Agent 或重连；使用旧端点调用 | 返回失效，不进入新会话或新代次 | 错误分类为失效；新会话无副作用 | 不需要 |
| TD-04-B07 | 不支持的 Agent 能力 | 使用不支持 HTTP MCP 的配置 | 创建会话并读取能力 | 明确不支持，人工浏览器空间不被误删 | MCP 能力为不支持；人工页面存在；无假工具调用 | 部分，可由界面观察 |

## 5. 装配测试

I01～I06 及后述补充场景均为 `[装配]`：端点和连接代次按详设只保存在原生注册表，不为此新增持久化数据库。实现类以 `Assembly` 命名且不得添加 `integration` 标记；用例编号中的 I 是稳定标识，不代表测试层级。

| 用例 | 测试场景 | 前提 | 测试步骤 | 预期结果 | 断言规范 | DeskPilot 覆盖 |
|---|---|---|---|---|---|---|
| TD-04-I01 | ACP 创建时注册唯一 MCP | 使用公共会话组装入口 | 创建 A/B；读取会话配置和端点注册 | 服务名称、端点和映射均按会话唯一，无缓存合并 | 两个端点不相等；映射到正确会话；工具集合符合能力 | 不需要 |
| TD-04-I02 | 子 Agent 继承父身份 | 父会话已建立 | 登记子 Agent；创建页面；结束子 Agent | 子使用父浏览器空间；结束后子请求失效，父页面保留 | 子/父 browserId 相等；子请求拒绝；父标签集合不变 | 不需要 |
| TD-04-I03 | 取消按轮次精确作用 | 同会话有两个轮次或请求 | 取消目标轮次；观察其他请求 | 仅目标轮次未决请求取消，其他请求不受影响 | 取消集合与目标请求集合相等；范围外状态不变 | 不需要 |
| TD-04-I04 | 用户接管只取消当前标签 | 同会话两个标签均有 Agent 动作 | 在一个标签执行用户输入 | 该标签取消并归用户；另一标签按策略继续，不受影响 | 两标签控制与请求状态分别符合预期 | 部分，可由 DeskPilot 输入 |
| TD-04-I05 | 关闭会话撤销身份 | 会话存在未决请求和子 Agent | 关闭父会话；随后调用父/子端点 | 新调用被拒绝；未决请求取消；端点和子登记均失效 | 端点生命周期为撤销；父子请求无页面副作用 | 不需要 |
| TD-04-I06 | 重连不回收其他同项目会话 | A/B 同工作区但运行时不同 | 重连 A；检查 B 的连接和页面 | A 换代，B 的连接、页面和请求不因共享 cwd 被回收 | A 新代次大于旧值；B 状态与代次不变 | 不需要 |

## 6. 单元测试

| 用例 | 测试场景 | 前提 | 测试步骤 | 预期结果 | 断言规范 |
|---|---|---|---|---|---|
| TD-04-U01 | 端点映射 | 准备有效、未知、撤销和换代端点数据 | 执行身份路由函数 | 有效端点返回正确会话，其余拒绝或失效 | 映射结果与注册表预期一致 |
| TD-04-U02 | 服务名称与缓存唯一性 | 准备两个会话的配置 | 生成 MCP 服务名称和端点 | 两个配置均唯一，不因相同工具而共享缓存身份 | 服务名称及端点两两不同 |
| TD-04-U03 | 子 Agent 父映射 | 准备父子登记和伪造子身份 | 执行归属解析 | 真实子映射父；伪造或失效子拒绝 | 归属结果与登记关系一致 |
| TD-04-U04 | 取消范围展开 | 准备请求、标签、轮次、会话和全局取消 | 计算目标请求集合 | 仅展开属于范围的未决请求，不混入其他请求 | 目标集合与预期一致 |
| TD-04-U05 | 取消副作用分类 | 准备未下发、审批、执行中、已完成和断开场景 | 生成取消结果 | 每类副作用语义与实际阶段一致 | 终态和副作用字段与矩阵一致 |
| TD-04-U06 | 完成与取消竞态 | 准备不同事件顺序 | 依次应用完成和取消事件 | 已完成不被迟到取消覆盖，取消过晚有记录 | 最终状态与真实事件顺序一致 |
| TD-04-U07 | 重连代次失效 | 准备旧连接请求和事件 | 增加连接代次后处理旧数据 | 旧数据被拒绝，新连接可接受新请求 | 旧请求状态为失效；新请求状态正常 |

## 7. 覆盖、证据与退出准则

- 身份与隔离：TD-04-M01、B01、B02、I01、U01、U02。
- 父子 Agent：TD-04-M05、B03、I02、U03。
- 取消与用户接管：TD-04-M02、M03、B04、B05、I03、I04、U04～U06。
- 切换与重连：TD-04-M04、B06、I06、U07。
- 关闭清理：TD-04-I05。

必须保存双会话协议记录、端点映射、请求阶段、页面副作用和真实截图。任何身份混淆、跨会话成功、取消后虚假无副作用、旧端点生效或重连误回收同项目其他会话均为阻断失败。


## 8. 非手工用例断言代码

以下断言使用 Vitest。变量在测试步骤完成后绑定到 ACP/MCP 响应、端点注册、请求状态、页面记录或函数输出。

### 8.1 黑盒断言代码

```typescript
// TD-04-B01
expect(identityA.sessionId).toBe(endpointRegistrationA.sessionId);
expect(identityB.sessionId).toBe(endpointRegistrationB.sessionId);
expect(identityA.sessionId).not.toBe(identityB.sessionId);

// TD-04-B02
expect(actualContext.sessionId).toBe(endpointA.sessionId);
expect(sessionBPage.actionCount).toBe(0);
expect(forgedResponse.error).toBeUndefined();

// TD-04-B03
expect(response.error.code).toBe("SUBAGENT_NOT_REGISTERED");
expect(parentPage.actionCount).toBe(0);

// TD-04-B04
expect(runtimeRequest.status).toBe("cancelled");
expect(runtimeRequest.cancelSource).toBe("aaw-direct");
expect(runtimeRequest.waitCompleted).toBe(false);
expect(mcpResult.sideEffect).toBe("none");

// TD-04-B05
expect(mcpResult.sideEffect).toBe(pageEvidence.sideEffect);
expect(mcpResult.status).toBe(pageEvidence.expectedStatus);
expect(pageEvidence.rollbackClaimed).toBe(false);

// TD-04-B06
expect(response.error.code).toBe("ENDPOINT_INVALIDATED");
expect(newSessionPage.actionCount).toBe(0);

// TD-04-B07
expect(capabilities.httpMcp).toBe(false);
expect(manualSpace.lifecycle).toBe("ready");
expect(toolCallCount).toBe(0);
```

### 8.2 装配断言代码

```typescript
// TD-04-I01 [装配]
expect(registrationA.endpointId).not.toBe(registrationB.endpointId);
expect(registrationA.serviceName).not.toBe(registrationB.serviceName);
expect(registrationA.sessionId).toBe(sessionA.id);
expect(registrationB.sessionId).toBe(sessionB.id);
expect(registrationA.tools).toEqual(expectedToolsA);
expect(registrationB.tools).toEqual(expectedToolsB);

// TD-04-I02 [装配]
expect(childSpace.browserId).toBe(parentSpace.browserId);
expect(childSpace.sessionId).toBe(parentSpace.sessionId);
expect(childAfterClose.error.code).toBe("REGISTRATION_CLOSED");
expect(parentTabsAfter).toEqual(parentTabsBefore);

// TD-04-I03 [装配]
expect(cancelledRequestIds).toEqual(targetTurnPendingIds);
expect(otherRequests).toEqual(otherRequestsBefore);

// TD-04-I04 [装配]
expect(targetTab.controller).toBe("user");
expect(targetTab.pendingAgentRequests).toEqual([]);
expect(otherTab).toEqual(otherTabBefore);

// TD-04-I05 [装配]
expect(endpointAfterClose.lifecycle).toBe("revoked");
expect(childRegistrationAfterClose.lifecycle).toBe("revoked");
expect(parentCall.error.code).toBe("ENDPOINT_INVALIDATED");
expect(childCall.error.code).toBe("ENDPOINT_INVALIDATED");
expect(pageSnapshot.actionCountAfterClose).toBe(0);

// TD-04-I06 [装配]
expect(sessionA.connectionGeneration).toBeGreaterThan(oldSessionAGeneration);
expect(sessionB).toEqual(sessionBBefore);
```

### 8.3 单元断言代码

```typescript
// TD-04-U01
expect(validEndpointResult.sessionId).toBe(expectedSessionId);
expect(unknownEndpointResult.error.code).toBe("ENDPOINT_UNKNOWN");
expect(revokedEndpointResult.error.code).toBe("ENDPOINT_INVALIDATED");
expect(staleEndpointResult.error.code).toBe("CONNECTION_STALE");

// TD-04-U02
expect(configA.serviceName).not.toBe(configB.serviceName);
expect(configA.endpointId).not.toBe(configB.endpointId);
expect(configA.cacheIdentity).not.toBe(configB.cacheIdentity);

// TD-04-U03
expect(registeredChild.parentSessionId).toBe(parentSessionId);
expect(forgedChild.error.code).toBe("SUBAGENT_NOT_REGISTERED");
expect(expiredChild.error.code).toBe("REGISTRATION_CLOSED");

// TD-04-U04
expect(actualTargetRequestIds).toEqual(expectedPendingIds);
expect(actualTargetRequestIds).not.toContain(outsideRequestId);

// TD-04-U05
expect(actualCancellationResults).toEqual(expectedCancellationMatrix);

// TD-04-U06
expect(completedFirst.status).toBe("completed");
expect(completedFirst.lateCancelRecorded).toBe(true);
expect(cancelledFirst.status).toBe("cancelled");
expect(cancelledFirst.sideEffect).toBe(expectedSideEffect);

// TD-04-U07
expect(oldRequestResult.error.code).toBe("CONNECTION_STALE");
expect(newRequestResult.error).toBeUndefined();
```


## 9. 重连与子 Agent 取消交叉用例

### 9.1 黑盒用例

| 用例 | 测试场景 | 测试前提 | 测试步骤 | 测试预期结果 | 断言代码（断什么/由什么直出） | DeskPilot 覆盖 |
|---|---|---|---|---|---|---|
| TD-04-B08 | ACP 重连×执行中 MCP×迟到响应 | 会话 A 有执行中请求，会话 B 有独立页面 | 重连 A；让旧 MCP 请求在新代次建立后迟到完成；再用新端点调用 | 旧请求失效或取消；迟到结果不能写入新代次；B 不受影响；新请求真实执行 | 直接断言旧请求、迟到响应处置、新页面动作计数和 B 快照；代码见下 | 不需要 |
| TD-04-B09 | 子 Agent×共享父端点×取消传播 | 父端点登记两个子 Agent，各有未决请求 | 取消父轮次；让子请求迟到完成；读取另一子请求和父页面 | 仅父轮次范围内的子请求取消；范围外子请求不受影响；迟到副作用不伪装成成功 | 直接断言取消结果、子迟到响应、范围外请求和页面记录；代码见下 | 不需要 |

### 9.2 装配用例

| 用例 | 测试场景 | 测试前提 | 测试步骤 | 测试预期结果 | 断言代码（断什么/由什么直出） | DeskPilot 覆盖 |
|---|---|---|---|---|---|---|
| TD-04-I07 [装配] | 重连代次×旧请求×新请求 | 公共 ACP 注册入口和真实 MCP 页面可用 | 建立旧请求；重连；提交旧迟到事件和新请求；读取请求记录 | 连接代次递增；旧请求终态不被迟到完成覆盖；新请求归属新代次 | 直接断言连接、旧请求、迟到处置和新请求记录；代码见下 | 不需要 |
| TD-04-I08 [装配] | 父取消×子请求×共享空间 | 父子登记与两个子请求已建立 | 通过公共取消入口取消父轮次；注入子迟到事件；读取各请求 | 目标子请求取消；其他子请求保持原状态；父空间不关闭 | 直接断言目标/范围外请求、迟到事件和父空间；代码见下 | 不需要 |

```typescript
// TD-04-B08
expect(inFlightAfterReconnect.status).toBe("stale");
expect(lateResponse.status).toBe("ignored");
expect(newGenerationPage.actionCount).toBe(0);
expect(otherSessionPage).toEqual(otherSessionPageBefore);

// TD-04-B09
expect(targetChildRequest.status).toBe("cancelled");
expect(childLateResult.status).toBe("ignored");
expect(siblingRequest.status).toBe(siblingRequestBefore.status);
expect(parentPage.actionCountAfterLateResult).toBe(parentPage.actionCountBeforeLateResult);

// TD-04-I07 [装配]
expect(reconnectedSession.connectionGeneration).toBeGreaterThan(oldGeneration);
expect(oldRequestRecord.status).toBe("stale");
expect(lateMcpResult.status).toBe("ignored");
expect(newRequestRecord.connectionGeneration).toBe(reconnectedSession.connectionGeneration);
expect(newRequestRecord.status).toBe("completed");

// TD-04-I08 [装配]
expect(targetChildRequest.status).toBe("cancelled");
expect(otherChildRequest).toEqual(otherChildRequestBefore);
expect(childLateEvent.status).toBe("ignored");
expect(parentSpace.lifecycle).toBe("ready");
```

## 10. 交叉面清单

| 触及对象 | 所有其他写入者、读取者与超时点 | 覆盖用例或豁免理由 |
|---|---|---|
| 端点身份注册表 | 写入：ACP 创建、关闭、Agent 切换；读取：MCP 每次调用、UI 能力；超时点：撤销和旧端点 | TD-04-B01、B02、B06、I01、I05、U01、U02 |
| ACP 连接代次 | 写入：重连、切换、主窗口刷新；读取：MCP 请求、取消、UI；超时点：执行中请求和迟到响应 | TD-04-I06、U07；交叉覆盖 TD-04-B08、I07、TD-08-B10 |
| 父子 Agent 登记 | 写入：父运行时、子结束、父关闭；读取：身份路由、取消展开；超时点：失效子请求 | TD-04-M05、B03、I02、U03；交叉覆盖 TD-04-B09、I08 |
| 轮次—请求关联 | 写入：ACP 轮次、MCP 请求；读取：直接取消、诊断；超时点：轮次取消和请求完成竞态 | TD-04-B04、I03、U04～U06 |
| 取消注册表 | 写入：用户接管、ACP 取消、全局开关、会话关闭；读取：运行时和 MCP；超时点：已下发动作和迟到结果 | TD-04-M02、M03、B04、B05、I04、I05；TD-09-B09 |
| 共享 MCP 底层连接 | 写入：ACP 适配缓存、重连；读取：主/子 Agent 和多会话；超时点：相同配置连接复用 | TD-04-I01、I06；身份必须由端点注册而非连接对象判定 |
| 父浏览器空间 | 写入：父/子 Agent、用户、清理；读取：MCP、UI、数据分区；超时点：子结束和父取消 | TD-04-I02、I08；TD-01-I04 |
| 注册表持久化 | 写入/读取：无；超时点：不适用 | 豁免：DD-04 明确使用单桌面原生注册表且不引入持久化令牌数据库；因此本文全部为装配，不伪造集成断言 |
