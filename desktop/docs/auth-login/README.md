# 用户登录（内网 W3 SSO 对接 + 手动身份窗口）

桌面客户端的用户身份能力：经企业 W3 SSO 认证获取登录身份（姓名 / 工号 /
唯一 ID）；未对接内网的构建直接呈现最小手动登录窗口。本目录是该功能的
设计与契约说明。

对接依据：GitHub Issue #247（2026-11 实机穿刺结论）——内网网关
**只认 W3 会话 Cookie**（`Authorization` / `x-auth-token` 等一律 401），
W3 cookie 由 `login.huawei.com` 下发（`Domain=.huawei.com`、SameSite=Lax），
前端 JS 跨站 fetch 带不上，必须由宿主进程（Rust）读 WebView cookie 后
转发。

## 功能形态

- 登录是**启动门槛**（App.tsx 的 `AuthGate`）：未登录时整棵工作台被
  全屏登录界面（`src/plugins/account/ui/LoginScreen.tsx`）替代；登录态随 localStorage
  持久化，下次启动自动恢复、直接进工作台。
- **SSO 主路径（构建内置时）**：端点与登录页内置在程序里
  （`src/plugins/account/sso/authConfig.ts`），不出现在任何界面。进入登录界面即**直接
  发起一次认证尝试**（每进程一次）：先开**隐藏**登录窗静默探测已有
  登录态——有持久 cookie 时一次轮询即无感恢复，全程无窗口闪烁；cookie
  未落地才唤起登录窗给用户操作（在窗口里完成 W3 登录即可，无需跳回）。
  等待中可取消（同时撤下登录窗）；用户自行关登录窗视为放弃（回到登录
  界面，可重点重试，不报错）。**手动输入身份是兜底通道：默认不可见**
  （防止不耐烦的用户顺手点击、绕过统一身份认证）；认证失败立即出现，
  等待满 45s 也先亮出（`SSO_MANUAL_ENTRY_DELAY_MS`，轮询与登录窗不打断，
  给等不了的用户一个出口；总超时仍为 180s）。
- **手动身份窗口（未内置 / 点击手动入口）**：只要求输入两项——
  - 用户名：仅用于界面展示；
  - 工号：唯一区分身份（内部唯一 ID 由本机按工号分配固定 UUID，不展示）。
    端点、登录页、内部 UUID 等细节一律不暴露。
- 侧栏 footer 身份区（`SidebarFooter`）显示当前用户（姓名首字符头像 +
  用户名，悬停看工号），菜单提供「退出登录」。

## 配置（构建期固化）

```ts
// src/plugins/account/sso/authConfig.ts
export const SSO_ENDPOINT =
  "https://dev.longriver.rnd.huawei.com/mateopenapi/rolex/matestoreauthservice/v1/users/validate";
export const SSO_LOGIN_URL = "https://login.huawei.com/login1";
```

- `SSO_ENDPOINT`：认证网关（成功返回扁平 JSON `{uid, givenName}`）；
  空 = 未对接（登录界面不出现 SSO 入口）。
- `SSO_LOGIN_URL`：W3 登录页（登录窗口加载用；**不带 redirect 参数**——
  本链路只需要 cookie 落地，不需要跳回）。
- 换环境（如 dev → 生产网关）时改本文件重新出包，UI / store / 传输层
  均不用改。

**自验通道**（不出现在 UI，仅开发自验）：内置为空时，向 localStorage
写入 `aaw-desktop.auth.sso-dev-endpoint.v1`（网关端点）与
`aaw-desktop.auth.sso-dev-login-url.v1`（登录页）可临时指定，免重新
出包。

## 登录链路（Issue #247）

```
LoginScreen（自动尝试/点击）
 └▶ authStore.loginWithSso（流程编排：代次取消 + 轮询 + 401 三振）
     ├▶ host.account.ssoOpenLogin(loginUrl)
     │    Tauri: invoke sso_open_login —— 创建「隐藏」登录窗（label "sso"），
     │    WebView2 加载 W3 登录页；再次调用 = 唤起显示（幂等）
     ├▶ 循环（1.5s 间隔，总上限 180s）host.account.ssoPollLogin(endpoint)
     │    Tauri: invoke sso_poll_login ——
     │      读 WebView cookie（按网关 URL 查询，tauri cookies_for_url）
     │      ├ cookie 为空        → { fetched: null }（前端唤起登录窗后继续轮询）
     │      ├ cookie 非空        → 全部拼进 Cookie 头调网关 → { fetched: {status, body} }
     │      └ 登录窗已不存在     → { windowClosed: true }（用户放弃，静默取消）
     │    dev-web bridge: POST /dev-bridge/sso-poll-login（Node 无 cookie，直调网关，
     │      只用于联调编排与连通性；demo（vitest）: scriptSsoLoginPoll 预置队列）
     ├▶ 2xx → parseSsoIdentity（core/auth.ts）→ 持久化登录
     │   401 → 三振（约 4.5s 容忍 cookie 半落地竞态）后按失败展示
     └▶ 终态调用 host.account.ssoCloseLogin()，Host 卸载时兜底关窗
```

