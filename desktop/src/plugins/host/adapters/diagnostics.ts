import type { LogEntry } from "../../../shared/logging/types.ts";
import { withDeadline } from "../../../shared/asyncDeadline.ts";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { DiagnosticsHost } from "../types.ts";

/** 诊断使用原生 IPC，避免采集链路记录自己的批量写入。 */
export const diagnosticsHost: DiagnosticsHost = {
  isNative: () => isTauri(),
  request: (command, args) =>
    args === undefined ? invoke(command) : invoke(command, args),
  flush: (entry) => flushFinalDiagnostics(entry),
};

/** 采集器退役后，原生退出命令还可以保存自己的一条开始记录。 */
async function flushFinalDiagnostics(finalEntry?: LogEntry): Promise<void> {
  if (finalEntry)
    await withDeadline(
      diagnosticsHost.request("diagnostics_append", { entries: [finalEntry] }),
      500,
      "退出日志写入超时",
    ).catch(() => {});
  await withDeadline(
    diagnosticsHost.request("diagnostics_flush"),
    500,
    "诊断落盘超时",
  ).catch(() => {});
}
