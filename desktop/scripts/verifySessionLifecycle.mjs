import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const session = "lifecycle-target";
const neighbor = "lifecycle-neighbor";
const projectKey = (p) => p.replaceAll("\\", "/").toLowerCase();
const scope = (project, id) =>
  JSON.stringify(["codeagent", projectKey(project) + "#" + id]);
const transcript = (root) =>
  path.join(
    root,
    "fixture-home",
    ".cac",
    "projects",
    "old-project",
    session + ".jsonl",
  );

export async function seedLifecycle(root, workspace) {
  for (const [directory, value] of [
    ["session-snapshots", "[]"],
    ["conversation/queue", "[]"],
  ]) {
    const folder = path.join(root, directory);
    await fs.mkdir(folder, { recursive: true });
    for (const id of [session, neighbor]) {
      const key = scope(workspace, id);
      const hash = createHash("sha256").update(key).digest("hex");
      await fs.writeFile(
        path.join(folder, hash + ".json"),
        JSON.stringify(key) + "\n" + value,
      );
    }
  }
  await fs.mkdir(path.dirname(transcript(root)), { recursive: true });
  await fs.writeFile(
    transcript(root),
    JSON.stringify({
      type: "system",
      subtype: "init",
      sessionId: session,
      cwd: workspace,
    }) + "\n",
  );
}

export async function verifyLifecycle({
  evaluate,
  invoke,
  waitFor,
  workspace,
  destination,
  restart,
}) {
  const call = (command, args) => evaluate(invoke(command, args));
  const service =
    '(await import("/src/bootstrap/mainRuntime.ts")).readDesktopProjectService().sessions';
  const withService = (body) =>
    evaluate(
      `(async()=>{const s=${service};const workspace=${JSON.stringify(workspace)}, id=${JSON.stringify(session)};const agentKey=s.catalog.getState().agentKey;const target={agentKey,workspacePath:workspace,sessionId:id};${body}})()`,
    );
  const ready = () =>
    waitFor("工作台已加载", () =>
      evaluate("Boolean(window.__aawSessionStore)").catch(() => false),
    );
  await waitFor("按会话显示迁移结果", () =>
    evaluate(
      `[${JSON.stringify(session)},${JSON.stringify(neighbor)}].every(id=>document.body.innerText.includes(id+"：迁移完成"))`,
    ),
  );
  await evaluate(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="进入工作台").click()',
  );
  await ready();
  const now = Date.now();
  const query = {
    zone: "UTC",
    enabledAt: now - 86400000,
    workspace,
    agent: "codeagent",
    days: 7,
  };
  await call("usage_record", {
    ...query,
    turn: {
      workspace,
      agent: "codeagent",
      agentKey: "codeagent",
      session,
      turn: "first",
      startedAt: now,
      endedAt: now,
      model: "smoke",
      modelSource: "reported",
      status: "completed",
      input: 23,
      output: 17,
      total: 40,
      accounting: "turn-delta",
    },
  });
  const usage = await call("usage_query", query);
  assert.ok(usage.days.length > 0);
  const pending = await call("storage_location_schedule", {
    parent: destination,
  });
  await restart();
  await ready();
  const location = await call("storage_location_read", {});
  assert.equal(
    location.currentPath,
    pending.pendingPath,
    location.migrationError,
  );
  assert.deepEqual(await call("usage_query", query), usage);
  const read = (kind, id) =>
    call("session_data_read", { kind, scope: scope(workspace, id) });
  for (const id of [session, neighbor])
    assert.equal(await read("snapshot", id), "[]");
  assert.equal(
    await withService(
      "s.archiveWithNotice(workspace,id);return s.archive.getState().archivedSessions.size",
    ),
    1,
  );
  const queue = (await call("session_data_list", { kind: "queue" })).find(
    (entry) => entry.key === scope(workspace, session),
  );
  assert.ok(
    await call("session_data_remove", {
      kind: "queue",
      scope: queue.key,
      expectedRevision: queue.revision,
    }),
  );
  assert.equal(await read("queue", session), null);
  assert.equal(await read("snapshot", session), "[]");
  assert.equal(await read("queue", neighbor), "[]");
  const blocked = await withService(
    'const publisher=s.registerSessionGroups();publisher.publish(workspace,[{id:"task",title:"Task",status:"idle",members:[{sessionId:id,title:"History"}]}]);try{await s.deleteArchivedSession(target);return ""}catch(e){return String(e)}finally{publisher.dispose()}',
  );
  assert.match(blocked, /定时任务或工作流拥有/);
  await fs.access(transcript(path.dirname(workspace)));
  await withService("await s.deleteArchivedSession(target)");
  await assert.rejects(fs.access(transcript(path.dirname(workspace))), {
    code: "ENOENT",
  });
  assert.equal(await read("snapshot", session), null);
  const agentRoot = path.join(location.currentPath, "agents");
  const [agentDirectory] = (await fs.readdir(agentRoot)).filter(
    (dir) => dir === "codeagent",
  );
  const projects = path.join(agentRoot, agentDirectory, "projects");
  const [project] = await fs.readdir(projects);
  assert.match(project, /^remove-project~[0-9a-f]{12}$/);
  await fs.access(
    path.join(projects, project, "sessions", neighbor, "identity.json"),
  );
  for (const old of [
    "session-snapshots",
    "conversation",
    "turn-workspaces",
    "session-recovery",
    "session-deletions",
  ]) {
    await assert.rejects(fs.access(path.join(location.currentPath, old)), {
      code: "ENOENT",
    });
  }
  const persisted = JSON.parse(
    await fs.readFile(
      path.join(projects, project, "sessions-index.json"),
      "utf8",
    ),
  );
  assert.deepEqual(persisted, [neighbor]);
  assert.equal(
    (await fs.readdir(path.join(projects, project, "sessions"))).length,
    1,
  );
  await assert.rejects(
    call("session_data_write", {
      kind: "snapshot",
      scope: scope(workspace, session),
      value: "[]",
      migrate: false,
    }),
    /彻底删除/,
  );
  assert.equal(await read("snapshot", neighbor), "[]");
  assert.equal(
    await withService("return s.archive.getState().archivedSessions.size"),
    0,
  );
  assert.deepEqual(await call("usage_query", query), usage);
  console.log(
    "PASS: 同批迁移数据经迁盘重启、归档、按类别清理、任务保护及彻底删除，邻居与用量统计保留",
  );
}
