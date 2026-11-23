import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  McpManagementHost,
  ManagedMcpSnapshot,
  NativeMcpHost,
  NativeMcpEntry,
  McpInspection,
} from "../../../src/contracts/mcp/management.ts";
import type { AgentsService } from "../../../src/plugins/agents/service.ts";
import { chrysAgentAdapter } from "../../../src/plugins/agents/enhancements/icode/adapter.ts";
import {
  createMcpManagement,
  resolutionKey,
} from "../../../src/plugins/mcp/runtime/management.ts";
import { McpView } from "../../../src/plugins/mcp/ui/McpView.tsx";
import { parseMcpImport } from "../../../src/plugins/mcp/runtime/importConfig.ts";
import { McpWorkbench } from "../../../src/plugins/mcp/ui/workbench.tsx";
import { BrowserAgentControlSettings } from "../../../src/plugins/browser/service.ts";
import { codeAgentAdapter } from "../../../src/plugins/agents/enhancements/codeagent/adapter.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";
import { createTestBrowserHost } from "../../helpers/browserHost.ts";
import { createSessionTools } from "../../../src/plugins/project/sessions/sessionTools.ts";
import { createStore } from "zustand";

afterEach(cleanup);

it("服务开关逐项更新，连续写入使用新版本，筛选结果同步更新", async () => {
  const user = userEvent.setup();
  const { service, host, readLocal } = fixture();
  const [first] = managed.entries;
  host.managedRead.mockResolvedValue({
    ...managed,
    entries: [first!, { ...first!, name: "other-tools" }],
  });
  let finishFirst!: (value: string) => void;
  host.managedChange
    .mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishFirst = resolve;
      }),
    )
    .mockResolvedValueOnce("second-write");
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
  expect(screen.getByText(/会话工具未知/)).toBeVisible();
  const list = screen.getByRole("list", { name: "MCP 服务" });
  await user.click(screen.getByRole("combobox", { name: "筛选状态" }));
  await user.click(screen.getByRole("option", { name: "已启用" }));
  await user.click(
    await within(list).findByRole("button", { name: first!.name }),
  );
  const detail = screen.getByRole("complementary", {
    name: first!.name + " 详情",
  });
  const firstToggle = within(detail).getByRole("switch");
  const nextToggle = within(list).getByRole("switch", {
    name: "other-tools 启用",
  });
  await user.click(firstToggle);
  expect(firstToggle).toHaveAttribute("aria-busy", "true");
  expect(nextToggle).toBeEnabled();
  await user.click(nextToggle);
  expect(host.managedChange).toHaveBeenCalledTimes(1);
  await act(() => Promise.resolve().then(() => finishFirst("first-write")));
  expect(host.managedChange).toHaveBeenLastCalledWith("chrys", "first-write", {
    kind: "toggle",
    name: "other-tools",
    enabled: false,
  });
  expect(
    within(list).queryByRole("button", { name: first!.name }),
  ).not.toBeInTheDocument();
  expect(detail).not.toBeVisible();
  expect(host.managedRead).toHaveBeenCalledTimes(1);
  expect(readLocal).toHaveBeenCalledTimes(1);
});

