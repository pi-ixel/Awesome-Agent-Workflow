/** 一次 SSO 网关请求的传输结果（wire 形状，sso_login.rs SsoFetchResult）。 */
export interface SsoFetchWire {
  readonly status: number;
  readonly body: string;
}

/** 单次 SSO 登录轮询的传输结果（wire 形状，sso_login.rs SsoLoginPollResult）。 */
export interface SsoLoginPollWire {
  /** 登录窗口已被用户关闭（= 放弃）→ 编排层按静默取消处理。 */
  readonly windowClosed: boolean;
  /** 已带 cookie 调过网关时的响应原文；null = cookie 未落地，继续轮询。 */
  readonly fetched: SsoFetchWire | null;
}
