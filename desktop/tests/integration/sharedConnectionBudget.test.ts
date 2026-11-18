import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAcpConnection } from "../../src/plugins/acpConnection/lifecycle/connectionService.ts";
import { RuntimeConnections } from "../../src/plugins/acpRuntime/sessions/connections.ts";
import type { AgentAdapter } from "../../src/plugins/agents/types.ts";
import type { HostService } from "../../src/plugins/host/service.ts";
import { Logger } from "../../src/shared/logging/logger.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

const fixtures: { runtime: RuntimeConnections; base: DesktopAcpConnection }[] =
  [];
function fixture() {
  const peers: { agent: string; peer: ReturnType<typeof standardAcpPeer> }[] =
    [];
  const base = new DesktopAcpConnection({} as HostService, {});
  let peak = 0;
  let sequence = 0;
  const agents = {
    selectedId: "a",
    buildLaunch: (agent: AgentAdapter, tools: object) => ({
      ...agent.buildLaunch({ workspacePath: null }),
      extraEnv: { configuration: JSON.stringify(tools) },
    }),
    openTransport: vi.fn((agent: AgentAdapter) => {
      const peer = standardAcpPeer();
      peer.handlers.set("session/new", () => ({
        sessionId: `s-${++sequence}`,
      }));
      peers.push({ agent: agent.id, peer });
      peak = Math.max(
        peak,
        peers.filter(({ peer }) => !peer.client.isClosed).length,
      );
      expect(peak).toBeLessThanOrEqual(4);
      return Promise.resolve(peer.client);
    }),
  };
  const runtime = new RuntimeConnections(
    base,
    agents,
    new Logger({ log: () => undefined }, "test"),
  );
  const result = { peers, base, runtime, agents, peak: () => peak };
  fixtures.push(result);
  return result;
}
const adapter = (id: string): AgentAdapter => ({
  id,
  displayName: id,
  notes: [],
  clientInfo: { name: "budget-test" },
  maxConcurrentRequests: 1,
  buildLaunch: () => ({ command: [id], cwd: null, extraEnv: {} }),
});
afterEach(async () => {
  for (const { runtime, base } of fixtures.splice(0)) {
    await runtime.dispose({ force: true });
    await base.shutdown();
  }
});