- **Rust / bridge 只做传输**：把 `{ windowClosed, fetched: { status, body } }`
  原文带回；非 2xx 不是传输错误（原文照带），只有连不通 / 超时 / 地址
  非法才报错。
- **契约解析只有一处**：`src/plugins/account/identity/identity.ts` 的 `parseSsoIdentity`，两条
  通路共用、vitest 直接可测。宿主返回形状经 `asSsoLoginPollWire` 守卫，
  绝不带病进入状态。
- **cookie 安全**：诊断日志只记 cookie 数量 / 名字 / 持久占比（channel
  `sso-native`，供观察 Issue #247 §六的 session vs persistent），**绝不记
  cookie 值**；轮询返回值同样不含 cookie 原文。

## Rust 侧要点（src-tauri/src/sso_login.rs）

- 三个命令：`sso_open_login` / `sso_poll_login` / `sso_close_login`。
  cookie 读取用 tauri 2 自带的 `WebviewWindow::cookies_for_url`（含
  HttpOnly；**必须在 async 命令里调**——同步命令 / 事件回调会死锁，
  tauri 文档明示）。
- 登录窗口（label `sso`）：`.visible(false)` 隐藏创建 + `.skip_taskbar(true)`，
  与主窗口共享同一 WebView2 环境（cookie 存储互通，登录一次落地）。
- TLS / 代理：Windows 走 reqwest `native-tls`（Schannel 系统证书库，
  内网自签链 `HWBPIT Enterprise CA` 装进系统库即可信）+ `system-proxy`
  特性（读系统代理）。
- 窗口事件（lib.rs）：`sso` 窗口 CloseRequested 直接放行（用户关窗 =
  放弃，前端轮询发现后静默取消）；主窗口销毁时顺带销毁 `sso`。
- capability 零改动：登录窗加载外部页且不 invoke 任何命令（未配置
  remote IPC，远端页面无 IPC 权限——刻意保持的最小权限）。

## SSO 接口契约

网关实测返回为扁平 JSON：

```json
{ "uid": "a00012345", "givenName": "张三" }
```

解析仍按宽容契约实现（防网关字段演进）：键匹配「小写 + 去下划线」，
别名覆盖 id（`uid` / `userId` / …）、姓名（`givenName` / `name` / …）、
工号、邮箱、部门；顶层没有身份字段时下探常见包裹层；强弱两轮锚点。
完整别名表见 `src/plugins/account/identity/identity.ts`（`ID_STRONG_ALIASES` 等常量）。网关
契约确定不变后可在此收敛为精确字段。

## 登录态有效期（Issue #247 §六，未验证项）

W3 会话 cookie 是 session 还是 persistent 尚未实机确认：

- **persistent**（有具体过期时间）→ 落地后跨进程有效，启动即无感恢复；
- **session**（进程级）→ 客户端关闭后失效，每次启动重新弹登录窗。

现场确认方法：登录后打开诊断窗口，查 channel `sso-native` 的
「SSO 登录 cookie 就绪」记录，`persistent` 字段为 cookie 里带过期时间
的条数（0 = 全部 session cookie）。两种情况下流程都有兜底：cookie 失效
→ 网关 401 → 三振报错 → 用户重点一次（重新唤起登录窗）。

## 持久化

| key                                     | 内容                                                            |
| --------------------------------------- | --------------------------------------------------------------- |
| `aaw-desktop.auth.v1`                   | `{ version, user }` 登录态，逐字段守卫，坏数据整体回落未登录    |
| `aaw-desktop.auth.dev-ids.v1`           | `{ 工号: 固定UUID }` 手动登录的内部唯一 ID 映射，退出登录不回收 |
| `aaw-desktop.auth.sso-dev-endpoint.v1`  | SSO 自验网关端点（仅内置为空时生效，开发用）                    |
| `aaw-desktop.auth.sso-dev-login-url.v1` | SSO 自验登录页地址（同上）                                      |

SSO 总等待上限 180s（登录窗可能需要人工介入）；轮询间隔 1.5s；401 三振
阈值 3 次。

## 测试

- Rust：`src-tauri/src/sso_login.rs`（端点校验、cookie 头拼接、回环
  HTTP 转发断言 Cookie 头 + 200/401 原文回传），`cargo test sso_login`。
- 契约：`tests/core/auth.test.ts`（别名 / 包裹层 / W3 实测契约 / 失败分支）。
- store：`tests/stores/authStore.test.ts`（轮询编排：首询即成 / 唤起 /
  关窗取消 / 401 三振 / 取消代次与关窗 / 按工号固定 ID / 持久化回落）。
- UI：`tests/ui/LoginScreen.test.tsx`（未内置时最小窗口、手动登录、
  内置时自动尝试与失败展示、App 接线冒烟）。
