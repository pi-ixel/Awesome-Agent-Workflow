import type {
  AgentSettingsAccess,
  AgentSettingsData,
} from "../../configuration/types.ts";
import { migrateICodePath } from "./legacyConfiguration.ts";
import type { AgentConfigurationContext } from "../../registry/adapterTypes.ts";
export const icodeSettingsDefaults = { executablePath: "" };
export const defaultConnection: ConnectionStatus = {
  status: "idle",
  message: "尚未检测",
  checkedAt: null,
};
export function migrateICodeSettings(
  stored: AgentSettingsData | undefined,
  legacy: Readonly<Record<string, unknown>>,
): AgentSettingsData {
  return {
    ...stored,
    executablePath: migrateICodePath(
      stored === undefined ? legacy.chrysPath : stored.executablePath,
      "",
    ),
  };
}

export function readICodeConfiguredPath(settings: object): string {
  const path = (settings as AgentSettingsAccess).getAgentSettings("chrys")
    .executablePath;
  return typeof path === "string" ? path : "";
}

/** Adapter-owned facade. Shared settings storage knows neither these fields nor actions. */
export function icodeSettings(
  context: object,
  runtime: AgentConfigurationContext,
) {
  const access = context as AgentSettingsAccess;
  const get = () => ({
    chrysPath: readICodeConfiguredPath(access),
    isProbingChrysPath: access.getAgentSettingsState("chrys").probing === true,
    connection:
      (access.getAgentSettingsState("chrys").connection as ConnectionStatus) ??
      defaultConnection,
  });
  const apply = (patch: { chrysPath: string }) =>
    access.setAgentSettings("chrys", { executablePath: patch.chrysPath });
  const set = (
    patch: Partial<LegacySettingsState> & { connection?: ConnectionStatus },
  ) =>
    access.setAgentSettingsState("chrys", {
      ...(patch.isProbingChrysPath === undefined
        ? {}
        : { probing: patch.isProbingChrysPath }),
      ...(patch.connection === undefined
        ? {}
        : { connection: patch.connection }),
    });
  return {
    ...get(),
    ...createICodeSettingsActions(get, set, apply, runtime),
    setChrysPath: (path: string) => {
      apply({ chrysPath: path });
      set({
        connection: {
          status: "idle",
          message: "路径已变更，请重新测试",
          checkedAt: null,
        },
      });
    },
  };
}
import type { CommandResult } from "../../../host/types.ts";
import { createLogger } from "../../../../shared/logging/logger.ts";
import { probeICodePath as probeChrysPath } from "./probe.ts";

export interface ConnectionStatus {
  readonly status: "idle" | "testing" | "ok" | "error";
  readonly message: string;
  readonly checkedAt: string | null;
}
interface LegacySettingsState {
  readonly chrysPath: string;
  readonly isProbingChrysPath: boolean;
}
/** Legacy keys stay stable; all ICode probing and validation lives here. */
function createICodeSettingsActions(
  get: () => LegacySettingsState,
  set: (
    patch: Partial<LegacySettingsState> & { connection?: ConnectionStatus },
  ) => void,
  applySettings: (patch: { chrysPath: string }) => void,
  { commands: host, signal, createLogger: loggerFactory = createLogger }: AgentConfigurationContext,
) {
  const logger = loggerFactory("settings");
  /** 应用一次命令结果：testConnection 的归约器。 */
  function applyConnectionResult(result: CommandResult): void {
    const next: ConnectionStatus =
      result.code === 0
        ? {
            status: "ok",
            message:
              result.stdout.trim().length > 0
                ? `可用（版本 ${result.stdout.trim()}）`
                : "可用（无版本输出）",
            checkedAt: new Date().toISOString(),
          }
        : {
            status: "error",
            message:
              result.stderr.trim().length > 0
                ? result.stderr.trim()
                : `命令以退出码 ${result.code} 结束`,
            checkedAt: new Date().toISOString(),
          };
    logger.info("iCode 连接检测完成", {
      code: result.code,
      ok: next.status === "ok",
    });
    set({ connection: next });
  }

  return {
    testConnection: async () => {
      if (signal?.aborted) return;
      const program = get().chrysPath;
      if (program.trim() === "") {
        // 空路径（未配置且未探测到）：直接失败收口，不执行空命令
        set({
          connection: {
            status: "error",
            message:
              "未配置 iCode 可执行路径，请手动填写或重新打开应用自动探测",
            checkedAt: new Date().toISOString(),
          },
        });
        return;
      }
      set({
        connection: {
          status: "testing",
          message: `正在执行 ${program} --version …`,
          checkedAt: null,
        },
      });
      logger.info("测试 iCode 连接", { program });
      let result: CommandResult;
      try {
        result = await host.runCommand(program, ["--version"]);
      } catch (error) {
        result = {
          code: -1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      if (!signal?.aborted) applyConnectionResult(result);
    },
    probeChrysPathIfNeeded: async (force = false) => {
      const previousPath = get().chrysPath;
      if (signal?.aborted || get().isProbingChrysPath) {
        return;
      }
      if (!force && previousPath.trim() !== "") {
        // 已有路径默认直通（含用户持久化值）。但绝对路径可能失效（开发
        // venv 被删/移动）：先复检存在性，失效则视为未配置走重探治愈。
        // 裸命令名交给 PATH 解析，不做存在性检查；复检失败保守不覆盖。
        if (!/[\\/]/.test(previousPath)) return;
        try {
          if (await host.pathExists(previousPath)) return;
        } catch {
          return;
        }
        if (signal?.aborted) return;
        logger.warn("已配置的 iCode 路径不存在，自动重新探测", {
          chrysPath: previousPath,
        });
      }
      set({ isProbingChrysPath: true });
      try {
        const found = await probeChrysPath(host, signal);
        if (signal?.aborted) return;
        if (found !== null && get().chrysPath === previousPath) {
          // 探测结果写入并持久化（用户在探测期间手动填写的值不覆盖）
          applySettings({ chrysPath: found });
          logger.info("已自动探测到 iCode 路径", { chrysPath: found });
        } else if (found === null) {
          logger.warn(
            "未在 PATH 与常见位置找到 iCode（icode/chrys），请在设置中手动指定路径",
          );
        }
      } finally {
        set({ isProbingChrysPath: false });
      }
    },
  };
}
