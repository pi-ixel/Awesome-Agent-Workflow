import { mutableProjectForeground } from "../helpers/foreground.ts";
import type { Context } from "cordis";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { createDesktopRuntime } from "../../src/bootstrap/bootstrap.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { desktopSettingsKey } from "../../src/contracts/configuration.ts";
import type { CliRunResult } from "../../src/contracts/processRunner.ts";
import {
  decodeAnnotationMessage,
  encodeAnnotationMessage,
  type DocumentAnnotation,
} from "../../src/contracts/documentAnnotations.ts";
import * as projectPlugin from "../../src/plugins/project/plugin.ts";
import { draftScopeKey } from "../../src/plugins/project/composer/draftStore.ts";
import { finishProjectDraftMigration } from "../../src/plugins/project/composer/projectDraftMigration.ts";
import { sessionArchiveKey } from "../../src/plugins/project/sessionArchiveStore.ts";
import { sessionActivityKey } from "../../src/plugins/project/sessionActivityStore.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";
import { addProjectViaDialog } from "../../src/plugins/project/ui/addProjectFlow.ts";

it("drops a directory picked by a retired Project without waiting for the dialog to close", async ({ onTestFinished }) => {
  let root: Context | undefined;
  const registerProject = vi.fn();
  const preloadSessionList = vi.fn(() => Promise.resolve());
  const runtime = createTestDesktopRuntime({
    attachPreloading: () => () => {}, close: () => Promise.resolve(),
    registerProject, preloadSessionList,
  }, undefined, (context) => { root = context; });
  onTestFinished(() => runtime.shutdown());
  const { project, workbench } = await runtime.ready;
  const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
  if (!root || !fiber) throw new Error("Project fiber is missing");

  let select!: (path: string) => void;
  const pending = new Promise<string>((resolve) => { select = resolve; });
  const pick = vi.spyOn(root.host.dialogs, "pickDirectory")
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce("D:/current");
  const previous = addProjectViaDialog(project, workbench);
  expect(pick).toHaveBeenCalledExactlyOnceWith("选择项目目录");
  await fiber.dispose();
  const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
  await root.plugin(projectPlugin, config);
  select("D:/retired");
  await expect(previous).resolves.toBeNull();
  expect(registerProject).not.toHaveBeenCalled();
  expect(workbench.navigation.getState().contextPath).toBeNull();

  await expect(addProjectViaDialog(root.project, workbench)).resolves.toBe("D:/current");
  expect(registerProject).toHaveBeenCalledExactlyOnceWith("D:/current");
  expect(preloadSessionList).toHaveBeenCalledExactlyOnceWith("D:/current", false);
  expect(workbench.navigation.getState().contextPath).toBe("D:/current");
});

it("prepares window exit and update handoff through the Project service", async ({ onTestFinished }) => {
  const close = vi.fn(() => Promise.resolve());
  const runtime = createTestDesktopRuntime({
    attachPreloading: () => () => {},
    close,
  });
  onTestFinished(() => runtime.shutdown());
  const { project } = await runtime.ready;
  const { session, approval } = mutableProjectForeground(project);
  const requestCancel = vi.fn();
  const flushSessionLog = vi.fn();
  session.setState({ isAgentRunning: true, requestCancel, flushSessionLog });
  const permission = approval.getState().offerPermission({
    sessionId: "closing-session",
    toolCall: { toolCallId: "read" },
    options: [],
  });
  const questions = approval.getState().offerQuestions({
    sessionId: "closing-session",
    requestId: "questions",
    callerName: null,
    questions: [{
      header: "确认",
      question: "继续吗",
      options: [{ label: "继续", description: "继续执行" }],
      multiSelect: false,
    }],
  });

  await project.prepareExit("window", true);
  expect(requestCancel).toHaveBeenCalledOnce();
  await expect(permission).resolves.toEqual({ outcome: "cancelled" });
  await expect(questions).resolves.toEqual({ cancelled: true });
  expect(approval.getState().pending).toEqual([]);
  expect(close).not.toHaveBeenCalled();

  await project.prepareExit("update", true);
  expect(flushSessionLog).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledExactlyOnceWith({ force: true });
  expect(flushSessionLog).toHaveBeenCalledBefore(close);
});

