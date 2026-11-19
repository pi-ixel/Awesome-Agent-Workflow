import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleTool } from "../src/plugins/tools/ui/sample.ts";
import { exportToolProject, importToolProject } from "../src/plugins/tools/runtime/projectArchive.ts";
import { unzipSync, zipSync } from "fflate";

const root = mkdtempSync(join(tmpdir(), "aaw-tools-runtime-test-"));
const runner = fileURLToPath(new URL("./tools-cli.mjs", import.meta.url));

function invoke(args, input) {
  const child = spawnSync(process.execPath, [runner, ...args], {
    input, encoding: "utf8", timeout: 30000, env: { ...process.env, AAW_TOOLS_DATA_ROOT: root },
  });
  if (child.error) throw child.error;
  return { code: child.status, data: JSON.parse(child.stdout.trim()) };
}

try {
  // aawStore 的最小探针：写一次、另起进程读一次，证明数据真落在磁盘上。
  const storeProbe = {
    schemaVersion: 1, id: "store-probe", name: "存储探针", version: "1.0.0",
    html: `<script>window.aawActions = {
      write: async (input) => { await aawStore.set("probe", input.value); return { written: input.value }; },
      read: async () => ({ value: await aawStore.get("probe") }),
    };</script>`,
    actions: [
      { id: "write", description: "写入一个值", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
      { id: "read", description: "读出已存的值", inputSchema: { type: "object", properties: {} } },
    ],
  };
  // 剪切板能力探针：验证 aawClipboard 走主进程、不需要用户手势，且跨进程可见。
  // 这类工具（剪切板历史、复制后清洗）在隐藏窗口里执行 CLI 动作时最容易失效。
  const clipboardProbe = {
    schemaVersion: 1, id: "clipboard-probe", name: "剪切板探针", version: "1.0.0",
    html: `<script>window.aawActions = {
      peek: async () => ({ value: await aawClipboard.readText() }),
      roundtrip: async (input) => { await aawClipboard.writeText(input.value); return { value: await aawClipboard.readText() }; },
      restore: async (input) => { await aawClipboard.writeText(input.value); return { ok: true }; },
    };</script>`,
    actions: [
      { id: "peek", description: "读取剪切板", inputSchema: { type: "object", properties: {} } },
      { id: "roundtrip", description: "写入并读回", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
      { id: "restore", description: "写回原内容", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
    ],
  };
  const configuration = join(root, "configuration");
  mkdirSync(configuration);
  writeFileSync(join(configuration, "preferences.json"), JSON.stringify({
    "aaw-desktop.auth.v1": JSON.stringify({ version: 1, user: { id: "smoke" } }),
    "aaw-desktop.personal-tools.v1": JSON.stringify({
      "user:smoke": [{ package: sampleTool, settings: { indent: 4 } }, { package: storeProbe }, { package: clipboardProbe }],
      "user:unrelated": [{ package: { ...sampleTool, id: "hidden" } }],
    }),
  }));
  const listed = invoke(["list"]);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.data.result.map(({ id }) => id).sort(), [sampleTool.id, storeProbe.id, clipboardProbe.id].sort());

  // 先记住用户原来的剪切板内容，测完写回去，别把探针留在系统剪切板里。
  const clipboardBefore = invoke(["run", clipboardProbe.id, "peek"], "{}");
  assert.equal(clipboardBefore.code, 0);
  const probeValue = "AAW 剪切板探针";
  const clipRoundtrip = invoke(["run", clipboardProbe.id, "roundtrip"], JSON.stringify({ value: probeValue }));
  assert.deepEqual(clipRoundtrip.data.result, { value: probeValue });
  const clipboardAfter = invoke(["run", clipboardProbe.id, "peek"], "{}");
  assert.equal(clipboardAfter.data.result.value, probeValue);
  if (typeof clipboardBefore.data.result.value === "string")
    invoke(["run", clipboardProbe.id, "restore"], JSON.stringify({ value: clipboardBefore.data.result.value }));

  const described = invoke(["describe", sampleTool.id]);
  assert.equal(described.code, 0);
  assert.equal(described.data.result.actions[0].inputSchema.properties.text.type, "string");

  const executed = invoke(["run", sampleTool.id, "format"], JSON.stringify({ text: '{"hello":"AAW"}' }));
  assert.deepEqual(executed, { code: 0, data: { ok: true, result: '{\n    "hello": "AAW"\n}' } });
  const wrongAction = invoke(["run", sampleTool.id, "missing"], "{}");
  assert.equal(wrongAction.code, 1);
  assert.equal(wrongAction.data.ok, false);

  const written = invoke(["run", storeProbe.id, "write"], JSON.stringify({ value: "持久化" }));
  assert.deepEqual(written.data.result, { written: "持久化" });
  // 换一个进程读：内存分区可不会跨进程存活，能读到就说明落盘了。
  const readBack = invoke(["run", storeProbe.id, "read"], "{}");
  assert.deepEqual(readBack.data.result, { value: "持久化" });
  assert.ok(readFileSync(join(root, "tools", "storage", "smoke", "store-probe.json"), "utf8").includes("持久化"));
  const exported = join(root, "source");
  const archive = exportToolProject(sampleTool);
  assert.equal(importToolProject(archive).html, sampleTool.html);
  for (const [path, bytes] of Object.entries(unzipSync(archive))) {
    const target = join(exported, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  // 导出的源码包不依赖 Node：没有 package.json / 构建脚本，改完直接打包拖回去。
  assert.ok(existsSync(join(exported, "README.md")));
  assert.equal(existsSync(join(exported, "scripts", "build.mjs")), false);
  const repacked = zipSync(Object.fromEntries(Object.entries(unzipSync(archive))));
  const roundtrip = importToolProject(repacked);
  assert.equal(roundtrip.html, sampleTool.html);
  assert.equal(roundtrip.settingsSchema[0].default, 2);
  process.stdout.write("Electron tools CLI smoke passed.\n");
} finally {
  rmSync(root, { force: true, recursive: true });
}
