import { it, expect } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { exportToolProject, importToolArchive, importToolProject, scanUsedCapabilities, toolProjectFiles, withScannedRequires } from "../../../src/plugins/tools/runtime/projectArchive.ts";
import { parseToolPackage, toolPackageLimit } from "../../../src/plugins/tools/runtime/package.ts";
import { resolveToolSettings, toolSettingsScript, validateToolSettings } from "../../../src/plugins/tools/runtime/settings.ts";
import { sampleTool } from "../../../src/plugins/tools/ui/sample.ts";

it("exports editable project sources and roundtrips authoring files, actions and setting declarations", () => {
  const tool = { ...sampleTool, sourceFiles: { "src/notes.md": "我的开发记录" } };
  const bytes = exportToolProject(tool);
  expect([...bytes.slice(0, 4)]).toEqual([80, 75, 3, 4]);
  const files = unzipSync(bytes);
  // 导出的源码包不要求 Node：没有 package.json / scripts/build.mjs，改完在工具中心点「导入工具」选它。
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["manifest.json", "index.html", "README.md", "src/notes.md"]));
  expect(Object.keys(files)).not.toContain("package.json");
  const imported = importToolProject(bytes);
  expect(imported.html).toBe(sampleTool.html);
  expect(imported.settingsSchema).toEqual(sampleTool.settingsSchema);
  expect(imported.actions).toEqual(sampleTool.actions);
  expect(imported.sourceFiles?.["src/notes.md"]).toBe("我的开发记录");
  expect(JSON.parse(new TextDecoder().decode(files["manifest.json"]))).not.toHaveProperty("html");
});

it("accepts a single outer project folder and edited HTML", () => {
  const files = unzipSync(exportToolProject(sampleTool));
  files["index.html"] = strToU8("<h1>edited</h1>");
  const wrapped = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [`project/${path}`, bytes]));
  expect(importToolProject(zipSync(wrapped)).html).toBe("<h1>edited</h1>");
});

it.each(["", "project/"])("依赖清单不影响源码包往返，外层目录为 %s", (prefix) => {
  const dependency = strToU8('{"name":"dependency metadata"}');
  const path = "node_modules/demo/manifest.json";
  const files = unzipSync(exportToolProject(sampleTool, { [path]: dependency }));
  const wrapped = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`${prefix}${name}`, bytes]));
  const archive = importToolArchive(zipSync(wrapped));
  expect(archive.tool.id).toBe(sampleTool.id);
  expect(archive.tool.html).toBe(sampleTool.html);
  expect(archive.files[path]).toEqual(dependency);
  expect(archive.tool.sourceFiles).not.toHaveProperty(path);
  expect(importToolArchive(exportToolProject(archive.tool, archive.files)).files[path]).toEqual(dependency);
});

it("不能把依赖目录中的清单作为工具入口", () => {
  const files = unzipSync(exportToolProject(sampleTool));
  const nested = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [`node_modules/demo/${path}`, bytes]));
  expect(() => importToolArchive(zipSync(nested))).toThrow("唯一的 manifest.json");
});

it("preserves author scaffold files without exporting case-insensitive duplicates", () => {
  const sourceFiles = { "readme.md": "作者说明", "PACKAGE.JSON": '{"private":true}', "Scripts/BUILD.mjs": "// custom build" };
  const tool = parseToolPackage(JSON.stringify({ ...sampleTool, sourceFiles }));
  const archive = exportToolProject(tool);
  const paths = Object.keys(unzipSync(archive));
  expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(paths.length);
  const imported = importToolProject(archive);
  expect(imported.sourceFiles).toEqual(sourceFiles);
  expect(importToolProject(exportToolProject(imported)).sourceFiles).toEqual(imported.sourceFiles);
});

it("rejects traversal, ambiguous archives and invalid setting schemas", () => {
  const files = unzipSync(exportToolProject(sampleTool));
  expect(() => importToolProject(zipSync({ ...files, "../secret": strToU8("x") }))).toThrow("路径");
  expect(() => importToolProject(zipSync({ ...files, "other/manifest.json": files["manifest.json"]! }))).toThrow("唯一");
  // 上限是 32 MB：这里造一个超限的条目，确认它仍然会被拦下来。
  expect(() => importToolProject(zipSync({ ...files, "bomb.bin": new Uint8Array(33 * 1024 * 1024) }))).toThrow("解压后");
  expect(() => parseToolPackage(JSON.stringify({ ...sampleTool, settingsSchema: [{ id: "bad", type: "number", label: "Bad", default: 9, max: 2 }] }))).toThrow();
});

it("validates settings, drops obsolete keys and escapes script boundaries", () => {
  expect(resolveToolSettings(sampleTool, { indent: 4, obsolete: "removed" })).toEqual({ indent: 4 });
  expect(resolveToolSettings(sampleTool, { indent: 99 })).toEqual({ indent: 2 });
  expect(() => validateToolSettings(sampleTool, { indent: -1 })).toThrow("缩进");
  const tool = parseToolPackage(JSON.stringify({ ...sampleTool, settingsSchema: [{ id: "text", type: "text", label: "Text", default: "" }] }));
  const script = toolSettingsScript(tool, { text: "</script><script>bad()</script>" });
  expect(script.match(/<\/script>/g)).toHaveLength(1);
  expect(script).toContain("\\u003c/script>");
});

