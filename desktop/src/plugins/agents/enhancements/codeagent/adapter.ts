import { createCodeAgentDialect, normalizePermission } from "./dialect.ts";
import { codeAgentSkillPackages } from "./skillPackages.ts";
import { prepareCodeAgentLaunch,
  resolveCodeAgentExecutable,
} from "./executable.ts";
import type { AgentAdapter } from "../../registry/adapterTypes.ts";
import {
  executableConfiguration,
  configuredExecutable,
  initializeConfiguration,
} from "./settings.ts";

/** Standard ACP plus isolated tool/subagent, plan and configuration compatibility. */
export const codeAgentAdapter: AgentAdapter = {
  maxConcurrentRequests: 3,
  async deleteSession(host, launch, sessionId) {
    if (!host.deleteAgentSession || !launch.cwd)
      throw new Error("当前宿主不支持彻底删除会话");
    if (
      launch.command.length !== 2 ||
      launch.command[1] !== "acp" ||
      Object.keys(launch.extraEnv).length
    )
      throw new Error("无法核验 CodeAgent 启动配置");
    let program = launch.command[0] ?? "codeagent";
    try {
      program = await resolveCodeAgentExecutable(program, host);
    } catch {
      /* 可执行文件缺失时仍进入原生文件删除兜底。 */
    }
    await host.deleteAgentSession("codeagent", program, sessionId, launch.cwd);
  },
  supportsSteer: true,
  imageOnlyPromptFallback: true,
  readHistoryEvidence: async (host, sessionId, cwd) => await host.readAgentHistoryEvidence?.("codeagent", sessionId, cwd) ?? null,
  usageModelId: (model) => model && !model.includes("/") ? `w3/${model}` : model,
  id: "codeagent",
  skillLibrary: "codeagent",
  slashSkillSource: "catalog",
  skillPackages: codeAgentSkillPackages,
  promptUsageBasis: "prompt-total",
  displayName: "CodeAgent",
  promptUsage: { accounting: "turn-delta" },
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
