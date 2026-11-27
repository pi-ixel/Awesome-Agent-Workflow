/**
 * 工具运行时的内容安全策略（预览用）。
 *
 * P3 之后真实窗口的 CSP 写在 `src-tauri/src/tools/protocol.rs` 的 `BASE_POLICY`，
 * 预览这一份是它的镜像。两边必须逐条一致——预览要是比真实窗口松，用户就会
 * "预览能跑、打开就废"；比真实窗口紧，则会冤枉工具。
 *
 * `policy.test.ts` 会把两边的指令集合逐条比对，改一处必须改另一处。
 * 与旧版（Electron）的差别是 `'self'` 与 `object-src`：真实窗口的页面永远从
 * 工具目录加载，多文件工具必须能引用同目录的 js/css，而预览用的是 srcdoc，
 * 多出来的 `'self'` 在那里不指向任何东西。保持两份文本一致比"精确到每个
 * 载体都不多不少"更重要——差异一旦允许，就会长出第二份安全语义。
 */
export const toolFramePolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'self'",
  "style-src 'unsafe-inline' 'self'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: https: http:",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  // 唯一随声明变化的指令。没写 network 时取这个宽松值（保住存量工具）。
  "connect-src 'self' https: http:",
].join("; ");
