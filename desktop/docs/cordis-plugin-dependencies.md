# Desktop 完整插件依赖图

这是已对齐的目标架构，不是当前代码依赖扫描结果。15 个插件逐个展开，Rust 为插件外宿主。ICode / CodeAgent 是 agents 的内部模块，不额外计为插件。

- 箭头指向被依赖或被注册的服务，不表示启动顺序或事件流向。
- 实线表示必需服务依赖。虚线标签区分可选业务接入、UI 注册、界面调用、健康检查注册、安装退出调用、关闭参与者注册和导航检查注册。
- 全图共 **74 条边**，包括 43 条必需服务依赖、7 条可选业务接入、10 条 UI 注册、5 条界面调用、1 条健康检查注册、1 条探查会话工厂注册、1 条安装退出调用、5 条关闭参与者注册和 1 条导航检查注册。
- 同一对插件间的不同关系保留为独立边，例如 updates → workbench 的 UI 注册和安装退出调用。
- UI 和关闭参与者由子模块/装配层注册，不将其变为业务核心的强制依赖。documents → project 的关闭注册与 project → documents 的可选上下文接入，不代表核心服务循环注入。
- 公共基础依赖逐条绘制，不合并节点、不省略公共连线。通过中间插件形成的间接依赖不新增为直接边。

```mermaid
flowchart TB
  subgraph plugins["Cordis 插件 · 目标架构"]
    host["host<br/>宿主桥接"]
    configuration["configuration<br/>配置"]
    diagnostics["diagnostics<br/>诊断"]
    workbench["workbench<br/>工作台"]
    agents["agents<br/>Agent 管理及 ICode / CodeAgent 增强"]
    acpConnection["acpConnection<br/>ACP 连接"]
    acpRuntime["acpRuntime<br/>ACP 运行时"]
    project["project<br/>项目 / 会话 / 对话 / 审批 / 表单"]
    documents["documents<br/>文件与文档"]
    git["git<br/>Git"]
    terminal["terminal<br/>终端"]
    workflow["workflow<br/>AAW 工作流"]
    skills["skills<br/>技能"]
    account["account<br/>账户"]
    updates["updates<br/>更新"]
  end
  rust["Rust / Tauri<br/>非插件"]

  %% 必需服务依赖，每条直接依赖单独列出
  host --> rust
  configuration --> host
  diagnostics --> host
  diagnostics --> configuration
  workbench --> host
  workbench --> configuration
  agents --> host
  agents --> configuration
  agents --> diagnostics
  agents --> acpConnection
  acpConnection --> host
  acpConnection --> diagnostics
  acpRuntime --> acpConnection
  acpRuntime --> agents
  acpRuntime --> diagnostics
  project --> acpRuntime
  project --> agents
  project --> configuration
  project --> diagnostics
  project --> host
  documents --> host
  documents --> configuration
  documents --> diagnostics
  git --> host
  git --> configuration
  git --> diagnostics
  terminal --> host
  terminal --> configuration
  terminal --> diagnostics
  workflow --> host
  workflow --> project
  workflow --> configuration
  workflow --> diagnostics
  skills --> host
  skills --> agents
  skills --> configuration
  skills --> diagnostics
  account --> host
  account --> configuration
  account --> diagnostics
  updates --> host
  updates --> configuration
  updates --> diagnostics

  %% 可选业务能力
  project -. "可选：技能候选" .-> skills
  project -. "可选：健康检查脚本来源" .-> skills
  workflow -. "可选：工作流脚本来源" .-> skills
  project -. "可选：文档上下文" .-> documents
  project -. "可选：审阅上下文" .-> git
  project -. "可选：工作流进度" .-> workflow
  documents -. "可选：文件状态" .-> git

  %% UI 子模块注册：不构成核心服务的强制依赖
  diagnostics -. "UI 注册" .-> workbench
  agents -. "UI 注册" .-> workbench
  project -. "UI 注册" .-> workbench
  documents -. "UI 注册" .-> workbench
  git -. "UI 注册" .-> workbench
  terminal -. "UI 注册" .-> workbench
  workflow -. "UI 注册" .-> workbench
  skills -. "UI 注册" .-> workbench
  account -. "UI 注册" .-> workbench
  updates -. "UI 注册" .-> workbench
  agents -. "设置页读取项目上下文并请求切换 Agent" .-> project
  workbench -. "顶栏新建会话" .-> project
  workbench -. "通过文档服务打开文件" .-> documents
  documents -. "读写批注草稿及从批注新建会话" .-> project
  project -. "使用当前工作台导航" .-> workbench
  workflow -. "注册工作区健康检查" .-> project
  acpRuntime -. "注册探查会话工厂" .-> agents

  %% 条件调用及关闭参与者注册
  updates -. "安装前请求退出" .-> workbench
  project -. "登记退出检查与收尾" .-> workbench
  documents -. "登记退出检查与收尾" .-> workbench
  documents -. "登记未保存导航检查" .-> workbench
  terminal -. "登记退出检查与收尾" .-> workbench
  documents -. "登记项目关闭处理" .-> project
  terminal -. "登记项目关闭处理" .-> project

  classDef base fill:#e8f0fe,stroke:#3565a8,color:#172b4d
  classDef runtime fill:#e2f5ee,stroke:#218763,color:#123d2e
  classDef product fill:#fff1d6,stroke:#a97116,color:#51380e
  classDef external fill:#eeeeee,stroke:#666666,color:#222222
  class host,configuration,diagnostics,workbench base
  class agents,acpConnection,acpRuntime runtime
  class project,documents,git,terminal,workflow,skills,account,updates product
  class rust external
```

## 边清单核对

| 来源 | 必需依赖目标 | 可选接入目标 | UI 注册目标 | 界面调用、能力注册与条件调用 |
| --- | --- | --- | --- | --- |
| host | rust | — | — | — |
| configuration | host | — | — | — |
| diagnostics | host、configuration | — | workbench | — |
| workbench | host、configuration | — | — | project（顶栏新建会话），documents（打开文件） |
| agents | host、configuration、diagnostics、acpConnection | — | workbench | project（设置页读取探查路径并请求切换 Agent） |
| acpConnection | host、diagnostics | — | — | — |
| acpRuntime | acpConnection、agents、diagnostics | — | — | agents（注册探查会话工厂） |
| project | acpRuntime、agents、configuration、diagnostics、host | skills、documents、git、workflow | workbench | workbench（使用当前工作台导航、登记退出检查与收尾） |
| documents | host、configuration、diagnostics | — | workbench | workbench（登记退出检查与收尾、未保存导航检查），project（读写批注草稿、从批注新建会话、登记项目关闭处理） |
| git | host、configuration、diagnostics | — | workbench | — |
| terminal | host、configuration、diagnostics | — | workbench | workbench（登记退出检查与收尾）；project（登记项目关闭处理） |
| workflow | host、project、configuration、diagnostics | skills | workbench | project（注册工作区健康检查） |
| skills | host、agents、configuration、diagnostics | — | workbench | — |
| account | host、configuration、diagnostics | — | workbench | — |
| updates | host、configuration、diagnostics | — | workbench | workbench（安装前请求退出） |

配置注册、诊断记录等能力已包含在对应必需依赖中，不重复计边。待后续明确的其他关闭参与者不凭空补入本图。

[插件职责与边界](cordis-plugin-architecture.md) · [原始 Mermaid 图源](cordis-plugin-dependencies.mmd)
