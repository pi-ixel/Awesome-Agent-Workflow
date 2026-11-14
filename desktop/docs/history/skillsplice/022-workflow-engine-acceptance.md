# Desktop 工作流引擎验收指南

## 范围与准备

验证 Desktop、Rust 工作流服务、实际 ACP Agent 和 AAW 工作流的协作。自动化受控联调只能验证调度和接口，不能替代本指南中的真实 Agent、业务结果和界面验收。

使用独立测试项目，记录代码版本、项目路径、Agent 及配置、检查器路径和每次运行 ID。确认 Python、所选 ACP Agent 和其运行配置可用。工作流可能修改项目文件，测试前保留基线；不要在需求、运行参数或测试记录中填写凭据。

从 `desktop` 目录启动开发版：

```powershell
npm run tauri dev
```

该命令会先构建 Rust 工作流服务，再启动 Desktop。Node 用于开发构建，不是工作流服务的运行时依赖。需要完整检查链路时，配置符合项目约定的 CodeCheck Python 脚本；没有配置时，检查阶段应如实停止，不能计为完整通过。模拟检查器只可作为联调用例，其结果不能当作真实 CodeCheck 结论。

## 操作与检查

1. 在独立项目中新建会话，从主会话区打开「启动 AAW 工作流」，选择 `dev`，输入一个预期修改约 100～200 行的明确需求，填写检查器路径并启动。记录运行 ID。
2. 在主会话区处理 Agent 的问题和权限请求；右侧流程图用于观察。确认运行中的节点、状态变化和执行记录与实际行为一致，从节点打开相应会话，再从会话定位回流程图。检查后续节点可以获取前面节点已提交的成果，问答信息可通过同一运行的问题池查阅。
3. 检查实现、评审、处置、检查和交付是否达到需求及各自验收条件。并行评审应分别有自己的会话和结果；检查是否出现重复执行完整流程、漏传成果或没有证据却显示通过的情况。
4. 选择能够合理拆为多个 AR、且至少一个 AR 包含多个任务的受控需求，从 `SR` 入口运行；另用 `AR` 入口验证独立进入。观察实例在上游结果产生后创建，进入子流程并切换实例，核对各实例的输入、结果、会话及所属关系。以实际产出为准，不能为了凑数量伪造业务拆分。
5. 在隔离运行中验证失败和恢复：使用受控脚本制造失败或中断，确认记录、节点状态和界面没有显示成功。对结果不明的动作先独立核验，再按实际情况登记结果或授权重试；记录证据并确认后续执行符合核验结论。重启 Desktop 后核对运行、实例和会话关联。不要在不清楚外部副作用时直接重试。

条件分支、并行汇合、有界循环、动态实例、空清单和调度异常也应通过受控定义或自动化用例检查；真实 AAW 流程没有触发的分支应记录为「未覆盖」，不要推断通过。

## 自动化与诊断

从仓库根目录运行：

```powershell
cargo test --manifest-path desktop/workflow-engine-rs/Cargo.toml --tests
cargo test --manifest-path desktop/workflow-engine-rs/Cargo.toml --test service_protocol -- --ignored --skip real_icode
```

第二条使用 Python 和受控 ACP 替身，不调用真实模型。Desktop 的相关前端测试和构建在 `desktop` 目录执行：

```powershell
npx vitest run tests/ui/workflowHierarchy.test.tsx tests/ui/workflowPanel.test.tsx tests/ui/workflowLauncher.test.tsx tests/workflow/linkedRuntime.test.ts
npm run typecheck
npm run build
```

服务启动和运行故障可检查应用数据目录下 `workflow-engine/service-stderr.log` 与 `workflow-engine/workflow-runs.sqlite`。日志和数据库可能包含业务内容，分享前应检查并脱敏。

## 交付测试结论

逐项写明「通过 / 失败 / 阻塞 / 未覆盖」、运行 ID、可复核的实际结果和必要的截图或日志位置。单独说明真实 Agent、真实检查器和界面是否经过验收；受控替身通过不等于业务通过。发现节点结果、运行记录和界面不一致时，保留现场并注明不一致的具体实例及执行轮次。
