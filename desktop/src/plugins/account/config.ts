export const accountStorageKey = "aaw-desktop.auth.v1";

export const SSO_TIMEOUT_SECS = 180;
export const SSO_POLL_INTERVAL_MS = 1_500;
// 给原生网关请求的 15 秒超时留出 IPC 和读取 Cookie 的时间。
export const SSO_HOST_TIMEOUT_MS = 20_000;
