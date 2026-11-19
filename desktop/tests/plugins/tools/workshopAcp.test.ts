import { expect, it, vi } from "vitest";
import { createStore } from "zustand";
import type { HostService } from "../../../src/plugins/host/service.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";
import type { ToolsService } from "../../../src/plugins/tools/service.ts";
import { memoryToolIO } from "../../../src/plugins/tools/runtime/io.ts";
import { createWorkshop } from "../../../src/plugins/tools/ui/workshop.ts";
import { createTransportPair } from "../../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";
import { attachSessionViews } from "../../../src/plugins/project/conversation/projection.ts";
import { EchoAgent } from "../../helpers/echo-agent.ts";
import { createOwnedSession } from "../../helpers/ownedSession.ts";
import { useApprovalStore, useRuntimeStatusStore, useSessionStore } from "../../helpers/foreground.ts";

/**
 * 本机没有配 iCode 的 ACP，这里用仓库自带的进程内 echo-agent（讲同一套 ACP
 * 方言）走一遍真实链路：
 *
 *   用户发起「做工具」→ 会话把 isAgentRunning 翻 true →（AI 写文件）→
 *   回合结束翻 false → 工坊订阅到这个沿 → 自动读盘校验 → 结论回到面板。
 *
 * 单测里手推 isAgentRunning 能覆盖状态机，但覆盖不了「真实会话结束时状态到底
 * 怎么翻」——这条用例补的就是那一段。
 */
function harness() {
  const io = memoryToolIO();
  const dir = "/data/tools/projects/u1/demo";
  const host = {
    isNative: () => true,
    skills: {
      userDataDir: (namespace: string, directory: string) => io.userDataDir(namespace, directory),
      pathExists: (path: string) => io.pathExists(path),
      listDirNames: (path: string) => io.listDirNames(path),
      writeTextFile: (path: string, contents: string) => io.writeTextFile(path, contents),
      listToolFiles: () => Promise.resolve([]),
      readBinaryFile: () => Promise.reject(new Error("本用例不读二进制")),
      writeBinaryFile: () => Promise.resolve(),
      toolPurge: () => Promise.resolve({ removedDirs: [], removedData: false, skippedDirs: [] }),
    },
    archives: { readTextFile: (path: string) => io.readTextFile(path) },
    files: { openInFileManager: vi.fn() },
  } as unknown as HostService;

  const tools = {
    state: createStore<readonly never[]>(() => []),
    install: vi.fn(),
    rollback: vi.fn(),
    setSource: vi.fn(),
    open: vi.fn(),
    remove: vi.fn(),
    saveSettings: vi.fn(),
  } as unknown as ToolsService;

  // 会话存储用测试替身：attachSessionViews 会把它接到真实 AcpSession 的事件流上。
  const session = useSessionStore;
  const project = {
    projects: {
      workspace: createStore(() => ({ activePath: dir })),
      setRecentExclusions: vi.fn(),
      registerProject: vi.fn(),
      pickDirectory: vi.fn(),
    },
    sessions: {
      catalog: createStore(() => ({ agentKey: "echo" })),
      startNewSession: vi.fn(),
    },
    conversation: {
      foreground: { session },
      send: vi.fn(),
    },
  } as unknown as ProjectService;

  const workshop = createWorkshop({ tools, project, host, owner: () => "u1" });
  return { workshop, io, dir, session };
}

it("auto-verifies the project when the ACP turn really ends", async () => {
  const { workshop, io, dir, session } = harness();
  session.getState().clear();
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
    actions: [{ id: "run", description: "跑", inputSchema: { type: "object", properties: {} } }],
  }));
  await io.writeTextFile(`${dir}/index.html`, "<p>还没实现</p>");

  const { client, peer } = createTransportPair();
  const agent = new EchoAgent();
  agent.attach(peer);
  const acp = createOwnedSession(client);
  await acp.initialize();
  await acp.newSession(dir);
  const detach = attachSessionViews(acp, session, useApprovalStore, useRuntimeStatusStore);
  try {
    await workshop.select(dir);
    // 起始状态：页面没有实现，校验不通过。
    expect(workshop.state.getState().check?.ready).toBe(false);

    agent.script({});
    // AI 在回合里把文件写好（真实场景由 agent 的 write 工具完成，这里直接落盘）。
    await io.writeTextFile(`${dir}/index.html`, "<p>好了</p><script>window.aawActions={run:async()=>({ok:true})}</script>");
    session.getState().sendPrompt("把工具实现出来，然后停下来");

    // 回合结束由真实会话驱动 isAgentRunning 翻 false，工坊据此自动校验。
    await vi.waitFor(() => expect(workshop.state.getState().check?.ready).toBe(true));
    expect(workshop.state.getState().note?.text).toContain("校验通过");
  } finally {
    detach();
    session.getState().clear();
    await acp.closeSession();
  }
});