describe("Desktop 共享 ACP 总额度", () => {
  it("其他配置慢启动时，健康配置仍可准备及分配后台会话", async () => {
    const { runtime, agents } = fixture();
    await runtime.prepare(adapter("a"), "a", {});
    const create = agents.openTransport.getMockImplementation()!;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    agents.openTransport.mockImplementation(async (agent) => {
      if (agent.id === "b") await gate;
      return create(agent);
    });
    const slow = runtime.openBackground(adapter("b"), {}, { background: true });
    let prepared = false;
    let acquired = false;
    await vi.waitFor(() =>
      expect(agents.openTransport).toHaveBeenCalledTimes(5),
    );
    const prepare = runtime.prepare(adapter("a"), "a", {}).then(() => {
      prepared = true;
    });
    const fast = runtime
      .openBackground(adapter("a"), {}, { background: true })
      .then((session) => {
        acquired = true;
        return session;
      });
    try {
      await vi.waitFor(
        () => {
          expect(prepared).toBe(true);
          expect(acquired).toBe(true);
        },
        { timeout: 500 },
      );
    } finally {
      finish();
      await prepare;
      await Promise.all(
        [slow, fast].map(async (pending) => runtime.release(await pending)),
      );
    }
  });

  it("同配置的普通会话、多个任务及模型读取复用四条物理连接", async () => {
    const { runtime, peers, base } = fixture();
    await runtime.prepare(adapter("a"), "a", {});
    const ordinary = runtime.open("a");
    const tasks = await Promise.all(
      Array.from({ length: 9 }, () =>
        runtime.openBackground(adapter("a"), {}, { background: true }),
      ),
    );
    await Promise.all(
      [ordinary, ...tasks].map(async (session) => {
        await session.initialize();
        await session.newSession("/project");
      }),
    );
    expect(peers).toHaveLength(4);
    expect(
      new Set(
        base
          .diagnostics()
          .flatMap(({ sessions }) => sessions.map(({ id }) => id)),
      ).size,
    ).toBe(10);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    for (const { peer } of peers)
      peer.handlers.set("session/prompt", async () => {
        await gate;
        return { stopReason: "end_turn" };
      });
    const prompts = tasks.map((session) => session.prompt("并发任务"));
    await vi.waitFor(() =>
      expect(
        peers
          .flatMap(({ peer }) => peer.received)
          .filter(({ method }) => method === "session/prompt"),
      ).toHaveLength(4),
    );
    expect(
      base
        .diagnostics()
        .flatMap(({ sessions }) => sessions)
        .filter(({ running }) => running),
    ).toHaveLength(4);
    finish();
    await Promise.all(prompts);
    await Promise.all(tasks.map((session) => runtime.release(session)));
    expect(base.diagnostics()).toHaveLength(4);
    expect(base.diagnostics().flatMap(({ sessions }) => sessions)).toHaveLength(
      1,
    );
    await runtime.release(ordinary);
  });

  it("满额时不同配置等待归还租约，不启动第五个进程", async () => {
    const { runtime, peers, base } = fixture();
    await runtime.prepare(adapter("a"), "a", {});
    const occupied = Array.from({ length: 4 }, () => runtime.open("a"));
    let started = false;
    const next = runtime
      .openBackground(adapter("b"), {}, { background: true })
      .then((session) => {
        started = true;
        return session;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(false);
    expect(peers).toHaveLength(4);
    await runtime.release(occupied[0]!);
    const background = await next;
    expect(base.diagnostics()).toHaveLength(4);
    expect(peers.filter(({ peer }) => !peer.client.isClosed)).toHaveLength(4);
    await runtime.release(background);
    await vi.waitFor(() =>
      expect(
        peers.find(({ agent }) => agent === "b")!.peer.client.isClosed,
      ).toBe(true),
    );
    await Promise.all(
      occupied.slice(1).map((session) => runtime.release(session)),
    );
  });

  it("切换只归还普通租约，保留正在执行的任务并在任务结束后回收旧 Agent", async () => {
    const { runtime, peers, base } = fixture();
    await runtime.prepare(adapter("a"), "a", {});
    const task = await runtime.openBackground(
      adapter("a"),
      {},
      { background: true },
    );
    await task.initialize();
    await task.newSession("/scheduled");
    const taskPeer = peers.find(({ peer }) =>
      peer.received.some(({ method }) => method === "session/new"),
    )!.peer;
    for (let i = 0; i < 4; i++) {
      const ordinary = runtime.open("a");
      await ordinary.initialize();
      await ordinary.newSession("/ordinary");
    }
    taskPeer.handlers.set("session/close", () => {
      throw new Error("关闭普通会话也不能中断任务");
    });
    let finish!: (value: unknown) => void;
    taskPeer.handlers.set(
      "session/prompt",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const prompt = task.prompt("保留本次任务");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const revision = await runtime.prepareSwitch(adapter("b"), {});
    expect(peers).toHaveLength(4);
    await runtime.commitSwitch(revision);
    runtime.setSelection("b", "b");
    expect(taskPeer.client.isClosed).toBe(false);
    expect(
      taskPeer.received.filter(({ method }) => method === "session/close"),
    ).toHaveLength(0);
    expect(
      taskPeer.received.filter(({ method }) => method === "session/cancel"),
    ).toHaveLength(0);
    expect(base.diagnostics()).toHaveLength(4);
    const foreground = runtime.open("b");
    await foreground.initialize();
    finish({ stopReason: "end_turn" });
    await prompt;
    taskPeer.handlers.set("session/close", () => ({}));
    await runtime.release(task);
    await vi.waitFor(() => expect(taskPeer.client.isClosed).toBe(true));
    await runtime.release(foreground);
  });

  it("同 Agent 启动参数不同不混用连接，退出时取消正在等待的准入", async () => {
    const { runtime, peers } = fixture();
    await runtime.prepare(adapter("a"), "a", { executable: "first" });
    const all = await Promise.all(
      Array.from({ length: 4 }, () =>
        runtime.openBackground(
          adapter("a"),
          { executable: "first" },
          { background: true },
        ),
      ),
    );
    const waiting = runtime
      .openBackground(
        adapter("a"),
        { executable: "second" },
        { background: true },
      )
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peers).toHaveLength(4);
    await runtime.close({ force: true });
    expect(await waiting).toBeInstanceOf(Error);
    expect(peers.every(({ peer }) => peer.client.isClosed)).toBe(true);
    await Promise.all(all.map((session) => runtime.release(session)));
  });

  it("回收失败时不归还物理额度，重试也不额外启动进程", async () => {
    const { runtime, peers, agents } = fixture();
    await runtime.prepare(adapter("a"), "a", {});
    const close = vi
      .spyOn(peers[0]!.peer.client, "close")
      .mockRejectedValue(new Error("旧进程未退出"));
    for (let i = 0; i < 2; i++)
      await expect(
        runtime.openBackground(adapter("b"), {}, { background: true }),
      ).rejects.toThrow("shutdown failed");
    expect(agents.openTransport).toHaveBeenCalledTimes(4);
    close.mockRestore();
  });

  it("握手失败且杀进程失败时仍占原槽，不让重试创建第五条连接", async () => {
    const { runtime, peers, agents, base } = fixture();
    const create = agents.openTransport.getMockImplementation()!;
    let restoreKill: (() => void) | undefined;
    agents.openTransport.mockImplementationOnce(async (agent) => {
      const transport = await create(agent);
      peers[0]!.peer.handlers.set("initialize", () => {
        throw new Error("握手失败");
      });
      const kill = vi
        .spyOn(transport, "kill")
        .mockRejectedValue(new Error("无法确认退出"));
      restoreKill = () => kill.mockRestore();
      return transport;
    });
    await runtime.prepare(adapter("a"), "a", {});
    expect(base.diagnostics()).toHaveLength(4);
    for (let i = 0; i < 2; i++)
      await expect(
        runtime.openBackground(adapter("b"), {}, { background: true }),
      ).rejects.toThrow("无法确认退出");
    expect(agents.openTransport).toHaveBeenCalledTimes(4);
    restoreKill?.();
    await runtime.dispose({ force: true });
    expect(peers.every(({ peer }) => peer.client.isClosed)).toBe(true);
  });

  it("连接服务拒绝重复建池，不能通过第二个池获得额外额度", async () => {
    const { runtime, base } = fixture();
    await runtime.prepare(adapter("a"), "a", {});
    await expect(
      Promise.resolve().then(() =>
        base.createPool(() => Promise.reject(new Error("不能到达"))),
      ),
    ).rejects.toThrow("只能拥有一个");
  });
});
