export const accountStorageKey = "aaw-desktop.auth.v1";

export const SSO_TIMEOUT_SECS = 180;
export const SSO_POLL_INTERVAL_MS = 1_500;
/** Cookie 落地后允许暂时返回 401，连续三次才报告失败。 */
export const SSO_UNAUTHORIZED_STRIKES = 3;
