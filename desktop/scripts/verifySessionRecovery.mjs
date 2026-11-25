import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
const id = "aaw-recovery-smoke";
const neighbor = "healthy-neighbor";
const projectKey = (p) => p.replaceAll("\\", "/").toLowerCase();
const hash = (s) => createHash("sha256").update(s).digest("hex");
export async function seedRecovery(root, workspace, agent) {
  const scope = JSON.stringify([agent, projectKey(workspace) + "#" + id]);
  const directory = path.join(root, "session-snapshots");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, hash(scope) + ".json"),
    JSON.stringify(scope) + "\n{broken",
  );
  const queue = path.join(root, "conversation", "queue");
  await fs.mkdir(queue, { recursive: true });
  await fs.writeFile(
    path.join(queue, hash(scope) + ".json"),
    JSON.stringify(scope) + '\n["old queue"]',
  );
  const healthy = JSON.stringify([
    agent,
    projectKey(workspace) + "#" + neighbor,
  ]);
  await fs.writeFile(
    path.join(queue, hash(healthy) + ".json"),
    JSON.stringify(healthy) + '\n["保留队列"]',
  );
  const records = Object.fromEntries(
    [id, neighbor].map((sessionId) => [
      JSON.stringify([projectKey(workspace), sessionId]),
      {
        scope: { workspaceId: workspace, sessionId },
        urls: [`https://example.test/${sessionId}`],
        revision: "old",
        touched: 1,
      },
    ]),
  );
  await fs.mkdir(path.join(root, "browser-restore"));
  await fs.writeFile(
    path.join(root, "browser-restore", "snapshots.json"),
    JSON.stringify({ version: 1, epoch: "epoch1", records }),
  );
}
export async function verifyRecovery({ evaluate, waitFor, workspace, absent }) {
  const root = path.dirname(workspace);
  const journal = path.join(root, "runtime/session-recovery");
  const receipts = path.join(root, "recovery-receipts.jsonl");
  const check = async (label, read) => {
    try {
      await waitFor(label, read);
    } catch (error) {
      throw new Error(
        JSON.stringify({
          screen: await evaluate("document.body.innerText.slice(0,1200)"),
          storage: await evaluate(
            "window.__TAURI_INTERNALS__.invoke('storage_location_read').catch(String)",
          ),
          fixture: await fs.readdir(root),
        }),
        { cause: error },
      );
    }
  };
  await check("清理结果", () =>
    evaluate(
      `document.body.innerText.includes("${id}") && document.body.innerText.includes("本地历史已清理")`,
    ),
  );
  const files = (await fs.readdir(journal)).filter((p) => p.endsWith(".json"));
  assert.ok(
    await evaluate(`document.body.innerText.includes("${neighbor}：迁移完成")`),
  );
  assert.equal(files.length, 1);
  const entry = JSON.parse(
    await fs.readFile(path.join(journal, files[0]), "utf8"),
  );
  assert.equal(entry.phase, "retained");
  assert.deepEqual(entry.owner, {
    agentId: "custom-native-smoke",
    project: projectKey(workspace),
    sessionId: id,
  });
  const dirs = async (dir) =>
    (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  const [agent] = await dirs(path.join(root, "agents"));
  const [project] = await dirs(path.join(agent, "projects"));
  const sessions = path.join(project, "sessions");
  const [healthy] = await dirs(sessions);
  assert.deepEqual(await dirs(sessions), [healthy]);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(healthy, "identity.json"), "utf8"))
      .sessionId,
    neighbor,
  );
  assert.ok(
    (await fs.readFile(path.join(healthy, "queue.json"), "utf8")).includes(
      "保留队列",
    ),
  );
  const [browserFile] = await fs.readdir(path.join(healthy, "browser"));
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(healthy, "browser", browserFile), "utf8"),
    ).urls,
    [`https://example.test/${neighbor}`],
  );
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(root, "browser-restore", "snapshots.json"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(manifest.files), [
    JSON.stringify([projectKey(workspace), neighbor]),
  ]);
  const browserRead = (sessionId) =>
    evaluate(
      `window.__TAURI_INTERNALS__.invoke("browser_restore_read",{scope:${JSON.stringify({ workspaceId: workspace, sessionId })}})`,
    );
  assert.deepEqual((await browserRead(id)).urls, []);
  assert.deepEqual((await browserRead(neighbor)).urls, [
    `https://example.test/${neighbor}`,
  ]);
  await evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==="进入工作台").click()`,
  );
  const row = `[...document.querySelectorAll('button,[role="button"]')].find(b=>b.textContent.trim()==="会话")`;
  await check("保留的会话出现在项目侧栏", () => evaluate(`Boolean(${row})`));
  await assert.rejects(fs.access(receipts), { code: "ENOENT" });
  await evaluate(`(${row}).click()`);
  await check("Agent 接收首次恢复请求", async () => {
    try {
      return Boolean(await fs.readFile(receipts, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  });
  if (absent) {
    await check(
      "明确不存在后移除本地记录",
      async () => (await fs.readdir(journal)).length === 0,
    );
    assert.deepEqual(await dirs(sessions), [healthy]);
    await check("侧栏移除失效会话", () => evaluate(`!(${row})`));
    console.log(
      "PASS: Agent 明确返回 SESSION_NOT_FOUND，移除本地身份及侧栏条目",
    );
    return;
  }
  await check("暂时性错误保留恢复入口", () =>
    evaluate(
      `Boolean(${row}) && !window.__aawSessionStore?.getState().isConnecting`,
    ),
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(journal, files[0]), "utf8")).phase,
    "retained",
  );
  await evaluate(
    "window.__oldRecoveryPage=true;setTimeout(()=>location.reload(),0);true",
  );
  await check("重新加载工作台仍保留会话", () =>
    evaluate(`!window.__oldRecoveryPage && Boolean(${row})`).catch(() => false),
  );
  assert.equal(
    (await fs.readFile(receipts, "utf8")).trimEnd().split("\n").length,
    1,
  );
  await evaluate(`(${row}).click()`);
  await check("ACP 原始消息出现在信息流", () =>
    evaluate('document.body.innerText.includes("从 Agent 原始历史恢复的消息")'),
  );
  await waitFor(
    "恢复日志完成",
    async () => (await fs.readdir(journal)).length === 0,
  );
  const [directory] = (await dirs(sessions)).filter((dir) => dir !== healthy);
  const snapshot = await fs.readFile(
    path.join(directory, "messages.json"),
    "utf8",
  );
  assert.ok(snapshot.includes("从 Agent 原始历史恢复的消息"));
  assert.deepEqual(
    (await fs.readFile(receipts, "utf8")).trimEnd().split("\n").map(JSON.parse),
    Array.from({ length: 2 }, () => ({
      method: "session/load",
      sessionId: id,
    })),
  );
  console.log(
    "PASS: 损坏历史清理、外置身份保留、首次点击 ACP 加载、信息流显示和快照重建",
  );
}
