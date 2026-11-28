import { expect, it, vi } from "vitest";
import type {
  AgentInitialized,
  AgentsService,
} from "../../../../../src/plugins/agents/service.ts";
import type { NativeSkillLibrary } from "../../../../../src/plugins/host/types.ts";
import type { WorkbenchService } from "../../../../../src/plugins/workbench/service.ts";
import type { InitializeResult } from "../../../../../src/contracts/acp/protocol.ts";
import { codeAgentAdapter } from "../../../../../src/plugins/agents/enhancements/codeagent/adapter.ts";
import {
  bindCleanupFeedback,
  installSkillCleanup,
  registerSkillCleanup,
} from "../../../../../src/plugins/agents/enhancements/codeagent/skillCleanup.ts";

function setup(
  cleanupCodeAgent: NonNullable<NativeSkillLibrary["cleanupCodeAgent"]>,
) {
  let initialized!: AgentInitialized;
  const release = vi.fn();
  const agents: Pick<AgentsService, "registerInitialized"> = {
    registerInitialized: (listener) => {
      initialized = listener;
      return release;
    },
  };
  const notify = vi.fn<WorkbenchService["showToast"]>();
  const dispose = registerSkillCleanup(
    agents,
    { cleanupCodeAgent } as NativeSkillLibrary,
    notify,
  );
  const info = {
    agentInfo: { name: "CodeAgent", version: "1" },
  } as InitializeResult;
  const launch = {
    command: ["C:/CodeAgent/codeagent.exe", "acp"],
    cwd: null,
    extraEnv: {},
  };
  return {
    run: () => initialized(codeAgentAdapter, launch, info),
    initialized,
    info,
    launch,
    dispose,
    release,
    notify,
  };
}

it("握手信息触发清理，原样传递版本；不启动额外 CLI 或扫描技能库", async () => {
  const cleanup = vi.fn().mockResolvedValue([]);
  const s = setup(cleanup);
  await s.run();
  expect(cleanup).toHaveBeenCalledWith(
    expect.stringContaining("codeagent.exe"),
    "1",
  );
  expect(s.notify).not.toHaveBeenCalled();
  await s.initialized(codeAgentAdapter, s.launch, {
    ...s.info,
    agentInfo: { ...s.info.agentInfo, version: "2" },
  });
  expect(cleanup).toHaveBeenLastCalledWith(expect.any(String), "2");
  s.dispose();
  expect(s.release).toHaveBeenCalledOnce();
});

it("非 CodeAgent 和远端启动均不清理本机技能", async () => {
  const cleanup = vi.fn().mockResolvedValue([]);
  const s = setup(cleanup);
  await s.initialized({ ...codeAgentAdapter, id: "other" }, s.launch, s.info);
  await s.initialized(
    codeAgentAdapter,
    { ...s.launch, cwd: "//aaw-remote/host/work/project" },
    s.info,
  );
  expect(cleanup).not.toHaveBeenCalled();
});

it("异常不阻断握手，后续使用可重试；混合结果准确提示部分失败", async () => {
  const cleanup = vi
    .fn()
    .mockRejectedValueOnce(new Error("拒绝访问"))
    .mockResolvedValueOnce([
      { name: "mr-review", ok: true },
      { name: "auto-verify", ok: false, message: "文件占用" },
    ]);
  const s = setup(cleanup);
  await expect(s.run()).resolves.toBeUndefined();
  expect(s.notify).toHaveBeenLastCalledWith(
    expect.objectContaining({ variant: "danger" }),
  );
  await expect(s.run()).resolves.toBeUndefined();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(s.notify).toHaveBeenLastCalledWith(
    expect.objectContaining({ variant: "warn" }),
  );
  expect(s.notify.mock.lastCall?.[0].message).toContain(
    "已删除 1 项，失败 1 项",
  );
});

it("插件退出后不再发起清理，也不显示迟到的反馈", async () => {
  let finish!: (v: unknown[]) => void;
  const cleanup = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const s = setup(cleanup);
  const task = s.run();
  s.dispose();
  finish([{ ok: true }]);
  await task;
  await s.run();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(s.notify).not.toHaveBeenCalled();
});

it("项目预热先于工作台时也清理，工作台挂载后只补发一次反馈", async () => {
  let initialized!: AgentInitialized;
  const release = vi.fn();
  const agents = {
    registerInitialized: (listener: AgentInitialized) => {
      initialized = listener;
      return release;
    },
  };
  const cleanupCodeAgent = vi
    .fn()
    .mockResolvedValue([
      { name: "mr-review", ok: true, message: "已永久删除" },
    ]);
  const dispose = installSkillCleanup(agents, {
    cleanupCodeAgent,
    list: vi.fn(),
    change: vi.fn(),
    candidates: vi.fn(),
  });
  await initialized(
    codeAgentAdapter,
    { command: ["codeagent"], cwd: null, extraEnv: {} },
    { agentInfo: { name: "CodeAgent", version: "1" } } as InitializeResult,
  );
  expect(cleanupCodeAgent).toHaveBeenCalledOnce();
  const first = vi.fn();
  const unbind = bindCleanupFeedback(agents, first);
  expect(first).toHaveBeenCalledOnce();
  expect(first).toHaveBeenCalledWith(
    expect.objectContaining({ variant: "ok" }),
  );
  unbind();
  const second = vi.fn();
  bindCleanupFeedback(agents, second);
  expect(second).not.toHaveBeenCalled();
  dispose();
  expect(release).toHaveBeenCalledOnce();
});
