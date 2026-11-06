import { createCodeAgentDialect, normalizePermission } from "./dialect.ts";
import type { AgentAdapter } from "../types.ts";
import {
  executableConfiguration,
  configuredExecutable,
  initializeConfiguration,
} from "./settings.ts";

/** Standard ACP plus isolated tool/subagent, plan and configuration compatibility. */
export const codeAgentAdapter: AgentAdapter = {
  id: "codeagent",
  displayName: "CodeAgent",
  settingsDefaults: { executablePath: "" },
  configuredExecutable,
  executableConfiguration,
  initializeConfiguration,
  cancellationGraceMs: 5000,
  createDialect: () => createCodeAgentDialect(),
  normalizePermission,
  buildLaunch({ executablePath, workspacePath }) {
    return {
      command: [executablePath?.trim() || "codeagent", "acp"],
      cwd: workspacePath,
      extraEnv: {},
    };
  },
  clientInfo: { name: "aaw-desktop" },
  notes: [
    "启动命令：codeagent acp",
    "增强：真实工具名、子代理进度与历史、模型/模式确认、TodoWrite 计划与轮次后标题刷新；标准权限与表单。",
    "标准取消后等待 5 秒，仍未结束则终止当前 Agent 进程树；不代表对端已回滚工具操作。",
  ],
};