it("rejects Windows-invalid source filenames in JSON packages and ZIP projects", () => {
  const files = unzipSync(exportToolProject(sampleTool));
  for (const character of ['<', '>', '"', '|', '?', '*']) {
    const path = `src/a${character}b.js`;
    expect(() => parseToolPackage(JSON.stringify({ ...sampleTool, sourceFiles: { [path]: "// source" } }))).toThrow();
    expect(() => importToolProject(zipSync({ ...files, [path]: strToU8("// source") }))).toThrow("路径");
  }
  const path = "src/我的工具 (v1)+测试.js";
  const tool = parseToolPackage(JSON.stringify({ ...sampleTool, sourceFiles: { [path]: "// source" } }));
  expect(importToolProject(exportToolProject(tool)).sourceFiles?.[path]).toBe("// source");
});

it("roundtrips a project with many source files without losing any of them", () => {
  // 配额从 64 抬到 512：工具带 node_modules 之后，手写模块不再只有两三个。
  const sourceFiles = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`src/file-${index}.txt`, `file ${index}`]));
  const tool = parseToolPackage(JSON.stringify({ ...sampleTool, sourceFiles }));
  const restored = importToolProject(exportToolProject(tool));
  // 导出的包会带一份生成出来的 README.md，所以按子集断言——重点是作者文件一个没丢。
  expect(restored.sourceFiles).toMatchObject(sourceFiles);
  expect(restored.html).toBe(tool.html);
});

it("roundtrips a valid package close to the byte limit without losing source", () => {
  const base = { ...sampleTool, html: "", sourceFiles: { "notes.txt": "作者的记录" } };
  const bytes = new TextEncoder().encode(JSON.stringify(base)).length;
  const tool = parseToolPackage(JSON.stringify({ ...base, html: "x".repeat(toolPackageLimit - bytes - 128) }));
  const restored = importToolProject(exportToolProject(tool));
  expect(restored.html).toBe(tool.html);
  expect(restored.sourceFiles).toEqual(tool.sourceFiles);
});

it("does not add an empty sourceFiles field to a package at the byte limit", () => {
  const base = { schemaVersion: 1, id: "at-limit", name: "边界", version: "1.0.0", html: "" };
  const bytes = new TextEncoder().encode(JSON.stringify(base)).length;
  const tool = parseToolPackage(JSON.stringify({ ...base, html: "x".repeat(toolPackageLimit - bytes) }));
  expect(importToolProject(exportToolProject(tool))).toEqual(tool);
});

it("导出时按实际用到的能力补写 requires（设计稿 §5.4）", () => {
  const bare = { schemaVersion: 1, id: "scan", name: "扫描", version: "1.0.0", html: "<p>无能力引用</p>" };
  // 作者漏声明：html 里用了 aawStore 与 aawFiles，导出的 manifest 必须带 requires。
  const tool = parseToolPackage(JSON.stringify({
    ...bare,
    html: "<script>const v = await window.aawStore.get('k'); await window.aawFiles.open();</script>",
  }));
  const manifest = JSON.parse(toolProjectFiles(tool)["manifest.json"]!);
  expect(manifest.requires).toEqual({ contract: 2, capabilities: ["files", "store"] });

  // 作者已声明：只并进扫到的能力名，contract 保持作者写的值（写低一点可能是
  // 刻意兼容旧宿主，补写不能反向收紧）。
  const declared = parseToolPackage(JSON.stringify({
    ...tool, requires: { contract: 1, capabilities: ["bus"] },
  }));
  const merged = JSON.parse(toolProjectFiles(declared)["manifest.json"]!);
  expect(merged.requires).toEqual({ contract: 1, capabilities: ["bus", "files", "store"] });

  // 没扫到任何能力：什么都不写——空 requires 只会把"没用宿主能力的工具"
  // 挡在新契约之外，纯亏不赚。（sampleTool 的 html 里有 aawSettings，
  // 不能拿来当"没用到能力"的样本，这里用一份干净清单。）
  const plain = parseToolPackage(JSON.stringify(bare));
  expect(JSON.parse(toolProjectFiles(plain)["manifest.json"]!)).not.toHaveProperty("requires");
});

it("扫描覆盖 aawStore.scope，且跳过 node_modules 与上行能力", () => {
  expect(scanUsedCapabilities([
    'window.aawStore.scope("shared").set("k", 1)',
    "window.aawClipboard.readText()",
  ])).toEqual(["clipboard", "sharedStore", "store"]);
  // actions 是上行能力，network 是声明式授权：都不进 requires。
  expect(scanUsedCapabilities(["window.aawActions.run()", 'fetch("https://x")'])).toEqual([]);
  expect(scanUsedCapabilities([])).toEqual([]);
});

it("导出时会扫目录里的 app.js 构建产物，但跳过 node_modules", () => {
  const tool = parseToolPackage(JSON.stringify({ ...sampleTool, html: "<p>无能力引用</p>" }));
  const bytes = exportToolProject(tool, {
    "app.js": new TextEncoder().encode("import{a}from'x';window.aawSecrets.get('k')"),
    "node_modules/pkg/index.js": new TextEncoder().encode("window.aawLifecycle.notify()"),
    "logo.bin": new Uint8Array([0, 1, 2]),
  });
  const manifest = JSON.parse(new TextDecoder().decode(unzipSync(bytes)["manifest.json"]!));
  // app.js 里的 secrets 被扫到；node_modules 里的 lifecycle 不算数（依赖不是作者写的）。
  expect(manifest.requires).toEqual({ contract: 2, capabilities: ["secrets"] });
});

it("withScannedRequires 不改写没扫到能力的包（引用相等）", () => {
  const tool = parseToolPackage(JSON.stringify(sampleTool));
  expect(withScannedRequires(tool, ["完全无关的文本"])).toBe(tool);
});
