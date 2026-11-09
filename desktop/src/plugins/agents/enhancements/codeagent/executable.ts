import type { HostCommands } from "../../../../contracts/host.ts";
import type { AgentLaunch } from "../../../../contracts/agentAdapter.ts";

export async function prepareCodeAgentLaunch(
  launch: AgentLaunch,
  host: HostCommands,
  signal?: AbortSignal,
): Promise<AgentLaunch> {
  const program = await resolveCodeAgentExecutable(
    launch.command[0] ?? "codeagent",
    host,
    signal,
  );
  return { ...launch, command: [program, ...launch.command.slice(1)] };
}

/** 显式 Windows 路径不接受无扩展名脚本；只在同目录查找可启动入口。 */
export async function resolveCodeAgentExecutable(
  value: string,
  host: HostCommands,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const path = value.trim();
  if (!/[\\/]/.test(path)) return path || "codeagent";
  const windows = /^[a-z]:[\\/]|^\\\\|^\/\//i.test(path);
  if (windows && !/\.[^\\/]+$/.test(path)) {
    for (const extension of [".exe", ".cmd", ".bat"]) {
      signal?.throwIfAborted();
      if (await host.pathExists(path + extension)) return path + extension;
    }
    throw new Error(
      "CodeAgent 路径没有可用的 Windows 启动入口，请选择 .exe、.cmd 或 .bat，或清空路径使用 PATH",
    );
  }
  if (windows && !/\.(exe|cmd|bat)$/i.test(path))
    throw new Error(
      "CodeAgent 路径类型不支持，请选择 .exe、.cmd 或 .bat，或清空路径使用 PATH",
    );
  if (!(await host.pathExists(path)))
    throw new Error(
      "CodeAgent 路径不存在，请重新检测或修改路径；清空路径可使用 PATH",
    );
  return path;
}
