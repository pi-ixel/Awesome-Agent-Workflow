/**
 * 工作区健康检查（src/aaw 领域逻辑）。
 *
 * 对所选目录逐项探测：
 * - uv 可执行（`uv --version`）；
 * - aaw CLI（`uv run <aaw.py> --help`，在所选目录下执行；只读探测，
 *   不触发 status 的自动更新逻辑）；
 * - `.sdd/` 目录存在性（不存在是「警告」而非失败——新目录合法）。
 *
 * 每项产出 通过/警告/失败 + 中文修复指引；探测经 ProcessRunner 执行，
 * 调用方（store action）异步驱动，UI 不被阻塞。
 * 全程结构化日志走 core/logger 的 aaw 通道。
 */
import { createLogger } from "../core/logger.ts";

import type { CliRunResult, ProcessRunner } from "./processRunner.ts";

const logger = createLogger("aaw");

/** 健康检查项标识。 */
export type HealthCheckItemId = string;

/** 检查结果级别：通过 / 警告 / 失败。 */
export type HealthCheckStatus = "pass" | "warn" | "fail";

/** 单项检查结果（UI 直接渲染，不再变换）。 */
export interface HealthCheckItem {
  readonly id: HealthCheckItemId;
  readonly label: string;
  readonly status: HealthCheckStatus;
  /** 结果摘要：版本号、探测耗时等（一句中文）。 */
  readonly summary: string;
  /** 中文修复指引；status 为 pass 时为空字符串。 */
  readonly fixHint: string;
  /** 该项探测耗时（毫秒）。 */
  readonly durationMs: number;
}

/** Shared tool paths preserve opaque extension keys for backwards compatibility. */
export interface WorkspaceToolPaths {
  readonly [key: string]: string | undefined;
  /** uv 可执行命令（可含路径），缺省 "uv"。 */
  readonly uvCommand: string;
  /** aaw.py 脚本路径；空字符串表示尚未配置（可从 skills 目录推导）。 */
  readonly aawScriptPath: string;
}

/** 一次健康检查的入参。 */
export interface WorkspaceHealthCheckOptions {
  /** 所选工作区目录。 */
  readonly workspacePath: string;
  readonly toolPaths: WorkspaceToolPaths;
  readonly runner: ProcessRunner;
}

/** 缺省工具路径。 */
export const defaultToolPaths: WorkspaceToolPaths = {
  uvCommand: "uv",
  aawScriptPath: "",
};

/**
 * 从 AAW skills 源目录（settings 模块的 skillsSourceDir，指向本仓库
 * skills/ 全集）推导 aaw.py 脚本路径。workspace 路径留空时用它兜底。
 */
export function deriveAawScriptPath(skillsSourceDir: string): string {
  const trimmed = skillsSourceDir.trim().replace(/[\\/]+$/, "");
  if (trimmed === "") {
    return "";
  }
  return `${trimmed}/aaw-workflow/scripts/aaw.py`;
}

/** 各项超时（毫秒）：CLI 探测宽裕（aaw 首次 uv 环境准备可能很慢）。 */
const CLI_PROBE_TIMEOUT_MS = 15_000;
const AAW_PROBE_TIMEOUT_MS = 90_000;

/** 逐项执行健康检查（项间串行，输出顺序稳定，便于 UI 对齐渲染）。 */
export async function runWorkspaceHealthChecks(
  options: WorkspaceHealthCheckOptions,
): Promise<readonly HealthCheckItem[]> {
  const { workspacePath, toolPaths, runner } = options;
  logger.info("项目健康检查开始", { workspacePath });

  // uv 与 .sdd 并行；aaw CLI 依赖 uv 的结论。
  const [uv, sdd] = await Promise.all([
    checkUv(toolPaths.uvCommand, runner),
    checkSddDir(workspacePath, runner),
  ]);
  const aaw =
    uv.status === "pass"
      ? await checkAawCli(workspacePath, toolPaths, runner)
      : skippedAawBecauseUvFailed();

  const items = [uv, aaw, sdd];
  logger.info("项目健康检查完成", {
    workspacePath,
    result: items.map((item) => `${item.id}:${item.status}`).join(" "),
  });
  return items;
}

// --------------------------------------------------------------------- 项实现

