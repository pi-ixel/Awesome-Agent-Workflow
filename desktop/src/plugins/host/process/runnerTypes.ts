/**
 * 外部命令执行抽象（src/aaw 进程调用封装的接口层）。
 *
 * 工作区健康检查等外部命令调用都经由 `ProcessRunner` 完成，不直接触碰
 * 具体运行时：
 * - Tauri webview 侧用 `tauriProcessRunner`（invoke Rust command）；
 * - Node 侧（vitest / tsx 工具脚本）用 `nodeProcessRunner`；
 * - 测试用任意 fake 实现即可注入，领域逻辑（healthChecks / aawCli）
 *   运行环境通过宿主进程端口注入，与 `acpTransport.ts` 的设计一致。
 *
 * 与 `host.ts` 的 HostRuntime 分工：Host 面向设置 / Skills 的
 * 宿主能力（runCommand 无 cwd 需求，非 Tauri 环境回落内存替身实现）；
 * 本接口面向在项目目录里执行的命令——必须携带 cwd 与超时，且非 Tauri
 * 环境仍要真探测（Node 子进程），因此独立成一层进程封装。两个前端抽象共用同一组 Rust command
 * （run_command / path_exists，见 src-tauri/src/commands.rs）。
 *
 * 全程无 any：进程输出以 string 进入，失败类别用字面量联合类型收窄。
 */

/** 一次命令执行的失败类别。 */
export type CliFailureKind = "spawn" | "timeout";

/** 一次命令执行结果（对齐 Rust 端 commands.rs 的 CliRunResult）。 */
export interface CliRunResult {
  /** 退出码为 0 且无执行失败时 true；超时 / 启动失败为 false。 */
  readonly ok: boolean;
  /** 进程退出码；启动失败或超时被杀时为 -1（对齐 CommandResult 语义）。 */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** 失败类别；成功执行（无论退出码）为 undefined。 */
  readonly failure?: CliFailureKind;
  /** 实际耗时（毫秒）。 */
  readonly durationMs: number;
}

/** 进程执行选项。 */
export interface CliRunOptions {
  /** 完整 argv，如 ["uv", "run", "aaw.py", "status", "--json"]。 */
  readonly command: readonly string[];
  /** 工作目录（命令在项目目录里执行时必填）。 */
  readonly cwd?: string;
  /** 超时（毫秒）；缺省由实现决定。 */
  readonly timeoutMs?: number;
}

/** 进程执行与文件系统探测的运行时抽象。 */
export interface ProcessRunner {
  /** 执行命令并等待退出；命令不存在等启动失败不抛出，落进 failure 字段。 */
  run(options: CliRunOptions): Promise<CliRunResult>;
  /** 探测文件系统路径存在性（文件或目录均可）。 */
  exists(path: string): Promise<boolean>;
}
