import { mutableProjectForeground } from "../../helpers/foreground.ts";
import { annotationDraftOwner } from "../../helpers/projectAnnotationDrafts.ts";
import type { Context } from "cordis";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { createDesktopRuntime } from "../../../src/bootstrap/bootstrap.ts";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { desktopSettingsKey } from "../../../src/plugins/configuration/config.ts";
import type { CliRunResult } from "../../../src/plugins/host/types.ts";
import { decodeAnnotationMessage, encodeAnnotationMessage } from "../../../src/plugins/project/composer/annotationMessage.ts";
import type { DocumentAnnotation } from "../../../src/plugins/documents/types.ts";
import * as projectPlugin from "../../../src/plugins/project/index.ts";
import { draftScopeKey } from "../../../src/plugins/project/composer/draftStore.ts";
import { sessionArchiveKey } from "../../../src/plugins/project/sessions/sessionArchiveStore.ts";
import { sessionActivityKey } from "../../../src/plugins/project/sessions/sessionActivityStore.ts";
import { standardAcpPeer } from "../../helpers/standardAcpPeer.ts";
import { addProjectViaDialog } from "../../../src/plugins/project/ui/addProjectFlow.ts";

it("debounces foreground workspace activity and cancels callbacks on switch and unload", async ({
  onTestFinished,
}) => {
  const runtime = createTestDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
  });
  onTestFinished(() => runtime.shutdown());
  const { project } = await runtime.ready;
  const { projects } = project;
  const { session } = mutableProjectForeground(project);
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  projects.openWorkspace("/repo");
  const refresh = vi.fn();
  const otherProject = vi.fn();
  projects.subscribeWorkspaceActivity("/repo/src", refresh);
  projects.subscribeWorkspaceActivity("/other", otherProject);
  vi.advanceTimersByTime(400);
  expect(refresh).toHaveBeenCalledOnce();
  expect(otherProject).not.toHaveBeenCalled();

  session.getState().handleEvent({
    type: "tool_call",
    sessionId: "workspace-activity",
    toolCallId: "edit",
    status: "in_progress",
  });
  vi.advanceTimersByTime(400);
  expect(refresh).toHaveBeenCalledOnce();
  session.getState().handleEvent({
    type: "tool_call_update",
    sessionId: "workspace-activity",
    toolCallId: "edit",
    status: "completed",
  });
  vi.advanceTimersByTime(200);
  session.setState({ isAgentRunning: true });
  vi.advanceTimersByTime(399);
  expect(refresh).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(2);

  session.setState({ isAgentRunning: false });
  projects.openWorkspace("/other");
  vi.advanceTimersByTime(400);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(otherProject).toHaveBeenCalledOnce();
  session.setState({ isAgentRunning: true });
  await runtime.shutdown();
  vi.advanceTimersByTime(400);
  expect(otherProject).toHaveBeenCalledOnce();
});

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
  const { drafts: { composer }, conversation: { expansion } } = project;
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
  expect(replacement.conversation.expansion.get("tool:read")).toBeUndefined();
  expect(expansion.get("tool:read")).toBeUndefined();
  replacement.drafts.composer.history.setScope(path, "draft-session", "agent");
  expect(replacement.drafts.composer.history.get()).toEqual(["persisted prompt"]);
  expect(await replacement.drafts.composer.imageDrafts.load()).toEqual({
    [scope]: [image],
  });
  const next = vi.fn();
  replacement.drafts.composer.subscribePrefill(next);
  expect(replacement.drafts.composer.prefill("new instance")).toBe(true);
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
  const views = project.conversation.foreground;
  expect(views.session).not.toHaveProperty("setState");
  expect(views.session.getState()).not.toHaveProperty("clear");
  expect(views.approval.getState()).not.toHaveProperty("select");
  expect(views.runtime.getState()).not.toHaveProperty("handleSessionEvent");
  expect(project.sessions.catalog).not.toHaveProperty("setState");
  expect(project.sessions.activity.getState()).not.toHaveProperty("update");
  const foregroundEvents = vi.fn();
  project.sessions.subscribeSessionActivity(foregroundEvents);
  await project.sessions.openSession(leftPath, { forceNew: true });
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

  await project.sessions.openSession(rightPath, { forceNew: true });
  project.projects.openWorkspace(rightPath);
  project.conversation.reportCommandFailure(
    { workspacePath: leftPath, agentKey, sessionId },
    "late failure on the left",
  );
  expect(views.session.getState().lastError).toBeNull();
  project.conversation.reportCommandFailure(
    { workspacePath: rightPath, agentKey, sessionId },
    "right side error",
  );
  expect(views.session.getState().lastError).toBe("right side error");
  expect(approval.getState().pending).toEqual([]);
  expect(status.getState().usage).toBeNull();
  leftPeer.update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "background reply" },
  });
  await vi.waitFor(async () => {
    await project.sessions.openSessionFromEntry(leftPath, sessionId, agentKey);
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
  project.interactions.cancelPermission(
    { workspacePath: leftPath, sessionId, agentKey },
    pending!.id,
  );
  await expect(reply).resolves.toMatchObject({
    result: { outcome: { outcome: "cancelled" } },
  });

  const observer = vi.fn();
  const unsubscribe = views.session.subscribe(observer);
  await fiber.dispose();
  expect(views.session.getState().activeSessionId).toBeNull();
  observer.mockClear();
  await root.plugin(projectPlugin, config);
  const replacement = root.project;
  expect(replacement.conversation.foreground).not.toBe(project.conversation.foreground);
  session.setState({ lastError: "stale write" });
  project.conversation.reportCommandFailure(
    { workspacePath: leftPath, agentKey, sessionId },
    "stale failure",
  );
  expect(observer).not.toHaveBeenCalled();
  unsubscribe();
  expect(session.getState()).toMatchObject({
    activeSessionId: null,
    items: [],
    lastError: null,
  });
  expect(approval.getState().pending).toEqual([]);
  expect(status.getState().usage).toBeNull();
  expect(replacement.conversation.foreground.session.getState().activeSessionId).toBeNull();
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
  const drafts = project.drafts.annotationDrafts;
  const owner = annotationDraftOwner(drafts);
  expect(drafts).not.toHaveProperty("setState");
  expect(drafts).not.toHaveProperty("migrate");
  expect(drafts).not.toHaveProperty("settle");
  expect(drafts).not.toHaveProperty("isActive");
  expect(drafts.getState()).not.toHaveProperty("put");
  expect(drafts.getState()).not.toHaveProperty("migrations");
  const listen = vi.fn();
  drafts.subscribe(listen);
  const { setStatusMode } = project.conversation;
  setStatusMode("mini");
  expect(drafts.put(scope, [annotation])).toBe(true);
  expect(drafts.submit(scope, prompt)).toBe(true);
  const followup = { ...annotation, id: "unsent", comment: "Keep this draft" };
  expect(drafts.put(scope, [followup])).toBe(true);
  owner.migrate(`${scope}/old`, scope);
  expect(owner.getState().migrations).not.toEqual({});
  expect(listen).toHaveBeenCalled();

  await fiber.dispose();
  expect(drafts.getState()).toEqual({ drafts: {}, error: null });
  expect(owner.getState().migrations).toEqual({});
  listen.mockClear();
  expect(project.conversation.statusView.getState().mode).toBe("auto");
  await root.plugin(projectPlugin, config);
  const replacement = root.project;
  replacement.drafts.annotationDrafts.ensure(scope);
  const restored = replacement.drafts.annotationDrafts.getState().drafts[scope];
  expect(restored?.annotations).toEqual([followup]);
  expect(restored?.submissions[submission.id]).toEqual({
    prompt,
    state: "uncertain",
  });

  const persisted = localStorage.getItem(key);
  owner.settle(prompt, false);
  expect(drafts.put(scope, [])).toBe(false);
  drafts.rejectSubmission(scope, prompt);
  drafts.finishLegacyDraft(scope, `${scope}/old`);
  setStatusMode("panel");
  expect(localStorage.getItem(key)).toBe(persisted);
  expect(localStorage.getItem(marker)).toBeNull();
  expect(project.conversation.statusView.getState().mode).toBe("auto");
  expect(replacement.conversation.statusView.getState().mode).toBe("auto");
  expect(
    replacement.drafts.annotationDrafts.recover(scope, submission.id),
  ).toBe("Update");
  expect(
    replacement.drafts.annotationDrafts.getState().drafts[scope]?.annotations,
  ).toEqual([followup, annotation]);
  expect(listen).not.toHaveBeenCalled();
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

  project.projects.registerProject("D:/first");
  const old = project.projects;
  expect(old.workspace).not.toHaveProperty("setState");
  expect(old.workspace.getState()).not.toHaveProperty("openWorkspace");
  old.togglePinned("D:/first");
  old.toggleSessionPinned("D:/first", "old-session", "agent-a");
  old.patchToolPaths({ uvCommand: "custom-uv", aawScriptPath: "D:/tool.py" });
  old.openWorkspace();
  const check = old.runHealthChecks();
  const onWorkspaceChange = vi.fn();
  const unsubscribe = old.workspace.subscribe(onWorkspaceChange);
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ command: ["custom-uv", "--version"] }),
  );
  expect(project.projects.workspace.getState().isCheckingHealth).toBe(true);
  await fiber.dispose();
  expect(project.projects.workspace.getState()).toMatchObject({
    activePath: null,
    selectedPath: null,
    health: null,
    isCheckingHealth: false,
  });
  const notificationsOnDispose = onWorkspaceChange.mock.calls.length;
  expect(notificationsOnDispose).toBeGreaterThan(0);
  await root.plugin(projectPlugin, config);
  const replacement = root.project.projects.workspace;
  expect(replacement).not.toBe(project.projects.workspace);
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
  old.patchToolPaths({ uvCommand: "stale", aawScriptPath: "" });
  finish(result);
  await check;
  expect(run).toHaveBeenCalledOnce();
  expect(onWorkspaceChange).toHaveBeenCalledTimes(notificationsOnDispose);
  unsubscribe();
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
      project.sessions.openSession("/first", { forceNew: true }),
    ).resolves.toMatchObject({
      sessionId: "same-session",
    });
    const catalog = project.sessions.catalog.getState();
    expect(catalog.sessionsByPath["/first"]).toMatchObject([
      { id: "same-session" },
    ]);
    const agentKey = catalog.agentKey!;
    const activityKey = sessionActivityKey("/first", "same-session", agentKey);
    expect(
      project.conversation.send(
        { workspacePath: "/first", sessionId: "same-session", agentKey },
        "record activity",
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(project.sessions.activity.getState().entries[activityKey]?.status).toBe(
        "completed",
      ),
    );
    const { archiveWithNotice, unarchiveSession } = project.sessions;
    const archiveKey = sessionArchiveKey("/first", "same-session", agentKey);
    expect(project.sessions.archive).not.toHaveProperty("setState");
    expect(project.sessions.archive.getState()).not.toHaveProperty("archiveWithNotice");
    archiveWithNotice("/first", "same-session");
    expect(project.sessions.archive.getState().notice).toMatchObject({
      sessionId: "same-session",
      agentKey,
    });
    expect(project.sessions.archive.getState().metadata[archiveKey]?.projectPath).toBe(
      "/first",
    );
    expect(
      project.sessions.runtimeDebugSnapshot().map(({ workspacePath }) => workspacePath),
    ).toEqual(["/first"]);
    const firstPool = [...peers];
    expect(firstPool).toHaveLength(4);

    await fiber.dispose();
    expect(firstPool.every(({ client }) => client.isClosed)).toBe(true);
    expect(project.sessions.runtimeDebugSnapshot()).toEqual([]);
    expect(project.sessions.catalog.getState().sessionsByPath).toEqual({});
    expect(project.sessions.activity.getState().entries).toEqual({});
    expect(project.sessions.archive.getState().notice).toBeNull();
    expect(() => project.sessions.openSession("/stale")).toThrow("stopping");
    expect(root.acpRuntime).toBe(acpRuntime);

    await root.plugin(projectPlugin, config);
    const replacement = root.project;
    expect(replacement).not.toBe(project);
    expect(replacement.sessions.catalog).not.toBe(project.sessions.catalog);
    expect(replacement.sessions.activity).not.toBe(project.sessions.activity);
    expect(replacement.sessions.catalog.getState()).toEqual({
      agentKey: null,
      sessionsByPath: {},
      statusByPath: {},
    });
    expect(replacement.sessions.activity.getState().entries).toEqual({});
    expect(replacement.sessions.archive.getState().notice).toBeNull();
    expect(
      replacement.sessions.archive.getState().archivedSessions.has(archiveKey),
    ).toBe(true);
    unarchiveSession("/first", "same-session", agentKey);
    archiveWithNotice("/stale", "old-action");
    expect(project.sessions.archive.getState().notice).toBeNull();
    expect(
      replacement.sessions.archive.getState().archivedSessions.has(archiveKey),
    ).toBe(true);
    expect(localStorage.getItem(archiveRecords[0]![0])).not.toContain(
      "old-action",
    );
    expect(replacement.sessions.runtimeDebugSnapshot()).toEqual([]);
    await expect(
      replacement.sessions.openSession("/second", { forceNew: true }),
    ).resolves.toMatchObject({
      sessionId: "same-session",
    });
    expect(
      replacement
        .sessions.runtimeDebugSnapshot()
        .map(({ workspacePath }) => workspacePath),
    ).toEqual(["/second"]);
    expect(
      replacement.sessions.catalog.getState().sessionsByPath["/first"],
    ).toBeUndefined();
    expect(project.sessions.runtimeDebugSnapshot()).toEqual([]);
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
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  const openSession = vi.fn()
    .mockImplementationOnce(async () => {
      await gate;
      return { sessionId: "late", draft: true };
    })
    .mockResolvedValue(null);
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve(), openSession },
    undefined,
    (context) => {
      root = context;
    },
  );
  onTestFinished(() => runtime.shutdown());
  const { project, workbench } = await runtime.ready;
  const [fiber] = root?.registry.get(projectPlugin)?.fibers ?? [];
  if (!root || !fiber) throw new Error("Project fiber is missing");
  const config = fiber.config as Parameters<typeof projectPlugin.apply>[1];
  workbench.navigation.getState().openView("project-overview", "/project");
  expect(project.sessions).not.toHaveProperty("enqueueSessionNavigation");
  const deliver = vi.fn(() => true);
  const selection = { kind: "draft" } as const;
  const active = () => true;
  const first = project.sessions.deliverToSession("/project", selection, active, deliver);
  await vi.waitFor(() => expect(openSession).toHaveBeenCalledOnce());
  const second = project.sessions.deliverToSession("/project", selection, active, deliver);

  await fiber.dispose();
  const closed = { ok: false, reason: "项目服务已关闭" };
  await expect(first).resolves.toEqual(closed);
  await expect(second).resolves.toEqual(closed);
  await root.plugin(projectPlugin, config);
  await expect(
    root.project.sessions.deliverToSession("/project", selection, active, deliver),
  ).resolves.toEqual({ ok: false, reason: "连接会话失败" });
  expect(openSession).toHaveBeenCalledTimes(2);
  release();
  await gate;
  expect(openSession).toHaveBeenCalledTimes(2);
  expect(deliver).not.toHaveBeenCalled();
});