it("表单和 JSON 导入共用弹窗，切换保留草稿，预览后才写入", async () => {
  const user = userEvent.setup();
  const { service, host } = fixture();
  host.previewInstall.mockImplementation((agentId, definitions) =>
    Promise.resolve({
      agentId,
      definitions,
      revision: "managed-rev",
      accepted: definitions.map(({ name }) => name),
      skipped: [],
    }),
  );
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
  await screen.findByRole("button", { name: "managed-tools" });
  await user.click(screen.getByRole("button", { name: "导入 JSON" }));
  const dialog = screen.getByRole("dialog", { name: "新增 MCP" });
  const editor = within(dialog);
  const json = editor.getByRole("textbox", { name: /粘贴标准/ });
  await user.click(editor.getByRole("button", { name: "填入示例" }));
  const example = (json as HTMLTextAreaElement).value;
  expect(example).toContain("https://example.com/mcp");
  await user.click(editor.getByRole("tab", { name: "表单配置" }));
  const name = editor.getByRole("textbox", { name: "服务名称" });
  await user.type(name, "form-draft");
  await user.click(editor.getByRole("tab", { name: "JSON 导入" }));
  expect(json).toHaveValue(example);
  await user.click(editor.getByRole("button", { name: "预览导入" }));
  expect(await editor.findByText(/1 项可导入/)).toBeVisible();
  expect(host.commitInstall).not.toHaveBeenCalled();
  await user.click(editor.getByRole("tab", { name: "表单配置" }));
  expect(editor.getByRole("textbox", { name: "服务名称" })).toHaveValue(
    "form-draft",
  );
  await user.click(editor.getByRole("tab", { name: "JSON 导入" }));
  await user.click(editor.getByRole("button", { name: "确认导入" }));
  expect(host.commitInstall).toHaveBeenCalledOnce();
  expect(dialog).not.toBeInTheDocument();
});

it("导入解析预览保留可用的 HTTP 条目，跳过不支持的传输和明文请求头", () => {
  const parsed = parseMcpImport(
    JSON.stringify({
      mcpServers: {
        docs: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer " + "$" + "{DOCS_TOKEN}" },
        },
        local: { command: "local-mcp" },
        sse: { type: "sse", url: "https://example.test/events" },
        plain: {
          url: "https://example.test/plain",
          headers: { Authorization: "literal" },
        },
      },
    }),
  );
  expect(parsed.definitions).toEqual([
    {
      name: "docs",
      transport: "http",
      url: "https://example.test/mcp",
      headers: [
        {
          name: "Authorization",
          source: "environment",
          reference: "DOCS_TOKEN",
          prefix: "Bearer ",
        },
      ],
    },
  ]);
  expect(parsed.skipped.map(({ name }) => name)).toEqual([
    "local",
    "sse",
    "plain",
  ]);
});

