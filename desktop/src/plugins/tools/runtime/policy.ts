/**
 * 工具运行时的内容安全策略。
 *
 * 与 `tools-runtime/runtime.mjs` 里那份必须一致——预览要是比真实窗口松，用户
 * 就会"预览能跑、打开就废"；比真实窗口紧，则会冤枉工具。`policy.test.ts` 会
 * 拿两边的指令集合做比对，改一处必须改另一处。
 */
export const toolFramePolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https: http:",
  "font-src data:",
  "media-src data: blob: https: http:",
  "connect-src https: http:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
