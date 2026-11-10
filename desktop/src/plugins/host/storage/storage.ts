import type { HostStorage } from "../types.ts";

/** 延迟访问 WebView 存储，保留禁用存储和配额错误给调用方处理。 */
export const webviewStorage: HostStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};