it("复用已保存的检测结果，展示工具权限并按服务版本提交", async () => {
  const user = userEvent.setup();
  const { service, host } = fixture();
  const checks = new Map<string, McpInspection>();
  const result: McpInspection = {
    ok: true,
    checkedAt: 100,
    durationMs: 12,
    message: "检测成功",
    tools: [{ name: "read_docs" }],
  };
  const probe = vi.fn().mockResolvedValue(result);
  const save = vi.fn((key: string, value: McpInspection) => {
    checks.set(key, value);
    return Promise.resolve();
  });
  const setManagedTools = vi.fn().mockResolvedValue("tools-rev");
  Object.assign(host, {
    inspection: {
      read: (keys: readonly string[]) =>
        Promise.resolve(
          Object.fromEntries(
            keys.flatMap((key) =>
              checks.has(key) ? [[key, checks.get(key)]] : [],
            ),
          ),
        ),
      save,
      probe,
      setManagedTools,
      browserTools: () => Promise.resolve({ tools: [], disabledTools: [] }),
      probeBrowser: () => Promise.resolve(result),
    },
  });
  const browser = createTestBrowserHost();
  await browser.setAgentControl(false);
  const view = (
    <McpView
      service={service}
      agentId="chrys"
      activeProfile={null}
      browser={browser}
      canManageNative
      canManageInjected
      canTest
      runtime={{
        agentProfile: null,
        displayName: null,
        modelProfileId: null,
        modelName: null,
        modelProvider: null,
        maxContextTokens: null,
        toolNames: [],
        skillNames: [],
        skillSources: [],
        toolInventoryKnown: true,
        mcpServers: [{ name: "managed-tools", toolCount: 2 }],
        mcpFailures: [],
        mcpToolsByServer: {
          "managed-tools": ["read_docs", "mcp__managed-tools__read_docs"],
        },
      }}
    />
  );
  const first = render(view);
  await user.click(
    await screen.findByRole("button", { name: "managed-tools" }),
  );
  const detail = screen.getByRole("complementary", {
    name: "managed-tools 详情",
  });
  expect(screen.getByText(/1 个会话工具/)).toBeVisible();
  await user.click(
    await within(detail).findByRole("switch", { name: "read_docs 启用" }),
  );
  expect(setManagedTools).toHaveBeenCalledWith(
    "chrys",
    "managed-tools",
    "managed-rev",
    ["read_docs"],
    false,
  );
  expect(save).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/0 个会话工具/)).toBeVisible();
  expect(
    within(detail).getByRole("switch", { name: "read_docs 启用" }),
  ).not.toBeChecked();
  probe.mockResolvedValueOnce({
    ok: false,
    checkedAt: 101,
    durationMs: 10,
    message: "检测失败",
  } satisfies McpInspection);
  await user.click(within(detail).getByRole("button", { name: "测试连接" }));
  expect(await within(detail).findByText("检测失败")).toBeVisible();
  expect(within(detail).queryByText(/10 ms/)).not.toBeInTheDocument();
  expect(
    await within(detail).findByText(/显示上次检测到的工具清单/),
  ).toBeVisible();
  expect(
    within(detail).getByRole("switch", { name: "read_docs 启用" }),
  ).toBeEnabled();
  first.unmount();
  render(view);
  await user.click(
    await screen.findByRole("button", { name: "managed-tools" }),
  );
  expect(
    await screen.findByRole("switch", { name: "read_docs 启用" }),
  ).toBeVisible();
  expect(probe).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/显示上次检测到的工具清单/)).toBeVisible();
});

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
  const changeNative = vi.fn<NativeMcpHost["change"]>(() =>
    Promise.resolve("native-written"),
  );
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
      Promise.resolve("managed-written"),
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
    managedResolve: vi.fn<McpManagementHost["managedResolve"]>(() =>
      Promise.resolve({
        revision: managed.revision,
        servers: [server],
        skipped: [],
      }),
    ),
    retireManaged: vi.fn<NonNullable<McpManagementHost["retireManaged"]>>(() =>
      Promise.resolve(),
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
  expect(host.managedResolve).toHaveBeenLastCalledWith(
    "chrys",
    ["original"],
    expect.any(String),
  );
  expect(
    await service.sessionTools({
      ...context,
      agentId: "codeagent",
      sessionId: null,
    }),
  ).toEqual([]);
  expect(host.managedResolve).toHaveBeenCalledTimes(2);
});

it("CodeAgent 仅在当前 ACP 连接声明 HTTP 时注入托管 MCP", async () => {
  const { host, readLocal } = fixture([
    { ...nativeTools, name: "enabled-native", effective: true },
    { ...nativeTools, name: "disabled-native", effective: false },
  ]);
  const requestExtension = vi.fn();
  const agents = {
    resolve: () => codeAgentAdapter,
  } as unknown as AgentsService;
  const service = createMcpManagement(host, agents, () => ({}));
  const context = {
    agentId: "codeagent",
    agentKey: "codeagent",
    workspacePath: workspace,
    agent: {
      protocolVersion: 1,
      agentInfo: { name: "CodeAgent" },
      agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
    },
    requestExtension,
  };

  for (const sessionId of [null, "restored"]) {
    await expect(
      service.sessionTools({ ...context, sessionId }),
    ).resolves.toEqual([
      {
        type: "http",
        name: "managed-tools",
        url: "http://localhost:9010/mcp",
        headers: [],
      },
    ]);
  }
  expect(host.managedResolve).toHaveBeenCalledTimes(2);
  expect(host.managedResolve).toHaveBeenLastCalledWith(
    "codeagent",
    ["enabled-native"],
    expect.any(String),
  );
  expect(readLocal).toHaveBeenLastCalledWith("CodeAgent 用户配置", workspace);
  await expect(
    service.sessionTools({
      ...context,
      sessionId: null,
      agent: {
        ...context.agent,
        agentCapabilities: { mcpCapabilities: { sse: true } },
      },
    }),
  ).resolves.toEqual([]);
  expect(host.managedResolve).toHaveBeenCalledTimes(2);
  expect(requestExtension).not.toHaveBeenCalled();
});

