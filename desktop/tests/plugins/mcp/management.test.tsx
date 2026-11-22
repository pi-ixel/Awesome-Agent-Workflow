import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  McpManagementHost,
  ManagedMcpSnapshot,
  NativeMcpHost,
  NativeMcpEntry,
} from "../../../src/contracts/mcp/management.ts";
import type { AgentsService } from "../../../src/plugins/agents/service.ts";
import { chrysAgentAdapter } from "../../../src/plugins/agents/enhancements/icode/adapter.ts";
import {
  createMcpManagement,
  resolutionKey,
} from "../../../src/plugins/mcp/runtime/management.ts";
import { McpView } from "../../../src/plugins/mcp/ui/McpView.tsx";
import { McpWorkbench } from "../../../src/plugins/mcp/ui/workbench.tsx";
import { BrowserAgentControlSettings } from "../../../src/plugins/browser/service.ts";
import { codeAgentAdapter } from "../../../src/plugins/agents/enhancements/codeagent/adapter.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";
import { createTestBrowserHost } from "../../helpers/browserHost.ts";
import { createStore } from "zustand";

afterEach(cleanup);

const nativeTools: NativeMcpEntry = {
  name: "native-tools",
  transport: "stdio",
  enabled: false,
  url: null,
  command: "original-command",
  cwd: null,
  argsCount: 0,
  secretKeys: ["ORIGINAL_ENV"],
};

const profile = {
  name: "Code",
  id: "code-profile",
};
const workspace = "D:/mcp-project";
const managed: ManagedMcpSnapshot = {
  revision: "managed-rev",
  entries: [
    {
      name: "managed-tools",
      enabled: true,
      transport: "http",
      url: "http://localhost:9010/mcp",
      headers: [],
    },
  ],
};
const capabilities = {
  _meta: {
    chrys: {
      methods: ["profiles/agents/read", "mcp/test"],
    },
  },
  mcpCapabilities: { http: true },
};

function fixture(nativeEntries: readonly NativeMcpEntry[] = []) {
  const server = {
    name: "managed-tools",
    url: managed.entries[0]!.url,
    headers: {},
  };
  const native = { revision: "native-rev", entries: nativeEntries };
  const readNative = vi.fn<NativeMcpHost["read"]>(() =>
    Promise.resolve(native),
  );
  const readLocal = vi.fn<NativeMcpHost["readLocal"]>(() =>
    Promise.resolve({ profile, snapshot: native }),
  );
  const changeNative = vi.fn<NativeMcpHost["change"]>(() => Promise.resolve());
  const host = {
    native: () => ({
      read: readNative,
      readLocal,
      change: changeNative,
      sessionProfile: vi.fn(() => Promise.resolve("saved-profile")),
      testConfig: vi.fn(() => Promise.resolve(server)),
    }),
    managedRead: vi.fn(() => Promise.resolve(managed)),
    managedChange: vi.fn<McpManagementHost["managedChange"]>(() =>
      Promise.resolve(),
    ),
    previewInstall: vi.fn<McpManagementHost["previewInstall"]>(
      (agentId, definitions) =>
        Promise.resolve({
          agentId,
          definitions,
          revision: managed.revision,
          accepted: [],
          skipped: [],
        }),
    ),
    commitInstall: vi.fn(() => Promise.resolve({ applied: [], skipped: [] })),
    managedResolve: vi.fn(() =>
      Promise.resolve({
        revision: managed.revision,
        servers: [server],
        skipped: [],
      }),
    ),
    testConfig: vi.fn(() => Promise.resolve(server)),
  } satisfies McpManagementHost;
  const request = vi.fn((method: string) => {
    if (method === "_mcp/test") return Promise.resolve({ ok: true });
    return Promise.resolve({
      profile: {
        id: profile.id,
        name: profile.name,
        tools: { mcp: [{ name: "original" }] },
      },
    });
  });
  const agents = {
    resolve: (id?: string) => (id === "chrys" ? chrysAgentAdapter : null),
    runMcpExtension: (_id, _toolPaths, run) => run({ capabilities, request }),
  } satisfies Pick<AgentsService, "resolve" | "runMcpExtension">;
  const warn = vi.fn(() => undefined);
  return {
    host,
    request,
    readNative,
    readLocal,
    changeNative,
    warn,
    service: createMcpManagement(host, agents as AgentsService, () => ({}), {
      warn,
    }),
  };
}

