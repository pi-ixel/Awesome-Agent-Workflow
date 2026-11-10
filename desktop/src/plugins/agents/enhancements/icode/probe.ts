import { joinPath } from "../../../../shared/panelPaths.ts";
import type { HostAgentCommands } from "../../../host/types.ts";

/**
 * 探测的命令名与顺序：iCode 0.30 起只安装 `icode` 命令，旧版装的是
 * `chrys`——先找新名，找不到再回落旧名，两种安装都能命中。
 */
const PROBE_PROGRAM_NAMES: readonly string[] = ["icode", "chrys"];

/** 探测不到 PATH 时依次尝试的常见安装位置（存在即采纳；新名在前）。 */
const CHRYS_FALLBACK_CANDIDATES: readonly string[] = [
  "C:/Program Files/Chrys/icode.exe",
  "C:/Program Files (x86)/Chrys/icode.exe",
  "D:/Program Files/Chrys/icode.exe",
  "C:/Program Files/Chrys/chrys.exe",
  "C:/Program Files (x86)/Chrys/chrys.exe",
  "D:/Program Files/Chrys/chrys.exe",
];

/** 取命令输出里的首个非空行（PATH 查找结果的第一条路径）。 */
function firstOutputLine(stdout: string): string | null {
  const line = stdout
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? null;
}

/**
 * 异步探测 iCode（原 chrys）可执行路径：先在 PATH 里找（Windows 的 where
 * 与类 Unix 的 which 各试一次，spawn 失败按未命中处理；命令名先 icode 后
 * chrys，覆盖新旧两种安装），再回落常见安装位置与用户级 chrys 目录。
 * 找到返回绝对路径，探测不到返回 null。宿主可注入（测试用内存宿主布置
 * 现场）。
 */
export async function probeICodePath(
  host: HostAgentCommands,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null;
  // 用户级新安装位置优先，避免 PATH 仍指向迁移前的旧程序。
  try {
    const home = await host.homeDir?.();
    if (home) {
      for (const name of ["icode.exe", "icode"]) {
        if (signal?.aborted) return null;
        const candidate = joinPath(home, ".local", "bin", name);
        if (await host.pathExists(candidate)) {
          if (signal?.aborted) return null;
          const result = await host.runCommand(candidate, ["--version"]);
          if (result.code === 0) return candidate;
        }
      }
    }
  } catch {
    // 旧宿主或用户级安装不可用，继续 PATH 探测。
  }
  // PATH 查找：where / which 谁可用用谁（失败一律继续，不猜测平台）
  for (const program of PROBE_PROGRAM_NAMES) {
    for (const lookup of ["where", "which"]) {
      if (signal?.aborted) return null;
      try {
        const result = await host.runCommand(lookup, [program]);
        if (result.code === 0) {
          const found = firstOutputLine(result.stdout);
          if (found !== null) {
            return found;
          }
        }
      } catch {
        // 该查找命令不存在 / 宿主不支持：继续下一个探测手段
      }
    }
  }
  // 常见安装位置
  for (const candidate of CHRYS_FALLBACK_CANDIDATES) {
    if (signal?.aborted) return null;
    try {
      if (await host.pathExists(candidate)) {
        return candidate;
      }
    } catch {
      // pathExists 失败按未命中处理
    }
  }
  // 用户级 chrys 目录下的可执行（%APPDATA%/chrys/icode.exe 等；目录名
  // 保持 chrys 是上游约定——包名与配置目录不随品牌改名）
  if (signal?.aborted) return null;
  try {
    const skillsDir = await host.userDataDir("chrys", "skills");
    for (const name of PROBE_PROGRAM_NAMES) {
      if (signal?.aborted) return null;
      const candidate = joinPath(skillsDir, "..", `${name}.exe`);
      if (await host.pathExists(candidate)) {
        return candidate;
      }
    }
  } catch {
    // 宿主不支持：忽略
  }
  return null;
}
