/**
 * 企业 SSO 内置配置（构建期固化，不出现在任何界面）。
 *
 * 对接内网系统时：填写 SSO_ENDPOINT（必填）与 SSO_TOKEN（按需，随请求以
 * `Authorization: Bearer` 携带）后重新出包。SSO_ENDPOINT 为空表示本构建
 * 未对接——登录界面不出现 SSO 入口，直接呈现手动身份输入窗口。
 *
 * 自验通道（不出现在 UI）：对接前需临时验证 SSO 通路时，向 localStorage
 * 写入 `aaw-desktop.auth.sso-dev-endpoint.v1` 指定端点即可，见
 * docs/auth-login/README.md。
 */

/** 企业 SSO 认证接口完整地址（http:// 或 https://）；空 = 本构建未对接。 */
export const SSO_ENDPOINT = "";

/** 随 SSO 请求携带的内置 token（空 = 不携带）。 */
export const SSO_TOKEN = "";