it("shares concurrent local reads, expires the snapshot, and bypasses reuse on refresh", async () => {
  const { service, readLocal, request } = fixture([nativeTools]);
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  try {
    const [first, concurrent] = await Promise.all([
      service.readNative("chrys", null),
      service.readNative("chrys", "Code"),
    ]);
    expect(concurrent).toEqual(first);
    expect(await service.readNative("chrys", null)).toEqual(first);
    expect(readLocal).toHaveBeenCalledExactlyOnceWith("Code");

    clock.mockReturnValue(3_200);
    await service.readNative("chrys", null);
    expect(readLocal).toHaveBeenCalledTimes(2);

    readLocal.mockResolvedValueOnce(null);
    expect(await service.readNative("chrys", null, true)).toBeNull();
    expect(readLocal).toHaveBeenCalledTimes(3);
    expect(request).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it("uses the archived Profile for a restored session and keeps other Agents isolated", async () => {
  const { service, host, request } = fixture();
  const context = {
    agentId: "chrys",
    agentKey: "stable-connection",
    workspacePath: workspace,
    agent: {
      protocolVersion: 1,
      agentInfo: { name: "iCode" },
      agentCapabilities: capabilities,
    },
    requestExtension: request,
  };
  const first = await service.sessionTools({ ...context, sessionId: null });
  expect(request).toHaveBeenLastCalledWith("_profiles/agents/read", {
    name: "Code",
  });
  await expect(
    service.sessionTools({
      ...context,
      workspacePath: "D:/other-project",
      sessionId: "stored",
    }),
  ).resolves.toEqual([
    {
      type: "http",
      name: "managed-tools",
      url: "http://localhost:9010/mcp",
      headers: [],
    },
  ]);
  expect(request).toHaveBeenLastCalledWith("_profiles/agents/read", {
    name: "saved-profile",
  });
  expect(first.map(({ name }) => name)).toEqual(["managed-tools"]);
  expect(host.managedResolve).toHaveBeenLastCalledWith("chrys", ["original"]);
  expect(
    await service.sessionTools({
      ...context,
      agentId: "codeagent",
      sessionId: null,
    }),
  ).toEqual([]);
  expect(host.managedResolve).toHaveBeenCalledTimes(2);
});

it("tests the unsaved HTTP draft from the unified card editor and confirms deletion", async () => {
  const user = userEvent.setup();
  const { service, request, host } = fixture();
  render(
    <McpView
      service={service}
      agentId="chrys"
      activeProfile={null}
      browser={createTestBrowserHost()}
      canManageNative
      canManageInjected
      canTest
    />,
  );
  const grid = screen.getByRole("list", { name: "MCP 服务" });
  await within(grid).findByRole("button", { name: "managed-tools" });
  expect(request.mock.calls.flat()).not.toContain("_mcp/test");

  await user.click(screen.getByRole("button", { name: "新增 MCP" }));
  const editor = screen.getByRole("dialog", { name: "新增 MCP" });
  expect(
    within(editor).queryByRole("combobox", { name: "作用域" }),
  ).not.toBeInTheDocument();
  await user.type(
    within(editor).getByRole("textbox", { name: "服务名称" }),
    "global-added",
  );
  await user.type(
    within(editor).getByRole("textbox", { name: "服务地址" }),
    "https://example.test/mcp",
  );
  await user.click(within(editor).getByRole("button", { name: "测试连接" }));
  await within(editor).findByText(/连接成功/);
  expect(host.testConfig).toHaveBeenCalledExactlyOnceWith({
    source: "managed",
    draft: {
      name: "global-added",
      transport: "http",
      url: "https://example.test/mcp",
      headers: [],
    },
  });
  expect(host.managedChange).not.toHaveBeenCalled();
  await user.click(within(editor).getByRole("button", { name: "保存" }));
  expect(host.managedChange).toHaveBeenLastCalledWith("chrys", "managed-rev", {
    kind: "save",
    previousName: null,
    draft: {
      name: "global-added",
      transport: "http",
      url: "https://example.test/mcp",
      headers: [],
    },
  });

  await user.click(
    await within(grid).findByRole("button", { name: "managed-tools 删除" }),
  );
  const confirm = screen.getByRole("dialog", { name: "删除 MCP" });
  expect(host.managedChange).toHaveBeenCalledTimes(1);
  await user.click(within(confirm).getByRole("button", { name: "删除" }));
  expect(host.managedChange).toHaveBeenLastCalledWith("chrys", "managed-rev", {
    kind: "remove",
    name: "managed-tools",
  });
});

it("passes MCP to Agent after native lookup failure and isolates an independent connection failure", async () => {
  const { service, request, host, warn } = fixture();
  const pending: ((sessionId: string) => void)[] = [];
  const context = {
    agentId: "chrys",
    agentKey: "shared-agent",
    workspacePath: workspace,
    sessionId: null,
    agent: {
      protocolVersion: 1,
      agentInfo: { name: "iCode" },
      agentCapabilities: capabilities,
    },
    requestExtension: request,
    onEstablished: (listener: (sessionId: string) => void) => {
      pending.push(listener);
    },
  };
  await service.sessionTools(context);
  const fallback = await service.sessionTools({
    ...context,
    requestExtension: () => Promise.reject(new Error("read failed")),
  });
  expect(fallback.map(({ name }) => name)).toEqual(["managed-tools"]);
  expect(host.managedResolve).toHaveBeenLastCalledWith("chrys", []);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("交由 Agent"), {
    agentId: "chrys",
    sessionId: null,
  });
  host.managedResolve.mockRejectedValueOnce(new Error("native I/O"));
  await service.sessionTools(context);
  expect(service.resolutions.getState().size).toBe(0);
  pending[0]?.("foreground");
  pending[1]?.("fallback");
  pending[2]?.("background");
  const results = service.resolutions.getState();
  expect(
    results.get(resolutionKey("shared-agent", workspace, "foreground"))
      ?.injected,
  ).toEqual(["managed-tools"]);
  expect(
    results.get(resolutionKey("shared-agent", workspace, "background"))?.error,
  ).toBe("native I/O");
  expect(
    results.get(resolutionKey("shared-agent", workspace, "fallback"))?.injected,
  ).toEqual(["managed-tools"]);
});

it("mixes native and Desktop cards, filters by configured state, and checks exact duplicate names", async () => {
  const user = userEvent.setup();
  const { service, host, readLocal, changeNative } = fixture([
    { ...nativeTools, name: "managed-tools" },
    nativeTools,
  ]);
  render(
    <McpView
      service={service}
      agentId="chrys"
      activeProfile={null}
      browser={createTestBrowserHost()}
      canManageNative
      canManageInjected
      canTest
    />,
  );
  const grid = screen.getByRole("list", { name: "MCP 服务" });
  expect(await within(grid).findAllByText("名称重复，请修改名称")).toHaveLength(
    2,
  );
  const search = screen.getByRole("searchbox", { name: "搜索 MCP" });
  await user.type(search, "managed");
  expect(within(grid).getAllByRole("listitem")).toHaveLength(2);
  await user.click(screen.getByRole("combobox", { name: "筛选状态" }));
  await user.click(screen.getByRole("option", { name: "已停用" }));
  expect(within(grid).getAllByRole("listitem")).toHaveLength(1);
  await user.click(within(grid).getByRole("button", { name: "managed-tools" }));
  const editor = screen.getByRole("dialog", { name: "编辑 MCP" });
  const name = within(editor).getByRole("textbox", { name: "服务名称" });
  await user.clear(name);
  await user.type(name, "Managed-tools");
  await user.click(within(editor).getByRole("combobox", { name: "传输方式" }));
  await user.click(screen.getByRole("option", { name: "Streamable HTTP" }));
  expect(within(editor).queryByText(/ORIGINAL_ENV/)).not.toBeInTheDocument();
  await user.type(
    within(editor).getByRole("textbox", { name: "服务地址" }),
    "https://example.test/mcp",
  );
  await user.click(within(editor).getByRole("button", { name: "保存" }));
  expect(changeNative).toHaveBeenCalledWith(profile, "native-rev", {
    kind: "save",
    previousName: "managed-tools",
    draft: {
      name: "Managed-tools",
      transport: "http",
      url: "https://example.test/mcp",
      secretChanges: {},
    },
  });

  const draft = { ...managed.entries[0]!, name: "native-tools" };
  const add = { kind: "save" as const, previousName: null, draft };
  await expect(
    service.managedChange("chrys", null, managed.revision, add),
  ).rejects.toThrow("名称重复");
  expect(host.managedChange).not.toHaveBeenCalled();
  readLocal.mockRejectedValueOnce(new Error("Profile unreadable"));
  await service.managedChange("chrys", null, managed.revision, add);
  expect(host.managedChange).toHaveBeenCalledWith(
    "chrys",
    managed.revision,
    add,
  );
  await service.previewInstall("chrys", null, [draft]);
  expect(host.previewInstall).toHaveBeenLastCalledWith(
    "chrys",
    [draft],
    ["managed-tools", "native-tools"],
  );
});

it("reloads an externally changed revision in the existing editor and keeps typed input", async () => {
  const user = userEvent.setup();
  const { service, host } = fixture();
  render(
    <McpView
      service={service}
      agentId="chrys"
      activeProfile={null}
      browser={createTestBrowserHost()}
      canManageNative
      canManageInjected
      canTest
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "managed-tools" }),
  );
  const editor = screen.getByRole("dialog", { name: "编辑 MCP" });
  const name = within(editor).getByRole("textbox", { name: "服务名称" });
  await user.clear(name);
  await user.type(name, "renamed");
  const updatedUrl = "https://example.test/updated";
  host.managedRead.mockResolvedValue({
    revision: "updated",
    entries: managed.entries.map((entry) => ({ ...entry, url: updatedUrl })),
  });
  host.managedChange.mockRejectedValueOnce("配置已变化，请刷新后重试");
  const save = within(editor).getByRole("button", { name: "保存" });
  await user.click(save);
  await within(editor).findByRole("alert");
  expect(save).toBeDisabled();
  await user.click(
    within(editor).getByRole("button", { name: "重新加载配置" }),
  );
  expect(name).toHaveValue("renamed");
  expect(within(editor).getByRole("textbox", { name: "服务地址" })).toHaveValue(
    updatedUrl,
  );
  await user.click(save);
  expect(host.managedChange).toHaveBeenLastCalledWith("chrys", "updated", {
    kind: "save",
    previousName: "managed-tools",
    draft: { name: "renamed", transport: "http", url: updatedUrl, headers: [] },
  });
});

