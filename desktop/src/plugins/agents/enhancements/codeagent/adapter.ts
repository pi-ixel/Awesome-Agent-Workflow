import { createCodeAgentDialect, normalizePermission } from "./dialect.ts";
import { prepareCodeAgentLaunch } from "./executable.ts";
import type { AgentAdapter } from "../../registry/adapterTypes.ts";
import {
  executableConfiguration,
  configuredExecutable,
  initializeConfiguration,
} from "./settings.ts";

/** Standard ACP plus isolated tool/subagent, plan and configuration compatibility. */
export const codeAgentAdapter: AgentAdapter = {
  maxConcurrentRequests: 3,
  id: "codeagent",
  promptUsageBasis: "prompt-total",
  displayName: "CodeAgent",
  promptUsage: { accounting: "turn" },
  settingsDefaults: { executablePath: "" },
  configuredExecutable,
  executableConfiguration,
  initializeConfiguration,
  cancellationGraceMs: 5000,
  createDialect: () => createCodeAgentDialect(),
  normalizePermission,
  prepareLaunch: prepareCodeAgentLaunch,
  buildLaunch({ executablePath, workspacePath }) {
    return {
      command: [executablePath?.trim() || "codeagent", "acp"],
      cwd: workspacePath,
      extraEnv: {},
    };
  },
  clientInfo: { name: "aaw-desktop", version: "0.1.0" },
  notes: [
    "启动命令：codeagent acp",
    "增强：真实工具名、子代理进度与历史、模型/模式确认、TodoWrite 计划与轮次后标题刷新；标准权限与表单。",
    "标准取消后等待 5 秒，仍未结束则终止当前 Agent 进程树；不代表对端已回滚工具操作。",
  ],
};
