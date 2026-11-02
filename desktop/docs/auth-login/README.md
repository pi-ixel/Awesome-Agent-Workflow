# 用户登录（企业 SSO 对接 + 手动身份窗口）

桌面客户端的用户身份能力：复用企业 SSO 认证获取登录身份（姓名 / 工号 /
唯一 ID 等）；未对接内网的构建直接呈现最小手动登录窗口。本目录是该功能
的设计与契约说明。

## 功能形态

- 登录是**启动门槛**（App.tsx 的 `AuthGate`）：未登录时整棵工作台被
  全屏登录界面（`src/ui/LoginScreen.tsx`）替代；登录态随 localStorage
  持久化，下次启动自动恢复、直接进工作台。
- **SSO 主路径（构建内置时）**：端点与 token 内置在程序里
  （`src/core/authConfig.ts`），不出现在任何界面。进入登录界面即**直接
  发起一次认证尝试**（每进程一次）——服务端弹出认证页完成（自动化）认证
  后返回身份 JSON；等待中可取消；失败原文展示，另留一个不显眼的「手动
  输入身份登录」入口。
- **手动身份窗口（未内置 / 点击手动入口）**：只要求输入两项——
  - 用户名：仅用于界面展示；
  - 工号：唯一区分身份（内部唯一 ID 由本机按工号分配固定 UUID，不展示）。
  端点、token、内部 UUID 等细节一律不暴露。
- 侧栏 footer 身份区（`SidebarFooter`）显示当前用户（姓名首字符头像 +
  用户名，悬停看工号），菜单提供「退出登录」。

## 配置（构建期固化）

```ts
// src/core/authConfig.ts
export const SSO_ENDPOINT = ""; // 企业 SSO 认证接口完整地址；空 = 未对接
export const SSO_TOKEN = "";    // 随请求以 Authorization: Bearer 携带；空 = 不带
```

对接内网系统时填入这两项并重新出包即可；UI、store、传输层均不用改。

**自验通道**（不出现在 UI，仅开发自验）：内置端点为空时，向 localStorage
写入 `aaw-desktop.auth.sso-dev-endpoint.v1`（值为完整端点 URL）可临时
指定端点，配合任意 mock SSO 服务即可联调 SSO 全链路，免重新出包。

## 分层架构（传输与契约分离）

```
LoginScreen ──▶ authStore ──▶ hostRuntime.ssoLogin ──▶ 三实现
                （契约解析）        （纯传输）              ├─ Tauri: invoke sso_fetch_identity（src-tauri auth_sso.rs，reqwest）
                                            ├─ dev-web bridge: POST /dev-bridge/sso-login（vite 插件 Node 侧代理）
                                            └─ demo（vitest）：scriptSsoFetch 预置
```

- **Rust / bridge 只做传输**：把 `{ status, body }` 原文带回；token 非空
  时以 `Authorization: Bearer` 携带。非 2xx 不是传输错误（原文照带），
  只有连不通 / 超时 / 地址非法才报错。
- **契约解析只有一处**：`src/core/auth.ts` 的 `parseSsoIdentity`，两条
  通路共用、vitest 直接可测。宿主返回形状经 `asSsoFetchWire` 守卫，
  绝不带病进入状态。

## SSO 接口契约

当前处于**对接前宽松期**（真实字段名未冻结），解析按宽容契约实现：

- 响应须为 JSON 对象；顶层没有身份字段时依次下探常见包裹层
  （`data` / `result` / `user` / `userInfo` / `profile` / `content` /
  `detail`）。
- 键匹配「小写 + 去下划线」，camelCase / snake_case / PascalCase 一视
  同仁；识别的别名覆盖 id（`userId` / `uid` / `id` / `uuid` / …）、姓名、
  工号（`employeeId` / `jobNumber` / `workNo` / …）、邮箱、部门。
- 唯一锚点分强弱两轮：显式 id / 工号字段优先于账号 / 邮箱 / 姓名兜底；
  一个锚点都没有时报错并列出顶层字段名（契约差异第一时间可见）。
- 完整别名表见 `src/core/auth.ts`（`ID_STRONG_ALIASES` 等常量）。

**对接内网定稿后**：按真实返回把解析收敛为精确字段（改
`parseSsoIdentity` 一处即可，store / UI / 传输层全部不动）；若认证
token 的携带方式不是 `Authorization: Bearer`，同步调整 auth_sso.rs 的
header 一处。

## 持久化

| key | 内容 |
| --- | --- |
| `aaw-desktop.auth.v1` | `{ version, user }` 登录态，逐字段守卫，坏数据整体回落未登录 |
| `aaw-desktop.auth.dev-ids.v1` | `{ 工号: 固定UUID }` 手动登录的内部唯一 ID 映射，退出登录不回收 |
| `aaw-desktop.auth.sso-dev-endpoint.v1` | SSO 自验端点（仅内置为空时生效，开发用） |

SSO 超时缺省 180s（认证页可能需要人工介入）；请求方法支持 GET（缺省）/
POST（发空 JSON 对象）。

## 测试

- Rust：`src-tauri/src/auth_sso.rs`（方法归一化、端点校验、回环 HTTP
  中继 + token 头携带），`cargo test auth_sso`。
- 契约：`tests/core/auth.test.ts`（别名 / 包裹层 / 失败分支）。
- store：`tests/stores/authStore.test.ts`（成功 / 失败 / 取消代次 /
  按工号固定 ID / 持久化回落）。
- UI：`tests/ui/LoginScreen.test.tsx`（未内置时最小窗口、手动登录、
  内置时自动尝试与失败展示、App 接线冒烟）。
