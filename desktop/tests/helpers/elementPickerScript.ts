/**
 * 从 Rust 原始字符串中加载唯一拾取脚本源，并替换会话身份占位。
 * 测试不复制脚本实现，避免测试与真实注入内容漂移。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadElementPickerScript(
  sessionId = "session-a",
  tabId = "tab-1",
  generation = 1,
): string {
  const path = resolve(process.cwd(), "src-tauri/src/browser/enhancements.rs");
  const source = readFileSync(path, "utf8");
  const marker = 'let script = r#"';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("未找到拾取脚本起点");
  const bodyStart = start + marker.length;
  const end = source.indexOf('"#;', bodyStart);
  if (end < 0) throw new Error("未找到拾取脚本终点");
  return source
    .slice(bodyStart, end)
    .replace("__AAW_SESSION_JSON__", JSON.stringify(sessionId))
    .replace("__AAW_TAB_JSON__", JSON.stringify(tabId))
    .replace("__AAW_GENERATION__", String(generation));
}
