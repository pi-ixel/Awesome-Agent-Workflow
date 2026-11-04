/**
 * Vitest 全局 setup：
 * - 挂载 @testing-library/jest-dom 匹配器；
 * - 显式注册 cleanup（vitest 未开 globals 时 RTL 不会自动清理 DOM）。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom 无排版引擎；CodeMirror 的异步测量需 Range 几何接口，真实几何由浏览器测试验证。
if (typeof Range !== "undefined" && !Range.prototype.getClientRects)
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => Object.assign([], { item: () => null }),
  });
if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect)
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
