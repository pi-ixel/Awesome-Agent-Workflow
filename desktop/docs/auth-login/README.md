# 用户登录（企业 SSO 对接 + 开发者降级自验）

桌面客户端的用户身份能力：复用企业 SSO 认证获取登录身份（姓名 / 工号 /
唯一 ID 等），并提供开发者手动降级通道，用于正式对接内网系统之前的功能
自验。本目录是该功能的设计与契约说明。

## 功能形态

- 登录是**启动门槛**（App.tsx 的 `AuthGate`）：未登录时整棵工作台被
  全屏登录界面（`src/ui/LoginScreen.tsx`）替代；登录态随 localStorage
  持久化，下次启动自动恢复、直接进工作台。
- 主路径「企业 SSO 登录」：向配置的认证接口发起一次请求，服务端弹出
  认证页完成（自动）认证后返回用户身份 JSON；等待期间可取消。
- 降级「开发者身份登录」：手填姓名 + 工号（邮箱可选），唯一 ID 使用
  **本机固定 UUID**（首次生成后持久化，此后退出重登、换身份都不变，
  保证自验数据归属稳定）。
- 侧栏 footer 身份区（`SidebarFooter`）显示当前用户（姓名首字符头像 +
  姓名，悬停看工号 / ID / 来源），菜单提供「退出登录」。

## 分层架构（传输与契约分离）

```
LoginScreen ──▶ authStore ──▶ hostRuntime.ssoLogin ──▶ 三实现
                （契约解析）        （纯传输）              ├─ Tauri: invoke sso_fetch_identity（src-tauri auth_sso.rs，reqwest）
                                            ├─ dev-web bridge: POST /dev-bridge/sso-login（vite 插件 Node 侧代理）
                                            └─ demo（vitest）：scriptSsoFetch 预置
```

- **Rust / bridge 只做传输**：把 `{ status, body }` 原文带回。非 2xx 不
  是传输错误（原文照带），只有连不通 / 超时 / 地址非法才报错。
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
`parseSsoIdentity` 一处即可，store / UI / 传输层全部不动），并视需要把
默认端点固化到 `authStore` 的 `defaultSsoEndpoint` 位（当前默认为空，
由登录界面填写后本机持久化）。

## 配置与持久化

| 项 | key | 说明 |
| --- | --- | --- |
| 登录态 + 端点 | `aaw-desktop.auth.v1` | `{ version, user, ssoEndpoint }`，逐字段守卫，坏数据整体回落未登录 |
| 本机固定 UUID | `aaw-desktop.auth.dev-uuid.v1` | 降级登录唯一 ID，独立于登录态，logout 不回收 |

SSO 超时缺省 180s（认证页可能需要人工介入）；请求方法支持 GET（缺省）/
POST（发空 JSON 对象）。

## 测试

- Rust：`src-tauri/src/auth_sso.rs`（方法归一化、端点校验、回环 HTTP
  中继），`cargo test auth_sso`。
- 契约：`tests/core/auth.test.ts`（别名 / 包裹层 / 失败分支）。
- store：`tests/stores/authStore.test.ts`（成功 / 失败 / 取消代次 /
  固定 UUID 稳定性 / 持久化回落）。
- UI：`tests/ui/LoginScreen.test.tsx`（门槛呈现、失败文案、降级表单、
  App 接线冒烟）。