it("reloads durable composer data without retaining prefill listeners or card expansion", async ({
  onTestFinished,
}) => {
  const path = "/project-composer-reload";
  const scope = draftScopeKey(path, "draft-session", "agent");
  const historyKey = `aaw-desktop/prompt-history/v2/agent/${encodeURIComponent(path)}/draft-session`;
  const previous = localStorage.getItem(historyKey);
  localStorage.removeItem(historyKey);
  vi.stubGlobal("indexedDB", new IDBFactory());
  onTestFinished(() => {
    vi.unstubAllGlobals();
    if (previous === null) localStorage.removeItem(historyKey);
    else localStorage.setItem(historyKey, previous);
  });
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
    },
  );
  onTestFinished(() => runtime.shutdown());
  const { project } = await runtime.ready;
  const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
  if (!root || !fiber) throw new Error("Project fiber is missing");
  const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
  const listener = vi.fn();
  const image = {
    name: "draft.png",
    block: { type: "image", mimeType: "image/png", data: "YWJj" },
  };
  const { composer, expansion } = project;
  composer.subscribePrefill(listener);
  expect(composer.prefill(" initial ", [image.block])).toBe(true);
  expect(listener).toHaveBeenCalledExactlyOnceWith("initial", [image.block]);
  composer.history.setScope(path, "draft-session", "agent");
  composer.history.record("persisted prompt");
  expansion.set("tool:read", true);
  const write = composer.imageDrafts.save({ [scope]: [image] });

  await fiber.dispose();
  await write;
  expect(expansion.get("tool:read")).toBeUndefined();
  expect(composer.history.get()).toEqual([]);
  expect(composer.prefill("late", [image.block])).toBe(false);
  composer.history.setScope(path, "draft-session", "agent");
  composer.history.record("stale write");
  expansion.set("tool:read", true);
  await composer.imageDrafts.save({});

  await root.plugin(projectPlugin, config);
  const replacement = root.project;
  expect(replacement.expansion.get("tool:read")).toBeUndefined();
  expect(expansion.get("tool:read")).toBeUndefined();
  replacement.composer.history.setScope(path, "draft-session", "agent");
  expect(replacement.composer.history.get()).toEqual(["persisted prompt"]);
  expect(await replacement.composer.imageDrafts.load()).toEqual({
    [scope]: [image],
  });
  const next = vi.fn();
  replacement.composer.subscribePrefill(next);
  expect(replacement.composer.prefill("new instance")).toBe(true);
  expect(next).toHaveBeenCalledExactlyOnceWith("new instance", []);
  expect(listener).toHaveBeenCalledOnce();
});

it("keeps background messages, approvals and usage attached to their session across focus and Project reload", async ({
  onTestFinished,
}) => {
  const previous = localStorage.getItem(desktopSettingsKey);
  localStorage.setItem(
    desktopSettingsKey,
    JSON.stringify({
      activeAgentId: "native-opencode",
      approvalMode: "ask",
    }),
  );
  onTestFinished(() => {
    if (previous === null) localStorage.removeItem(desktopSettingsKey);
    else localStorage.setItem(desktopSettingsKey, previous);
  });
  let root: Context | undefined;
  const peers: ReturnType<typeof standardAcpPeer>[] = [];
  const runtime = createDesktopRuntime(
    undefined,
    undefined,
    undefined,
    (context) => {
      root = context;
      vi.spyOn(context.agents, "openTransport").mockImplementation(() => {
        const peer = standardAcpPeer();
        peers.push(peer);
        return Promise.resolve(peer.client);
      });
    },
  );
  onTestFinished(() => runtime.shutdown());
  const { project } = await runtime.ready;
  const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
  if (!root || !fiber) throw new Error("Project fiber is missing");
  const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
  const leftPath = "/foreground-left";
  const rightPath = "/foreground-right";
  const sessionId = "same-session";
  const { session, approval, runtime: status } = mutableProjectForeground(project);
  const foregroundEvents = vi.fn();
  project.subscribeSessionActivity(foregroundEvents);
  await project.openSession(leftPath, { forceNew: true });
  const leftPeer = peers.find(({ received }) =>
    received.some(
      ({ method, params }) =>
        method === "session/new" && params?.cwd === leftPath,
    ),
  );
  if (!leftPeer) throw new Error("Foreground session is missing its peer");
  const agentKey = session.getState().agentKey!;
  leftPeer.update({ sessionUpdate: "usage_update", size: 128_000, used: 4096 });
  const reply = leftPeer.request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "foreground-tool", title: "Read" },
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
  });
  await vi.waitFor(() => {
    expect(approval.getState().pending).toHaveLength(1);
    expect(status.getState().usage?.contextUsed).toBe(4096);
  });
  expect(foregroundEvents).toHaveBeenCalledWith(
    leftPath,
    expect.objectContaining({ type: "usage_update" }),
  );
  foregroundEvents.mockClear();

  await project.openSession(rightPath, { forceNew: true });
  expect(approval.getState().pending).toEqual([]);
  expect(status.getState().usage).toBeNull();
  leftPeer.update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "background reply" },
  });
  await vi.waitFor(() => {
    expect(project.focusSession(leftPath, sessionId, agentKey)).toBe(true);
    session.getState().flushStreamingChunks();
    expect(session.getState().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "assistant",
          text: "background reply",
        }),
      ]),
    );
  });
  expect(foregroundEvents).not.toHaveBeenCalledWith(
    leftPath,
    expect.objectContaining({ type: "agent_message_chunk" }),
  );
  expect(status.getState().usage?.contextUsed).toBe(4096);
  const pending = approval.getState().pending[0];
  expect(pending?.kind).toBe("permission");
  project.cancelPermission(
    { workspacePath: leftPath, sessionId, agentKey },
    pending!.id,
  );
  await expect(reply).resolves.toMatchObject({
    result: { outcome: { outcome: "cancelled" } },
  });

  await fiber.dispose();
  await root.plugin(projectPlugin, config);
  const replacement = root.project;
  expect(replacement.foreground).not.toBe(project.foreground);
  session.setState({ lastError: "stale write" });
  expect(session.getState()).toMatchObject({
    activeSessionId: null,
    items: [],
    lastError: null,
  });
  expect(approval.getState().pending).toEqual([]);
  expect(status.getState().usage).toBeNull();
  expect(replacement.foreground.session.getState().activeSessionId).toBeNull();
});

