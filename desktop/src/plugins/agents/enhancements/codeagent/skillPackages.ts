import type { HostCommands } from "../../../host/types.ts";
import { pathKey } from "../../../../shared/panelPaths.ts";
import { resolveCodeAgentExecutable } from "./executable.ts";
import type {
  SkillPackage,
  SkillPackageManager,
} from "../../../skills/types.ts";

function installed(raw: unknown): SkillPackage[] {
  const rows: unknown = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && "plugins" in raw
      ? raw.plugins
      : null;
  if (!Array.isArray(rows))
    throw new Error("当前 CodeAgent 未返回可核对的插件清单");
  const result: SkillPackage[] = [];
  for (const row of rows as unknown[]) {
    if (
      !row ||
      typeof row !== "object" ||
      !("id" in row) ||
      !("installPath" in row) ||
      !("scope" in row)
    )
      continue;
    if (
      typeof row.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/i.test(row.id) ||
      typeof row.installPath !== "string" ||
      row.scope !== "user"
    )
      continue;
    result.push({ id: row.id, path: row.installPath });
  }
  return result;
}
export function codeAgentSkillPackages(
  host: HostCommands,
  executable: string,
): SkillPackageManager {
  async function run(args: string[]) {
    const path = await resolveCodeAgentExecutable(executable, host);
    const result = await host.runCommand(path, args);
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || "CodeAgent 插件管理命令不可用");
    return result.stdout;
  }
  async function list() {
    const help = await run(["plugin", "list", "--help"]);
    if (!help.includes("--json"))
      throw new Error(
        "当前 CodeAgent 没有提供可核对的插件安装清单，请在 Agent 中管理此插件包",
      );
    return installed(JSON.parse(await run(["plugin", "list", "--json"])));
  }
  async function nativeAction(command: "install" | "uninstall", id: string) {
    const help = await run(["plugin", command, "--help"]);
    if (!help.includes(command) || !help.includes("--scope"))
      throw new Error(
        "当前 CodeAgent 无法核对用户级插件操作，请在 Agent 中管理此插件包",
      );
    await run(["plugin", command, id, "--scope", "user"]);
  }
  return {
    async inspect(skill) {
      const path = pathKey(skill);
      const matches = (await list()).filter((pkg) =>
        path.startsWith(pathKey(pkg.path).replace(/\/$/, "") + "/"),
      );
      if (matches.length !== 1)
        throw new Error(
          "未在 CodeAgent 的用户级已安装插件中找到唯一匹配项，请在 Agent 中核对",
        );
      return matches[0]!;
    },
    async uninstall(pkg) {
      if (
        !(await list()).some(
          (p) => p.id === pkg.id && pathKey(p.path) === pathKey(pkg.path),
        )
      )
        throw new Error("已安装插件发生变化，请刷新后重试");
      await nativeAction("uninstall", pkg.id);
    },
    async install(pkg) {
      if ((await list()).some((p) => p.id === pkg.id))
        return "已跳过，插件已安装";
      if (!/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/i.test(pkg.id))
        throw new Error("插件标识无效");
      await nativeAction("install", pkg.id);
      return "已重新安装插件";
    },
  };
}
