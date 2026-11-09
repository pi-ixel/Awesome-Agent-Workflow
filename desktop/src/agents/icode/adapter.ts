import { icodeSettingsDefaults, migrateICodeSettings } from "./settings.ts";
import type { AgentAdapter } from "../types.ts";
import {
  icodeExecutableConfiguration,
  icodeExecutable,
  initializeICodeConfiguration,
} from "./launch.ts";
import { icodeSkillInstallation } from "./skillsInstaller.ts";
import { extractEditPayload } from "./editPayload.ts";
import { readChrysArchive } from "./chrysArchive.ts";
import { createChrysDialect } from "./chrysDialect.ts";

/**
 * chrys 适配项。权威定义：D:/dev/workspace-ai/chrys/src/chrys/app/acp/
 * （server.py 的 initialize 能力声明与扩展清单、_request_permission 与
 * _chrys/request_input 结构化提问、session_manager.py、content.py）。
 *
 * 命名事实（iCode 0.30 起）：产品与命令叫 iCode（`icode acp`），但包名、
 * 配置目录（%APPDATA%/chrys）、线上的扩展前缀（chrys/*）保持 chrys——
 * 适配项沿用同一分工：id/dialect 留 chrys（内部代号与线上前缀），displayName
 * 与启动命令用 iCode（用户所见）。旧安装（只有 chrys 命令）由设置页的
 * 路径探测兜住（probeChrysPath 先找 icode 再找 chrys）。
 */
export const chrysAgentAdapter: AgentAdapter = {
  maxConcurrentRequests: 5,
  id: "chrys",
  settingsDefaults: icodeSettingsDefaults,
  migrateSettings: migrateICodeSettings,
  initializeConfiguration: initializeICodeConfiguration,
  configuredExecutable: icodeExecutable,
  executableConfiguration: icodeExecutableConfiguration,
  skillInstallation: icodeSkillInstallation,
  normalizePermission: (toolCall) => {
    const meta = toolCall._meta as
      { chrys?: { tool_name?: unknown; tool_kind?: unknown } } | undefined;
    return {
      ...toolCall,
      edit:
        (toolCall.kind ?? meta?.chrys?.tool_kind) === "edit"
          ? extractEditPayload(toolCall.rawInput)
          : null,
      toolName: meta?.chrys?.tool_name,
      kind: toolCall.kind ?? meta?.chrys?.tool_kind,
    };
  },
  displayName: "iCode",
  buildLaunch(context) {
    const program = context.executablePath?.trim() || "icode";
    return {
      command: [program, "acp"],
      cwd: context.workspacePath,
      extraEnv: {},
    };
  },
  clientInfo: { name: "aaw-desktop", version: "0.1.0" },
  createDialect(hooks) {
    return createChrysDialect({ onQuestion: hooks.onQuestion });
  },
  readArchive: readChrysArchive,
  notes: [
    "扩展通知：_chrys/runtime_update、_chrys/usage_update、_chrys/error、_chrys/warning（其余 _chrys/* 透传；0.30 起 initialize 的 field_meta 声明全部扩展方法/通知，apiVersion=1）",
    "反向请求：session/request_permission（allow_once / reject_once）、_chrys/request_input（结构化提问）",
    "能力（server.py）：loadSession、promptCapabilities.embeddedContext、sessionCapabilities.{close,list,additionalDirectories}",
  ],
};
