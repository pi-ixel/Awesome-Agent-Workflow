/// <reference types="node" />
/**
 * Node 侧的 ProcessRunner：node:child_process execFile + fs/promises。
 *
 * 运行环境说明（同 nodeStdioTransport.ts 的约定）：本文件只在 Node 侧
 * 加载（vitest / tsx 工具脚本）；webview 前端使用 tauriProcessRunner。
 * 领域逻辑（healthChecks / aawCli）只认 ProcessRunner 接口，
 * 测试注入 fake 实现即可脱离真实进程。
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";

import type { CliRunOptions, CliRunResult, CliFailureKind, ProcessRunner } from "../types.ts";

/** execFile 的 Node 错误对象上我们关心的字段（类型收窄用）。 */
interface ExecFileError extends Error {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
}

export function createNodeProcessRunner(): ProcessRunner {
  return {
    run(options: CliRunOptions): Promise<CliRunResult> {
      const startedAt = Date.now();
      const [file, ...args] = options.command;
      if (typeof file !== "string" || file.length === 0) {
        return Promise.resolve({
          ok: false,
          code: -1,
          stdout: "",
          stderr: "command 不能为空",
          failure: "spawn",
          durationMs: 0,
        });
      }
      return new Promise<CliRunResult>((resolve) => {
        execFile(
          file,
          args,
          {
            cwd: options.cwd,
            timeout: options.timeoutMs ?? 30_000,
            encoding: "utf8",
            // Windows 上不弹控制台窗口（与 Rust 端 CREATE_NO_WINDOW 对齐）
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({
                ok: true,
                code: 0,
                stdout: stdout ?? "",
                stderr: stderr ?? "",
                durationMs: Date.now() - startedAt,
              });
              return;
            }
            const execError = error as ExecFileError;
            const exitCode =
              typeof execError.code === "number" ? execError.code : -1;
            resolve({
              ok: false,
              code: exitCode,
              stdout: stdout ?? "",
              stderr: stderr !== "" ? stderr : execError.message,
              failure: classifyFailure(execError),
              durationMs: Date.now() - startedAt,
            });
          },
        );
      });
    },
    async exists(path: string): Promise<boolean> {
      try {
        await stat(path);
        return true;
      } catch {
        // 不存在或不可访问（如坏网络盘）：统一按不存在处理，
        // 健康检查项负责给出修复指引
        return false;
      }
    },
  };
}

/** 区分启动失败与超时：命令不存在等返回字符串 code；超时被杀带 killed。 */
function classifyFailure(error: ExecFileError): CliFailureKind | undefined {
  if (error.killed === true) {
    return "timeout";
  }
  if (typeof error.code === "number") {
    // 正常执行但退出码非零：不是执行失败类别
    return undefined;
  }
  return "spawn";
}