it("CodeAgent 工作区条目仅手动检测，列表和批量检测不会启动 stdio", async () => {
  const user = userEvent.setup();
  const { host } = fixture([
    {
      ...nativeTools,
      id: "project:local",
      name: "local-stdio",
      source: "项目 .mcp.json",
      readOnly: true,
      transport: "stdio",
      effective: true,
    },
  ]);
  const inspect = vi.fn<NonNullable<NativeMcpHost["inspect"]>>(() =>
    Promise.resolve({
      ok: true,
      message: "检测成功",
      checkedAt: Date.now(),
      durationMs: 1,
      tools: [{ name: "example" }],
    }),
  );
  const managedProbe = vi.fn(() =>
    Promise.resolve({
      ok: true,
      message: "检测成功",
      checkedAt: 1,
      durationMs: 1,
    }),
  );
  const codedHost: McpManagementHost = {
    ...host,
    native: (provider) => ({
      ...host.native(),
      ...(provider === "codeagent" && { inspect }),
    }),
    inspection: {
      read: vi.fn(() => Promise.resolve({})),
      save: vi.fn(() => Promise.resolve()),
      probe: managedProbe,
      browserTools: vi.fn(() =>
        Promise.resolve({ tools: [], disabledTools: [] }),
      ),
      probeBrowser: managedProbe,
      setBrowserTools: vi.fn(() => Promise.resolve([])),
      setManagedTools: vi.fn(() => Promise.resolve("managed-rev")),
    },
  };
  const agents = {
    resolve: () => codeAgentAdapter,
    buildLaunch: () => ({ command: ["codeagent"], cwd: null, extraEnv: {} }),
  } as unknown as AgentsService;
  const service = createMcpManagement(codedHost, agents, () => ({}));
  render(
    <McpView
      service={service}
      agentId="codeagent"
      activeProfile={null}
      browser={createTestBrowserHost()}
      canManageNative
      canManageInjected
      canTest={false}
      nativeTransports={["http", "stdio"]}
      nativeWorkspace={workspace}
      hasScopedNative
      hasHostInspection
    />,
  );
  const row = await screen.findByRole("button", { name: "local-stdio" });
  expect(screen.getByText("项目 .mcp.json · 只读")).toBeVisible();
  expect(
    screen.queryByRole("switch", { name: "local-stdio 启用" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "local-stdio 删除" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "全部检测" }));
  expect(inspect).not.toHaveBeenCalled();
  await user.click(row);
  const detail = screen.getByRole("complementary", {
    name: "local-stdio 详情",
  });
  expect(
    within(detail).queryByRole("button", { name: "编辑配置" }),
  ).not.toBeInTheDocument();
  await user.click(within(detail).getByRole("button", { name: "测试连接" }));
  await vi.waitFor(() =>
    expect(inspect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        entryId: "project:local",
        workspace,
        draft: { name: "local-stdio", transport: "stdio", secretChanges: {} },
      }),
      "codeagent",
    ),
  );
});

it("释放会话时只注销该会话的托管 MCP 代理，重复释放不影响其他会话", async () => {
  const { service, host, request, warn } = fixture();
  const tools = createSessionTools({ warn } as never);
  tools.register(service.sessionTools);
  const context = {
    agentId: "chrys",
    agentKey: "chrys",
    workspacePath: workspace,
    agent: {
      protocolVersion: 1,
      agentInfo: { name: "iCode" },
      agentCapabilities: capabilities,
    },
    requestExtension: request,
  };
  const first = await tools.resolve({ ...context, sessionId: "first" });
  const second = await tools.resolve({ ...context, sessionId: "second" });
  const [firstGeneration, secondGeneration] =
    host.managedResolve.mock.calls.map((call) => call[2]);
  expect(firstGeneration).toEqual(expect.any(String));
  expect(secondGeneration).not.toBe(firstGeneration);
  expect(first.servers.map(({ name }) => name)).toEqual(["managed-tools"]);
  await first.dispose?.();
  await first.dispose?.();
  expect(host.retireManaged.mock.calls).toEqual([[firstGeneration]]);
  await second.dispose?.();
  expect(host.retireManaged.mock.calls).toEqual([
    [firstGeneration],
    [secondGeneration],
  ]);
});

