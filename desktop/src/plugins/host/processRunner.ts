/**
 * Tauri webview 侧的 ProcessRunner：经 invoke 调用 Rust command
 * （src-tauri/src/commands.rs 的 run_command / path_exists——与
 * src/core/host.ts 的宿主契约共用同一组 command，本层额外携带
 * cwd 与超时）。
 *
 * 只依赖 @tauri-apps/api，浏览器安全（不触发 Node 内置模块打包）。
 * invoke 的调用错误（如非 Tauri 环境调用）转成结构化 spawn 失败，
 * 保证调用方拿到的永远是 CliRunResult / boolean，不需要 try/catch。
 */
import { invoke } from "./invoke.ts";

import { isTauriEnv } from "./host.ts";
import { createBridgeProcessRunner } from "./dev/bridgeClient.ts";
import {
  describeUnknownError,
  type CliRunResult,
  type ProcessRunner,
  type CliRunOptions,
} from "../../contracts/processRunner.ts";

/** Rust 端返回的 JSON 形状（commands.rs CliRunResult 的 serde 序列化）。 */
interface RawCliRunResult {
  readonly ok?: unknown;
  readonly code?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly failure?: unknown;
  readonly durationMs?: unknown;
}

function normalizeFailure(failure: unknown): CliRunResult["failure"] {
  return failure === "spawn" || failure === "timeout" ? failure : undefined;
}

export function createTauriProcessRunner(): ProcessRunner {
  return {
    async run(options: CliRunOptions): Promise<CliRunResult> {
      const [program, ...args] = options.command;
      if (typeof program !== "string" || program.length === 0) {
        return {
          ok: false,
          code: -1,
          stdout: "",
          stderr: "command 不能为空",
          failure: "spawn",
          durationMs: 0,
        };
      }
      try {
        const raw = await invoke<RawCliRunResult>("run_command", {
          program,
          args,
          cwd: options.cwd ?? null,
          timeoutMs: options.timeoutMs ?? null,
        });
        const code = typeof raw.code === "number" ? raw.code : -1;
        return {
          ok: raw.ok === true && code === 0,
          code,
          stdout: typeof raw.stdout === "string" ? raw.stdout : "",
          stderr: typeof raw.stderr === "string" ? raw.stderr : "",
          failure: normalizeFailure(raw.failure),
          durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
        };
      } catch (error) {
        // 非 Tauri 环境 / IPC 断连：视为启动失败，给出可读原因
        return {
          ok: false,
          code: -1,
          stdout: "",
          stderr: describeUnknownError(error),
          failure: "spawn",
          durationMs: 0,
        };
      }
    },
    async exists(path: string): Promise<boolean> {
      try {
        return (await invoke<boolean>("path_exists", { path })) === true;
      } catch {
        // 探测失败按「不存在」处理，健康检查项会给出修复指引
        return false;
      }
    },
  };
}

/**
 * 应用运行时的缺省 runner：Tauri webview → 本文件的 IPC 实现；
 * dev 浏览器（npm run dev:web）→ dev bridge 实现（src/dev/bridgeClient.ts，
 * vite 内嵌插件代为执行）；其余环境（vitest）→ IPC 实现（调用即
 * spawn 失败形状，测试经 vi.mock 替换整个模块）。生产构建把 DEV
 * 折叠为 false，bridge 分支为死代码、bridgeClient 被摇出产物。
 */
export function createHostProcessRunner(): ProcessRunner {
  return import.meta.env.DEV && !import.meta.env.VITEST && !isTauriEnv()
    ? createBridgeProcessRunner()
    : createTauriProcessRunner();
}
