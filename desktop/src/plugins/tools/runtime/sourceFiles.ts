/**
 * 清单里文本文件的配额。
 *
 * 从 64 个 / 512 KB 放宽到 512 个 / 4 MB：工具能带 `node_modules` 之后，跟着
 * 一起进来的手写模块（`lib/*.js`）不再是"两个文件"的量级。二进制资源不进这个
 * 字段，它们落盘在工具目录里。
 */
import { toolLimits } from "./limits.ts";

export const sourceFileLimit = { files: toolLimits.sourceFiles, bytes: toolLimits.sourceBytes } as const;

/**
 * `bin/` 里的东西是 L3 的运行时（可执行文件 + 它自己的依赖）。
 *
 * 它**不进清单**，理由和 `node_modules` 一样，但它更硬：
 * - 二进制没法用 UTF-8 文本承载；
 * - 它的体积归"工具包大小"管（导入时单列显示），不该占 `sourceFiles` 的
 *   512 个 / 4 MB 额度。
 */
export function isRuntimeBinPath(path: string): boolean {
  return path === "bin" || path.startsWith("bin/");
}

export function safeSourcePath(path: string): boolean {
  // 320 而不是 200：`node_modules` 里嵌套包名 + 目录经常超过 200 字符
  // （`node_modules/@babel/plugin-transform-xxx/lib/helpers/yyy.js` 这种）。
  // 再长就接近 Windows 的 260 字符路径上限了，那时候问题在文件系统，
  // 不是在路径校验。
  return path.length > 0 && path.length <= 320 && !/[\\:<>"|?*]/.test(path) && ![...path].some((ch) => ch.charCodeAt(0) < 32)
    && path.split("/").every((part) => part && part !== "." && part !== ".."
      && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      && !["__proto__", "prototype", "constructor"].includes(part));
}

export function readSourceFiles(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > sourceFileLimit.files) return undefined;
  const paths = new Set<string>();
  let bytes = 0;
  for (const [path, source] of entries) {
    if (!safeSourcePath(path) || paths.has(path.toLowerCase()) || ["manifest.json", "index.html"].includes(path.toLowerCase()) || isRuntimeBinPath(path) || typeof source !== "string") return undefined;
    paths.add(path.toLowerCase());
    bytes += new TextEncoder().encode(source).length;
    if (bytes > sourceFileLimit.bytes) return undefined;
  }
  return Object.fromEntries(entries);
}
