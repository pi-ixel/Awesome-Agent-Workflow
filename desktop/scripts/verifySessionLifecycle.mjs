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
  if (process.env.AAW_ARCHIVE_DELETE_BENCH === "1") {
    const scenarios = [
      ...Array.from({ length: 20 }, () => ({ count: 1, large: false })),
      { count: 10, large: false },
      { count: 100, large: false },
      { count: 1, large: true },
    ];
    const results = [];
    const click = (expression) =>
      waitFor(expression, () => evaluate(`(()=>{const control=${expression};if(!control || control.disabled)return false;control.click();return true})()`));
    await click(`document.querySelector('button[aria-label="设置"]')`);
    await click('document.getElementById("settings-tab-archive")');
    const archive = `document.querySelector('section[aria-label^="已归档会话"]')`;
    const button = (label) =>
      `[...${archive}.querySelectorAll("button")].find(button=>button.textContent.trim()===${JSON.stringify(label)})`;
    // 保留同样数量的其他会话，验证删除一条时不会随资料库大小线性变慢。
    for (let i = 0; i < 100; i++) {
      await call("session_data_write", {
        kind: "snapshot", scope: scope(workspace, `benchmark-control-${i}`),
        value: "[]", migrate: false,
      });
    }
    const sourceDirectory = path.dirname(transcript(path.dirname(workspace)));
    for (const [scenario, { count, large }] of scenarios.entries()) {
      const only = process.env.AAW_ARCHIVE_DELETE_CASE;
      if (only === "large" && !large || only === "regular" && large) continue;
      const ids = Array.from({ length: count }, (_, i) => `benchmark-${scenario}-${i}`);
      for (const id of ids) {
        await call("session_data_write", {
          kind: "snapshot", scope: scope(workspace, id), value: "[]", migrate: false,
        });
        const directory = large
          ? path.join(path.dirname(sourceDirectory), workspace.replace(/[^\p{L}\p{N}]/gu, "-"))
          : sourceDirectory;
        await fs.mkdir(directory, { recursive: true });
        const history = path.join(directory, id + ".jsonl");
        const file = await fs.open(history, "w");
        try {
          if (large) {
            const line = JSON.stringify({ type: "user", sessionId: id, cwd: workspace, text: "x".repeat(8 * 1024) }) + "\n";
            const batch = Buffer.from(line.repeat(64));
            for (let i = 0; i < 100; i++) await file.write(batch);
          } else {
            await file.writeFile(JSON.stringify({ type: "system", subtype: "init", sessionId: id, cwd: workspace }) + "\n");
          }
        } finally {
          await file.close();
        }
      }
      await withService(`
        for(const sessionId of ${JSON.stringify(ids)}) s.archiveWithNotice(workspace,sessionId);
      `);
      if (count === 1) {
        await click(`${archive}?.querySelector('button[aria-label^="彻底删除 "]')`);
      } else {
        await click(button("批量选择"));
        await click(`[...${archive}.querySelectorAll("label")].find(label=>label.textContent.includes("全选当前筛选结果"))?.querySelector("input")`);
        await click(button("彻底删除所选"));
      }
      const confirmation = count === 1 ? "彻底删除会话" : "批量彻底删除会话";
      const confirmText = count === 1 ? "彻底删除" : `彻底删除 ${count} 条`;
      await waitFor("删除确认框", () => evaluate(`Boolean(document.querySelector('[aria-label="${confirmation}"]'))`));
      const elapsed = await evaluate(`(()=>new Promise((resolve,reject)=>{
        const modal=document.querySelector('[aria-label="${confirmation}"]');
        const confirm=[...modal.querySelectorAll("button")].find(button=>button.textContent.trim()===${JSON.stringify(confirmText)});
        const timer=setTimeout(()=>{observer.disconnect();reject(new Error("归档列表未清空"))},175000);
        const started=performance.now();
        const observer=new MutationObserver(()=>{
          const error=${archive}?.querySelector('[role="alert"]')?.textContent;
          if(error){clearTimeout(timer);observer.disconnect();reject(new Error(error));return}
          if(${archive}?.getAttribute("aria-label")==="已归档会话（0）"){
            clearTimeout(timer);observer.disconnect();resolve(performance.now()-started);
          }
        });
        observer.observe(document.body,{attributes:true,childList:true,subtree:true});
        confirm.click();
      }))()`);
      results.push({ count, large, ms: Math.round(elapsed) });
      console.log("ARCHIVE_DELETE_SAMPLE " + JSON.stringify(results.at(-1)));
    }
    console.log("ARCHIVE_DELETE_BENCH " + JSON.stringify(results));
    return;
  }
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
  if (process.env.AAW_ARCHIVE_DELETE_VERIFY_MISSING === "1") {
    const id = "lifecycle-missing-source";
    await call("session_data_write", {
      kind: "snapshot", scope: scope(workspace, id), value: "[]", migrate: false,
    });
    await withService(`
      const sessionId=${JSON.stringify(id)};
      s.archiveWithNotice(workspace,sessionId);
      await s.deleteArchivedSession({...target,sessionId});
      if(s.archive.getState().archivedSessions.size) throw new Error("缺失源历史的归档仍存在");
    `);
    assert.equal(await read("snapshot", id), null);
    console.log("PASS: 源历史缺失时清理 AAW 会话和归档");
    const startedId = "lifecycle-started-deletion";
    const queuedId = "lifecycle-unstarted-deletion";
    for (const id of [startedId, queuedId]) {
      await call("session_data_write", {
        kind: "snapshot", scope: scope(workspace, id),
        value: "[]", migrate: false,
      });
    }
    await withService(`
      const started={...target,sessionId:${JSON.stringify(startedId)}};
      for(const sessionId of [started.sessionId,${JSON.stringify(queuedId)}]) {
        s.archiveWithNotice(workspace,sessionId);
      }
      const {deletionKey}=await import("/src/plugins/project/sessions/sessionDeletion.ts");
      const {webviewStorage,flushNativeConfiguration}=await import("/src/plugins/host/storage/storage.ts");
      const key="aaw-desktop/session-deletions.v1";
      const entries=JSON.parse(webviewStorage.getItem(key)||"{}");
      entries[deletionKey(started)]={...started,phase:"local"};
      webviewStorage.setItem(key,JSON.stringify(entries));
      await flushNativeConfiguration();
    `);
    await restart();
    await ready();
    await waitFor("重启后完成已开始的归档删除", () =>
      withService(`return Object.values(s.deletions.getState().entries).some(
        entry=>entry.sessionId===${JSON.stringify(startedId)} && entry.phase==="done"
      )`),
    );
    assert.equal(await read("snapshot", startedId), null);
    assert.equal(await read("snapshot", queuedId), "[]");
    assert.equal(await withService("return s.archive.getState().archivedSessions.size"), 1);
    console.log("PASS: 重启仅恢复已开始的删除，尚未开始的条目仍归档");

  }
  console.log(
    "PASS: 同批迁移数据经迁盘重启、归档、按类别清理、任务保护及彻底删除，邻居与用量统计保留",
  );
}
