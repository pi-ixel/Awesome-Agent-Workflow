# teams-aaw — AAW 工作流的 iCode Teams 插件

AAW（Awesome Agent Workflow）在 iCode Teams 上的 **Native FeatureBundle** 插件，独立于
`icode-teams/demo` 仓库发布（与 OpsCopilot 的 `plugins/teams-opscopilot` 同一模式）。

产品定位（三个核心诉求）：

1. **监看**：把 `.sdd/<SR>/workflow.yaml` 的运行状态投影成实时流程图（分层 DAG、
   foreach 扇出分组、等待确认/失败/重跑角标）。
2. **启动**：在登记的工作区里创建新的工作流实例（`aaw start`），后续接一键拉起
   Chrys 会话执行。
3. **画布（路线图）**：复用 AAW 工作流内核，让用户搭建**自己的**工作流。
   AAW 内置流程只读、不可改。

## 架构

```
[repo] Chrys ──▶ AAW CLI ──原子写──▶ .sdd/<SR>/workflow.yaml
                                        ▲ 只读（CLI 是唯一写者）
[Core] Business Module（本插件）
   ├─ 工作区注册表  dataDirectory/workspaces.json
   ├─ srs.list / srs.status / srs.start / workspace.*   ← spawn AAW CLI --json
   └─ 每次spawn固定注入 AAW_TELEMETRY_ENABLED=false、AAW_UPDATE_CHECK=off
[Gateway] POST /api/bundles/aaw-workflow/call（浏览器 CSRF + Bearer）
[UI Shell] ui.js ── mount(container, {bundleId,pageId,version})
   └─ Vue 3 + Vue Flow（自带打包，ShadowRoot 隔离），15s 轮询，后续切 SSE
```

原则：**内核是唯一解释器，插件是投影**。插件不实现任何工作流语义（校验、条件求值、
后继生成全部归 CLI）；错误从 CLI 的结构化 JSON 错误映射为 `{error, code}` 透传。

## 文件结构

```
├── manifest.json 产物五件套由 pack.ts 生成（manifest/business/ui/contract）
├── pack.ts            esbuild 构建；ui 两次构建收集 CSS 并把 :root 改写为 :host
├── src/
│   ├── contract.ts    调用契约（信封 {schemaVersion:1, requestId, operation, payload}）
│   ├── errors.ts      AawError + 错误码（对齐 OpsCopilot 约定）
│   ├── aaw-cli.ts     spawn 封装：参数构造、环境注入、JSON/错误解析
│   ├── business.ts    AawBusiness：工作区注册表 + 操作分发
│   ├── entry.ts       宿主入口（校验 protocol 1 host 上下文；ctx.provide('aaw-workflow')）
│   ├── graph.ts       纯函数：status JSON → 分层节点/边投影（含测试）
│   ├── contributions.ts  四个 slot（navigation/page/settings/command，宿主强制齐全）
│   ├── ui.ts          Vue 应用 + mount()（ShadowRoot）+ 默认导出（注册 slot）
│   └── ui-client.ts   浏览器会话（CSRF）+ call 客户端
└── tests/             node --import tsx --test；含构建产物真实加载测试
```

## 操作一览

| operation | payload | 说明 |
|---|---|---|
| `workspace.list` | – | 已登记工作区 |
| `workspace.add` | `{path, aawCommand?}` | 绝对路径；登记前用 `aaw status --json` 冒烟 |
| `workspace.remove` | `{id}` | |
| `srs.list` | `{workspaceId}` | `aaw status --json` → `srs` |
| `srs.status` | `{workspaceId, sr}` | `aaw status --sr <SR> --json` 原样返回 |
| `srs.start` | `{workspaceId, entry, sr?, vars?, requirement?}` | `aaw start ... --json`；需求文本写临时文件传 `--requirement-file` |
| `aaw-workflow.status` | – | 插件自检（command slot 用；兼容 demo 的 `{tool:'UI'}` 示例体） |

## 开发

```bash
cd plugins/teams-aaw
npm install
npm run typecheck
npm test            # 24 项：graph 投影 / business（假 runner）/ pack / 构建产物加载
npm run build       # 产出 dist/package/ + dist/artifact.json
```

## 接入正在运行的 iCode Teams demo

前置：demo 四件套已启动（Core 默认 `http://127.0.0.1:45832`，UI 网关 45833），
拿到本机凭证 `ICODE_LOCAL_CREDENTIAL`（demo 的 `.demo-data` 下）。

```bash
ICODE_LOCAL_CREDENTIAL=<token> npm run apply
```

apply 后浏览器打开 `http://127.0.0.1:45833/#/plugins/aaw-workflow`：

1. 「登记工作区…」→ 填 repo 绝对路径和 AAW CLI 命令
   （如 `python D:\dev\workspace-ai\Awesome-Agent-Workflow\skills\aaw-workflow\scripts\aaw.py`）；
2. 左侧选 SR，右侧出现该 SR 的流程图；
3. 「新建工作流」→ 选入口/填 SR/贴需求 → 创建后自动选中新 SR。

卸载/停用走 demo 的扩展管理页；删除插件数据即删 Core 分配的
`dataDirectory`（工作区注册表所在，不含任何工作流状态）。

## 已知边界（v1）

- 刷新靠 15s 轮询；插件业务事件 SSE 路由是平台缺口（OpsCopilot 同款诉求），到位后切换。
- `aaw status` 的自动更新查询在离线时会拖慢每次 spawn，已用 `AAW_UPDATE_CHECK=off` 规避
  （`skills/aaw-workflow` 侧的开关，随包提供）。
- 每次读取 spawn 一个 Python 进程（数百毫秒）；对"人看图"的节奏足够，未来可在
  Business 侧加缓存。
- 确认动作刻意不做成图上按钮：确认的语义是"看过产出再放行"，请留在与 Agent 的
  对话里完成；图上只提示卡点。