it("shows the built-in browser as a switch-only card with CodeAgent and mirrors the Settings switch", async () => {
  const user = userEvent.setup();
  const browser = createTestBrowserHost();
  const { service } = fixture();
  const recoverSession = vi.fn(() => Promise.resolve());
  const agents = {
    configuration: createStore(() => ({ activeAgentId: "codeagent" })),
    resolve: () => codeAgentAdapter,
    selectionKey: () => "agent-key",
  } as unknown as AgentsService;
  const project = {
    projects: {
      workspace: createStore(() => ({ activePath: workspace, toolPaths: {} })),
    },
    sessions: { recoverSession },
    conversation: {
      foreground: {
        session: createStore(() => ({
          isBound: true,
          agentKey: "agent-key",
          activeSessionId: "front",
        })),
        runtime: createStore(() => ({
          lastSessionId: "front",
          runtime: { toolNames: [] },
        })),
      },
    },
  } as unknown as ProjectService;
  render(
    <>
      <BrowserAgentControlSettings host={browser} />
      <McpWorkbench
        agents={agents}
        project={project}
        service={service}
        browser={browser}
      />
    </>,
  );
  const settings = screen.getByRole("switch", { name: "Agent 浏览器控制" });
  const mcp = await screen.findByRole("switch", {
    name: "AAW 内置浏览器 启用",
  });
  await vi.waitFor(() => expect(mcp).toBeChecked());
  await user.click(mcp);
  expect(settings).not.toBeChecked();
  await user.click(settings);
  expect(mcp).toBeChecked();
  expect(recoverSession).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: /重连|更多操作/ }),
  ).not.toBeInTheDocument();
});