it("restores durable annotations without old Project drafts, settlement or view preferences", async ({
  onTestFinished,
}) => {
  const path = "/project-reload-annotations";
  const scope = draftScopeKey(path, null);
  const key = `${scope}/document-annotations-v1`;
  const marker = `${scope}/project-draft-migration-v1`;
  const saved = [key, marker].map(
    (entry) => [entry, localStorage.getItem(entry)] as const,
  );
  for (const [entry] of saved) localStorage.removeItem(entry);
  onTestFinished(() => {
    for (const [entry, value] of saved) {
      if (value === null) localStorage.removeItem(entry);
      else localStorage.setItem(entry, value);
    }
  });
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
    },
  );
  onTestFinished(() => runtime.shutdown());
  const { project } = await runtime.ready;
  const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
  if (!root || !fiber) throw new Error("Project fiber is missing");
  const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
  const annotation: DocumentAnnotation = {
    id: "submitted",
    project: path,
    path: `${path}/design.md`,
    source: false,
    quote: "text",
    prefix: "",
    suffix: "",
    offset: 0,
    revision: "r1",
    comment: "Review",
  };
  const prompt = encodeAnnotationMessage("Update", [annotation]);
  const submission = decodeAnnotationMessage(prompt)!;
  const drafts = project.annotationDrafts.getState();
  const status = project.statusView.getState();
  status.setMode("mini");
  expect(drafts.put(scope, [annotation])).toBe(true);
  expect(drafts.submit(scope, prompt)).toBe(true);
  const followup = { ...annotation, id: "unsent", comment: "Keep this draft" };
  expect(drafts.put(scope, [followup])).toBe(true);
  drafts.migrate(`${scope}/old`, scope);
  expect(project.annotationDrafts.getState().migrations).not.toEqual({});

  await fiber.dispose();
  expect(project.annotationDrafts.getState()).toMatchObject({
    drafts: {},
    migrations: {},
  });
  expect(project.statusView.getState().mode).toBe("auto");
  await root.plugin(projectPlugin, config);
  const replacement = root.project;
  replacement.annotationDrafts.getState().ensure(scope);
  const restored = replacement.annotationDrafts.getState().drafts[scope];
  expect(restored?.annotations).toEqual([followup]);
  expect(restored?.submissions[submission.id]).toEqual({
    prompt,
    state: "uncertain",
  });

  const persisted = localStorage.getItem(key);
  drafts.settle(prompt, false);
  expect(drafts.put(scope, [])).toBe(false);
  finishProjectDraftMigration(project.annotationDrafts, scope, `${scope}/old`);
  status.setMode("panel");
  expect(localStorage.getItem(key)).toBe(persisted);
  expect(localStorage.getItem(marker)).toBeNull();
  expect(project.statusView.getState().mode).toBe("auto");
  expect(replacement.statusView.getState().mode).toBe("auto");
  expect(
    replacement.annotationDrafts.getState().recover(scope, submission.id),
  ).toBe("Update");
  expect(
    replacement.annotationDrafts.getState().drafts[scope]?.annotations,
  ).toEqual([followup, annotation]);
});