async function checkUv(
  uvCommand: string,
  runner: ProcessRunner,
): Promise<HealthCheckItem> {
  const startedAt = Date.now();
  const result = await runner.run({
    command: [uvCommand, "--version"],
    timeoutMs: CLI_PROBE_TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;
  return {
    id: "uv",
    label: "uv 可执行",
    ...summarizeVersionProbe("uv", uvCommand, result, durationMs),
    durationMs,
  };
}

async function checkAawCli(
  workspacePath: string,
  toolPaths: WorkspaceToolPaths,
  runner: ProcessRunner,
): Promise<HealthCheckItem> {
  const startedAt = Date.now();
  const { uvCommand, aawScriptPath } = toolPaths;
  if (aawScriptPath.trim() === "") {
    return {
      id: "aaw-cli",
      label: "aaw CLI（uv run）",
      status: "warn",
      summary: "尚未配置 aaw 脚本路径",
      fixHint:
        "请在下方设置中填写 aaw.py 路径（本仓库 skills/aaw-workflow/scripts/aaw.py），配置后重新检查。",
      durationMs: Date.now() - startedAt,
    };
  }
  // --help 是只读探测：不会触发 status 命令的自动更新逻辑
  const result = await runner.run({
    command: [uvCommand, "run", aawScriptPath, "--help"],
    cwd: workspacePath,
    timeoutMs: AAW_PROBE_TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;
  if (result.ok) {
    return {
      id: "aaw-cli",
      label: "aaw CLI（uv run）",
      status: "pass",
      summary: `aaw CLI 可用（耗时 ${formatMs(durationMs)}）`,
      fixHint: "",
      durationMs,
    };
  }
  return {
    id: "aaw-cli",
    label: "aaw CLI（uv run）",
    status: "fail",
    summary: describeRunFailure(result),
    fixHint:
      result.failure === "timeout"
        ? "aaw CLI 探测超时。首次运行 uv 需要联网下载依赖（typer / pyyaml），请确认网络后重试；若长期卡住，可在终端手动执行同一命令观察。"
        : "请确认 aaw 脚本路径指向本仓库 skills/aaw-workflow/scripts/aaw.py，且 uv 可用；首次运行需要联网准备依赖环境。",
    durationMs,
  };
}

function skippedAawBecauseUvFailed(): HealthCheckItem {
  return {
    id: "aaw-cli",
    label: "aaw CLI（uv run）",
    status: "fail",
    summary: "已跳过：uv 不可用，aaw CLI 无法经 uv 调用",
    fixHint: "先修复上方的 uv 检查项，aaw CLI（uv run 调用）依赖 uv。",
    durationMs: 0,
  };
}

async function checkSddDir(
  workspacePath: string,
  runner: ProcessRunner,
): Promise<HealthCheckItem> {
  const startedAt = Date.now();
  // 正斜杠拼接：Windows 的文件系统 API 同样接受
  const sddPath = `${workspacePath.replace(/[\\/]+$/, "")}/.sdd`;
  const isPresent = await runner.exists(sddPath);
  const durationMs = Date.now() - startedAt;
  if (isPresent) {
    return {
      id: "sdd-dir",
      label: ".sdd/ 流程目录",
      status: "pass",
      summary: "已找到 .sdd/ 目录",
      fixHint: "",
      durationMs,
    };
  }
  return {
    id: "sdd-dir",
    label: ".sdd/ 流程目录",
    status: "warn",
    summary: "所选目录下没有 .sdd/",
    fixHint:
      "该目录尚未初始化 AAW 工作流（.sdd/ 不存在）。可在项目总览「新建会话」，再于会话内让 agent 按 aaw-workflow 初始化；若本应存在，请确认选择的目录是否正确。",
    durationMs,
  };
}

// --------------------------------------------------------------------- 辅助

/** chrys / uv 这类 `--version` 探测的共用结果归纳。 */
function summarizeVersionProbe(
  name: string,
  command: string,
  result: CliRunResult,
  durationMs: number,
): Pick<HealthCheckItem, "status" | "summary" | "fixHint"> {
  if (result.ok) {
    const versionLine = result.stdout.trim().split("\n")[0] ?? "";
    return {
      status: "pass",
      summary:
        versionLine !== ""
          ? `${versionLine}（耗时 ${formatMs(durationMs)}）`
          : `可执行（耗时 ${formatMs(durationMs)}）`,
      fixHint: "",
    };
  }
  const hint =
    result.failure === "spawn"
      ? `无法执行 ${name}（${command}）。请到「设置」页核对 ${name} 工具路径（可写绝对路径），或将其所在目录加入 PATH 后重新检查。`
      : `${name} 探测超时或异常退出。请手动执行 \`${command} --version\` 确认其可用后重试。`;
  return {
    status: "fail",
    summary: describeRunFailure(result),
    fixHint: hint,
  };
}

/** 把执行结果压成一句中文摘要。 */
export function describeRunFailure(result: CliRunResult): string {
  if (result.failure === "spawn") {
    return "命令启动失败（不存在或不可执行）";
  }
  if (result.failure === "timeout") {
    return "命令执行超时，已被终止";
  }
  const stderrTail = result.stderr.trim().split("\n").at(-1) ?? "";
  return stderrTail !== ""
    ? `退出码 ${String(result.code)}：${stderrTail.slice(0, 200)}`
    : `退出码 ${String(result.code)}`;
}

function formatMs(durationMs: number): string {
  return durationMs >= 1_000
    ? `${(durationMs / 1_000).toFixed(1)}s`
    : `${durationMs}ms`;
}
