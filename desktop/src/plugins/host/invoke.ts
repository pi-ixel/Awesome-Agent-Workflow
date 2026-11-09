import {
  invoke as nativeInvoke,
  type InvokeArgs,
  type InvokeOptions,
} from "@tauri-apps/api/core";
import { appLogSink, createLogger } from "../../shared/diagnosticEvents/logger.ts";
import type { ExitDiagnostics } from "../../contracts/host.ts";
const logger = createLogger("host");
const noisy =
  /^(acp_stdin_write|pty_write|pty_resize|update_status|panel_stat|panel_watch|panel_unwatch|path_exists|list_dir_names|read_text_file)$/;
/** Log operation metadata only; arguments/results can contain user files and credentials. */
export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
  beforeExit?: ExitDiagnostics,
): Promise<T> {
  const operationId = crypto.randomUUID();
  const started = performance.now();
  const handle =
    args &&
    typeof args === "object" &&
    "handle" in args &&
    typeof args.handle === "number"
      ? args.handle
      : undefined;
  const target =
    args && typeof args === "object"
      ? Object.fromEntries(
          Object.entries(args).filter(
            ([key, value]) =>
              ["path", "project", "cwd"].includes(key) &&
              typeof value === "string",
          ),
        )
      : {};
  const context = { operationId, command, handle, ...target };
  const level = noisy.test(command) ? "debug" : "info";
  logger[level]("操作开始", { ...context, stage: "start" });
  try {
    if (beforeExit) {
      const entry = appLogSink
        .snapshot()
        .find((item) => item.context.operationId === operationId);
      await beforeExit(entry);
    }
    const result = await (options !== undefined
      ? nativeInvoke<T>(command, args, options)
      : args !== undefined
        ? nativeInvoke<T>(command, args)
        : nativeInvoke<T>(command));
    const metadata =
      result && typeof result === "object"
        ? Object.fromEntries(
            Object.entries(result).filter(
              ([key, value]) =>
                ["code", "handle", "pid"].includes(key) &&
                typeof value === "number",
            ),
          )
        : {};
    const failed = typeof metadata.code === "number" && metadata.code !== 0;
    logger[failed ? "warn" : level](
      failed ? "操作返回非零退出码" : "操作完成",
      {
        ...context,
        ...metadata,
        stage: failed ? "error" : "success",
        durationMs: Math.round(performance.now() - started),
      },
    );
    return result;
  } catch (error) {
    logger.error("操作失败", {
      ...context,
      stage: "error",
      durationMs: Math.round(performance.now() - started),
      error: String(error),
    });
    throw error;
  }
}