it("会话已超时时回收迟到的托管 MCP 代理", async () => {
  const { service, host, request } = fixture();
  type Result = Awaited<ReturnType<McpManagementHost["managedResolve"]>>;
  let finish!: (result: Result) => void;
  const delayed = new Promise<Result>((resolve) => {
    finish = resolve;
  });
  const onDispose = vi.fn();
  host.managedResolve.mockReturnValueOnce(delayed);
  vi.useFakeTimers();
  try {
    const pending = service.sessionTools({
      agentId: "chrys",
      agentKey: "chrys",
      workspacePath: workspace,
      sessionId: "late",
      agent: {
        protocolVersion: 1,
        agentInfo: { name: "iCode" },
        agentCapabilities: capabilities,
      },
      requestExtension: request,
      onDispose,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toEqual([]);
    const generation = host.managedResolve.mock.calls[0]?.[2];
    expect(generation).toEqual(expect.any(String));
    finish({ revision: "managed-rev", servers: [], skipped: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.retireManaged).toHaveBeenCalledExactlyOnceWith(generation);
    expect(onDispose).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
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
      nativeTransports={["stdio", "http"]}
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
  expect(host.managedResolve).toHaveBeenLastCalledWith(
    "chrys",
    [],
    expect.any(String),
  );
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

it("opens details on demand, switches cards in place, and dismisses from outside", async () => {
  const user = userEvent.setup();
  const { service } = fixture([nativeTools]);
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
  const managed = await screen.findByRole("button", { name: "managed-tools" });
  const native = await screen.findByRole("button", { name: nativeTools.name });
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  expect(managed).toHaveAttribute("aria-expanded", "false");

  await user.click(managed);
  const drawer = screen.getByRole("complementary", {
    name: "managed-tools 详情",
  });
  expect(drawer).toHaveAttribute("data-edge-drawer", "right");
  await user.click(native);
  expect(
    screen.getByRole("complementary", { name: nativeTools.name + " 详情" }),
  ).toBe(drawer);
  expect(managed).toHaveAttribute("aria-expanded", "false");
  expect(native).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("searchbox", { name: "搜索 MCP" }));
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  await user.click(native);
  await user.click(within(drawer).getByRole("button", { name: "收起详情" }));
  expect(native).toHaveFocus();
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  await user.click(native);
  await user.keyboard("{Escape}");
  expect(native).toHaveFocus();
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  await user.click(native);
  await user.click(native);
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
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
      nativeTransports={["stdio", "http"]}
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
  expect(within(grid).getAllByRole("article")).toHaveLength(2);
  await user.click(screen.getByRole("combobox", { name: "筛选状态" }));
  await user.click(screen.getByRole("option", { name: "已停用" }));
  expect(within(grid).getAllByRole("article")).toHaveLength(1);
  await user.click(within(grid).getByRole("button", { name: "managed-tools" }));
  await user.click(screen.getByRole("button", { name: "编辑配置" }));
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
  await user.click(screen.getByRole("button", { name: "编辑配置" }));
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
  const { host } = fixture();
  const recoverSession = vi.fn(() => Promise.resolve());
  const agents = {
    configuration: createStore(() => ({ activeAgentId: "codeagent" })),
    resolve: () => codeAgentAdapter,
    selectionKey: () => "agent-key",
  } as unknown as AgentsService;
  const service = createMcpManagement(host, agents, () => ({}));
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
          runtime: { toolNames: [], mcpServers: [], mcpFailures: [] },
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
  const list = await screen.findByRole("list", { name: "MCP 服务" });
  expect(screen.getByRole("button", { name: "新增原生 MCP" })).toBeVisible();
  expect(screen.getByRole("button", { name: "新增 MCP" })).toBeVisible();
  expect(screen.getByRole("button", { name: "导入 JSON" })).toBeVisible();
  const mcp = await within(list).findByRole("switch", {
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
