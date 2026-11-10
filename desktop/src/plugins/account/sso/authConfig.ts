/**
 * 企业 SSO 内置配置（构建期固化，不出现在任何界面）。
 *
 * 对接形态（Issue #247，2026-11 实测）：网关只认 W3 会话 Cookie
 * （`Authorization` 等一律 401），链路是「登录窗口完成 W3 登录 → 宿主读
 * WebView cookie → 带 Cookie 头调网关」，端点与登录页两个地址都在这里
 * 固化；换环境（如 dev → 生产网关）时改本文件重新出包。
 *
 * SSO_ENDPOINT 为空表示本构建未对接——登录界面不出现 SSO 入口，直接
 * 呈现手动身份输入窗口。自验通道（不出现在 UI）：对接前需临时验证链路
 * 时，向 localStorage 写入 `aaw-desktop.auth.sso-dev-endpoint.v1`（网关
 * 端点）与 `aaw-desktop.auth.sso-dev-login-url.v1`（登录页）即可，见
 * docs/auth-login/README.md。
 */

/**
 * 企业认证网关端点（http:// 或 https://）；网关成功返回扁平 JSON
 * `{uid, givenName}`（契约解析见 core/auth.ts）；空 = 本构建未对接。
 */
export const SSO_ENDPOINT =
  "https://dev.longriver.rnd.huawei.com/mateopenapi/rolex/matestoreauthservice/v1/users/validate";

/**
 * W3 登录页地址（登录窗口加载用；不带 redirect 参数——本链路只需要
 * cookie 落地，不需要跳回）。
 */
export const SSO_LOGIN_URL = "https://login.huawei.com/login1";