it("restores workspace preferences and discards a health check on the same-root reload", async ({
  onTestFinished,
}) => {
  const key = "aaw-desktop/workspace/v1";
  const previous = localStorage.getItem(key);
  localStorage.removeItem(key);
  onTestFinished(() => {
    if (previous === null) localStorage.removeItem(key);
    else localStorage.setItem(key, previous);
  });
  let root: Context | undefined;
  const runtime = createDesktopRuntime(
    undefined,
    undefined,
    undefined,
    (context) => {
      root = context;
    },
  );
  onTestFinished(() => runtime.shutdown());
  const { project } = await runtime.ready;
  const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
  if (!root || !fiber) throw new Error("Project fiber is missing");
  const host = root.host;
  const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
  let finish!: (result: CliRunResult) => void;
  const pending = new Promise<CliRunResult>((resolve) => {
    finish = resolve;
  });
  const result: CliRunResult = {
    ok: true,
    code: 0,
    stdout: "uv 1.0",
    stderr: "",
    durationMs: 1,
  };
  const run = vi.spyOn(host.process, "run").mockReturnValue(pending);
  const exists = vi.spyOn(host.process, "exists").mockResolvedValue(true);
  onTestFinished(() => {
    finish(result);
    run.mockRestore();
    exists.mockRestore();
  });

  project.registerProject("D:/first");
  const old = project.workspace.getState();
  old.togglePinned("D:/first");
  old.toggleSessionPinned("D:/first", "old-session", "agent-a");
  old.setToolPaths({ uvCommand: "custom-uv", aawScriptPath: "D:/tool.py" });
  old.openWorkspace();
  const check = old.runHealthChecks();
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ command: ["custom-uv", "--version"] }),
  );
  expect(project.workspace.getState().isCheckingHealth).toBe(true);
  await fiber.dispose();
  expect(project.workspace.getState()).toMatchObject({
    activePath: null,
    selectedPath: null,
    health: null,
    isCheckingHealth: false,
  });
  await root.plugin(projectPlugin, config);
  const replacement = root.project.workspace;
  expect(replacement).not.toBe(project.workspace);
  expect(replacement.getState()).toMatchObject({
    activePath: null,
    selectedPath: null,
    health: null,
    recentWorkspaces: [{ path: "D:/first" }],
    pinnedPaths: ["D:/first"],
    pinnedSessions: ["d:/first\u0000old-session\u0000agent-a"],
    toolPaths: { uvCommand: "custom-uv", aawScriptPath: "D:/tool.py" },
  });
  old.selectWorkspace("D:/stale");
  old.setToolPaths({ uvCommand: "stale", aawScriptPath: "" });
  finish(result);
  await check;
  expect(run).toHaveBeenCalledOnce();
  expect(localStorage.getItem(key)).not.toContain("stale");
  expect(replacement.getState().health).toBeNull();
});

it("creates a new project coordinator on the same root and closes the previous sessions", async () => {
  const previousSettings = localStorage.getItem(desktopSettingsKey);
  const archiveRecords = [
    "aaw-desktop/archived-sessions.v1",
    "aaw-desktop/archived-session-metadata.v1",
  ].map((key) => [key, localStorage.getItem(key)] as const);
  localStorage.setItem(
    desktopSettingsKey,
    JSON.stringify({ activeAgentId: "native-opencode" }),
  );
  const peers: ReturnType<typeof standardAcpPeer>[] = [];
  let root: Context | undefined;
  const runtime = createDesktopRuntime(
    undefined,
    undefined,
    undefined,
    (context) => {
      root = context;
      vi.spyOn(context.agents, "openTransport").mockImplementation(() => {
        const peer = standardAcpPeer();
        peers.push(peer);
        return Promise.resolve(peer.client);
      });
    },
  );

  try {
    const { project, acpRuntime } = await runtime.ready;
    const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Project fiber is missing");
    const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
    await expect(
      project.openSession("/first", { forceNew: true }),
    ).resolves.toMatchObject({
      sessionId: "same-session",
    });
    const catalog = project.catalog.getState();
    expect(catalog.sessionsByPath["/first"]).toMatchObject([
      { id: "same-session" },
    ]);
    const agentKey = catalog.agentKey!;
    const activityKey = sessionActivityKey("/first", "same-session", agentKey);
    expect(
      project.send(
        { workspacePath: "/first", sessionId: "same-session", agentKey },
        "record activity",
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(project.activity.getState().entries[activityKey]?.status).toBe(
        "completed",
      ),
    );
    const archive = project.archive.getState();
    const archiveKey = sessionArchiveKey("/first", "same-session", agentKey);
    archive.archiveWithNotice("/first", "same-session");
    expect(project.archive.getState().notice).toMatchObject({
      sessionId: "same-session",
      agentKey,
    });
    expect(project.archive.getState().metadata[archiveKey]?.projectPath).toBe(
      "/first",
    );
    expect(
      project.runtimeDebugSnapshot().map(({ workspacePath }) => workspacePath),
    ).toEqual(["/first"]);
    const firstPool = [...peers];
    expect(firstPool).toHaveLength(4);

    await fiber.dispose();
    expect(firstPool.every(({ client }) => client.isClosed)).toBe(true);
    expect(project.runtimeDebugSnapshot()).toEqual([]);
    expect(project.catalog.getState().sessionsByPath).toEqual({});
    expect(project.activity.getState().entries).toEqual({});
    expect(project.archive.getState().notice).toBeNull();
    expect(() => project.openSession("/stale")).toThrow("stopping");
    expect(root.acpRuntime).toBe(acpRuntime);

    await root.plugin(projectPlugin, config);
    const replacement = root.project;
    expect(replacement).not.toBe(project);
    expect(replacement.catalog).not.toBe(project.catalog);
    expect(replacement.activity).not.toBe(project.activity);
    expect(replacement.catalog.getState()).toEqual({
      agentKey: null,
      sessionsByPath: {},
      statusByPath: {},
    });
    expect(replacement.activity.getState().entries).toEqual({});
    expect(replacement.archive.getState().notice).toBeNull();
    expect(
      replacement.archive.getState().archivedSessions.has(archiveKey),
    ).toBe(true);
    archive.unarchiveSession("/first", "same-session", agentKey);
    archive.archiveWithNotice("/stale", "old-action");
    expect(project.archive.getState().notice).toBeNull();
    expect(
      replacement.archive.getState().archivedSessions.has(archiveKey),
    ).toBe(true);
    expect(localStorage.getItem(archiveRecords[0]![0])).not.toContain(
      "old-action",
    );
    expect(replacement.runtimeDebugSnapshot()).toEqual([]);
    await expect(
      replacement.openSession("/second", { forceNew: true }),
    ).resolves.toMatchObject({
      sessionId: "same-session",
    });
    expect(
      replacement
        .runtimeDebugSnapshot()
        .map(({ workspacePath }) => workspacePath),
    ).toEqual(["/second"]);
    expect(
      replacement.catalog.getState().sessionsByPath["/first"],
    ).toBeUndefined();
    expect(project.runtimeDebugSnapshot()).toEqual([]);
  } finally {
    await runtime.shutdown();
    if (previousSettings === null) localStorage.removeItem(desktopSettingsKey);
    else localStorage.setItem(desktopSettingsKey, previousSettings);
    for (const [key, value] of archiveRecords) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }
});

it("settles outstanding navigation and starts a fresh queue after Project reload", async ({
  onTestFinished,
}) => {
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
    },
  );
  onTestFinished(() => runtime.shutdown());
  const { project } = await runtime.ready;
  const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
  if (!root || !fiber) throw new Error("Project fiber is missing");
  const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const staleWrite = vi.fn();
  const open = vi.fn(async (isLatest: () => boolean) => {
    await gate;
    if (isLatest()) staleWrite();
    return "late";
  });
  const queued = vi.fn(() => Promise.resolve("opened"));
  const first = project.enqueueSessionNavigation(open, "closed");
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  const second = project.enqueueSessionNavigation(queued, "closed");

  await fiber.dispose();
  await expect(first).resolves.toBe("closed");
  await expect(second).resolves.toBe("closed");
  await root.plugin(projectPlugin, config);
  await expect(
    root.project.enqueueSessionNavigation(
      () => Promise.resolve("new Fiber"),
      "closed",
    ),
  ).resolves.toBe("new Fiber");
  release();
  await gate;
  expect(staleWrite).not.toHaveBeenCalled();
  expect(queued).not.toHaveBeenCalled();
});
