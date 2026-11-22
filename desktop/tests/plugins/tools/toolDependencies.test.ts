/**
 * 工具带依赖（`node_modules` / 二进制资源 / L2 构建产物 / L3 运行时）的落盘与校验。
 *
 * 这一组测试守的是"复杂工具能不能装进来"那条链路：
 * ZIP 解压 → 二进制不丢 → 写进工具目录 → 目录读回清单 → 运行时拿得到。
 */
import { it, expect } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  exportToolProject, importToolArchive, toolArchiveLimit,
} from "../../../src/plugins/tools/runtime/projectArchive.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import {
  prepareToolDir, readToolDirFiles, readToolProject, writeToolFiles, type ToolProjectIO,
} from "../../../src/plugins/tools/runtime/project.ts";
import { sampleTool } from "../../../src/plugins/tools/ui/sample.ts";

/** 能记二进制的假宿主：`files` 存 base64，`text` 存明文，便于分辨走了哪条通道。 */
function fakeIO(seed: Readonly<Record<string, string>> = {}): ToolProjectIO & {
  readonly text: Map<string, string>;
  readonly binary: Map<string, string>;
  readonly dirs: Set<string>;
} {
  const text = new Map(Object.entries(seed));
  const binary = new Map<string, string>();
  const dirs = new Set<string>();
  const parentOf = (path: string) => path.replace(/[\\/][^\\/]+$/, "");
  const known = () => [...text.keys(), ...binary.keys(), ...dirs];
  const toBase64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  return {
    text, binary, dirs,
    // 模拟新契约：tools 分区由 Rust 按当前账号（me）解析好。
    userDataDir: (namespace, directory) =>
      Promise.resolve(namespace === "tools" ? `${namespace}/${directory}/me` : `${namespace}/${directory}`),
    // 目录是否存在也从文件路径反推：真宿主里 `mkdir -p` 已经建过，这里不能只认显式登记。
    pathExists: (path) => Promise.resolve(
      known().some((file) => file === path || file.startsWith(`${path}/`)),
    ),
    listDirNames: () => Promise.resolve([]),
    readTextFile: (path) => {
      const found = text.get(path);
      return found === undefined ? Promise.reject(new Error(`文件不存在：${path}`)) : Promise.resolve(found);
    },
    writeTextFile: (path, contents) => {
      text.set(path, contents);
      for (let dir = parentOf(path); dir && !dirs.has(dir); dir = parentOf(dir)) dirs.add(dir);
      return Promise.resolve();
    },
    writeBinaryFile: (path, base64) => {
      binary.set(path, base64);
      for (let dir = parentOf(path); dir && !dirs.has(dir); dir = parentOf(dir)) dirs.add(dir);
      return Promise.resolve();
    },
    readBinaryFile: (path) => {
      const found = binary.get(path);
      if (found !== undefined) return Promise.resolve(found);
      const asText = text.get(path);
      if (asText === undefined) return Promise.reject(new Error(`文件不存在：${path}`));
      return Promise.resolve(toBase64(asText));
    },
    listFiles: (root) => Promise.resolve([
      ...[...text.keys()], ...[...binary.keys()],
    ].filter((path) => path.startsWith(`${root}/`)).map((path) => path.slice(root.length + 1))),
    movePath: () => Promise.reject(new Error("这组测试不涉及改名")),
  };
}

const archiveOf = (files: Record<string, Uint8Array>) => zipSync(files);

it("keeps binary dependency files and the declared build when importing a ZIP", () => {
  const binaryBytes = new Uint8Array([0, 159, 146, 150, 255, 1, 2]);
  const archive = archiveOf({
    "manifest.json": strToU8(JSON.stringify({
      ...sampleTool,
      html: undefined,
      build: { entry: "src/main.js", out: "app.js", command: "npm run bundle" },
    })),
    "index.html": strToU8(sampleTool.html),
    "app.js": strToU8("export const bundled = true;"),
    "src/main.js": strToU8('import xlsx from "exceljs";\nexport default xlsx;\n'),
    "node_modules/exceljs/package.json": strToU8('{"name":"exceljs","version":"4.4.0"}'),
    "node_modules/exceljs/lib/native.node": binaryBytes,
  });
  const { tool, files } = importToolArchive(archive);
  expect(tool.build?.out).toBe("app.js");
  // 作者自己的文本进清单（AI 与导出都要能读到），二进制只留在 files 里等落盘。
  expect(tool.sourceFiles?.["src/main.js"]).toContain('from "exceljs"');
  // 依赖里的文本也是文本，但它**不进清单**：清单限 512 文件 / 4 MB，一棵正常
  // 依赖树就撑爆；而且它属于依赖，不属于作者源码。它仍然在 files 里，会落盘。
  expect(tool.sourceFiles?.["node_modules/exceljs/package.json"]).toBeUndefined();
  expect(tool.sourceFiles?.["node_modules/exceljs/lib/native.node"]).toBeUndefined();
  expect(files["node_modules/exceljs/package.json"]).toBeDefined();
  expect([...(files["node_modules/exceljs/lib/native.node"] ?? [])]).toEqual([...binaryBytes]);
  expect(files["index.html"]).toBeDefined();
  expect(files["manifest.json"]).toBeDefined();
});

it("imports a dependency tree far past the sourceFiles cap", () => {
  // 600 个文本文件全在 node_modules 下：以前它们会被当成 sourceFiles 灌进清单，
  // 撞上"最多 512 个文件"直接**导入失败**，而报错指向 sourceFiles，作者只会以为
  // 是自己的清单写错了。依赖只走 files 之后，这条路上限由 ZIP 自己那份管
  // （32 MB / 4000 条目），与清单无关。
  const archive: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify({ ...sampleTool, html: undefined, build: { out: "app.js" } })),
    "index.html": strToU8(sampleTool.html),
    "app.js": strToU8("export const bundled = true;"),
    "src/main.js": strToU8('require("dep");'),
  };
  for (let index = 0; index < 600; index += 1)
    archive[`node_modules/dep/lib/f${index}.js`] = strToU8(`module.exports = ${index};`);
  const { tool, files } = importToolArchive(archiveOf(archive));
  // 构建产物也不进清单（它可能几 MB，而清单要塞进 preferences），只落盘。
  expect(tool.sourceFiles && Object.keys(tool.sourceFiles).sort()).toEqual(["src/main.js"]);
  expect(Object.keys(files).filter((path) => path.startsWith("node_modules/"))).toHaveLength(600);
});

it("writes text through the text channel and binaries through the binary one", async () => {
  const io = fakeIO();
  const binaryBytes = new Uint8Array([0, 159, 146, 150]);
  await writeToolFiles(io, "tools/projects/me/demo", {
    "index.html": strToU8("<h1>hi</h1>"),
    "node_modules/x/index.js": strToU8("module.exports = 1;"),
    "node_modules/x/blob.node": binaryBytes,
  });
  expect(io.text.get("tools/projects/me/demo/index.html")).toBe("<h1>hi</h1>");
  expect(io.text.get("tools/projects/me/demo/node_modules/x/index.js")).toBe("module.exports = 1;");
  expect(io.binary.has("tools/projects/me/demo/node_modules/x/blob.node")).toBe(true);
});

it("refuses unsafe paths instead of writing outside the tool directory", async () => {
  const io = fakeIO();
  await expect(writeToolFiles(io, "tools/projects/me/demo", { "../escape.js": strToU8("x") }))
    .rejects.toThrow("不安全");
});

it("will not overwrite a directory that belongs to a different tool id", async () => {
  const manifestOf = (id: string) => JSON.stringify({ schemaVersion: 1, id, name: id, version: "1.0.0" });
  const foreign = fakeIO({ "tools/projects/me/demo/manifest.json": manifestOf("someone-else") });
  await expect(prepareToolDir(foreign, { id: "demo", owner: "me" })).rejects.toThrow("不一致");

  // 目录在、但没有可读清单：同样不覆盖——那可能是别人的半成品。
  const blank = fakeIO({ "tools/projects/me/demo/notes.txt": "别删我" });
  await expect(prepareToolDir(blank, { id: "demo", owner: "me" })).rejects.toThrow("manifest.json");

  // 同一个 id 才允许原地覆盖（就是"重新导入更新"）。
  const same = fakeIO({ "tools/projects/me/demo/manifest.json": manifestOf("demo") });
  await expect(prepareToolDir(same, { id: "demo", owner: "me" })).resolves.toBe("tools/projects/me/demo");

  // 全新安装：目录还不存在，直接给出落点。
  const fresh = fakeIO();
  await expect(prepareToolDir(fresh, { id: "brand-new", owner: "me" })).resolves.toBe("tools/projects/me/brand-new");
});

it("roundtrips a tool directory including its dependency tree on export", async () => {
  const io = fakeIO();
  const dir = "tools/projects/me/demo";
  await writeToolFiles(io, dir, {
    "manifest.json": strToU8(JSON.stringify({ ...sampleTool, html: undefined, build: { out: "app.js" } })),
    "index.html": strToU8(sampleTool.html),
    "app.js": strToU8("export const bundled = true;"),
    "src/main.js": strToU8("export const source = true;"),
    "node_modules/x/blob.node": new Uint8Array([0, 1, 2, 3]),
  });
  const read = await readToolProject(io, dir);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  const { files, skipped } = await readToolDirFiles(io, dir);
  expect(skipped).toEqual([]);
  const archive = exportToolProject(read.tool, files);
  expect([...archive.slice(0, 4)]).toEqual([80, 75, 3, 4]);
  const paths = Object.keys(unzipSync(archive));
  expect(paths).toEqual(expect.arrayContaining([
    "manifest.json", "index.html", "app.js", "src/main.js", "node_modules/x/blob.node",
  ]));
  // 再导一次必须还能读回来——否则"发出去就废"。
  expect(importToolArchive(archive).tool.build?.out).toBe("app.js");
});

it("caps a single archive so a runaway dependency tree cannot be shipped", () => {
  const archive = archiveOf({
    "manifest.json": strToU8(JSON.stringify({ ...sampleTool, html: undefined })),
    "index.html": strToU8(sampleTool.html),
    "huge.bin": new Uint8Array(toolArchiveLimit + 1),
  });
  expect(() => importToolArchive(archive)).toThrow("解压后");
});

it("validates the build and runtime declarations", () => {
  // L2：只认 out；entry / command 是作者元数据，不检查对应文件。
  const l2 = parseToolPackage(JSON.stringify({
    ...sampleTool,
    build: { entry: "src/main.js", out: "app.js", command: "npm run bundle" },
  }));
  expect(l2.build).toEqual({ entry: "src/main.js", out: "app.js", command: "npm run bundle" });
  for (const bad of [undefined, "", "..", "../outside.js", "index.html", "manifest.json", "a\\b.js"])
    expect(() => parseToolPackage(JSON.stringify({ ...sampleTool, build: { out: bad } }))).toThrow();

  // L3：entry 必须在 bin/ 内，protocol 必须是宿主支持的那一代。
  const l3 = parseToolPackage(JSON.stringify({
    ...sampleTool,
    runtime: { kind: "process", entry: "bin/run.exe" },
  }));
  expect(l3.runtime).toEqual({ kind: "process", entry: "bin/run.exe", protocol: 1 });
  for (const bad of ["run.exe", "../bin/run.exe", "/bin/run.exe", "src/run.exe"])
    expect(() => parseToolPackage(JSON.stringify({ ...sampleTool, runtime: { kind: "process", entry: bad } }))).toThrow();
  expect(() => parseToolPackage(JSON.stringify({
    ...sampleTool,
    runtime: { kind: "process", entry: "bin/run.exe", protocol: 99 },
  }))).toThrow("protocol");

  // 两条替代路径互斥：同时声明不会更强，只会让"它到底跑在哪"变成猜谜。
  expect(() => parseToolPackage(JSON.stringify({
    ...sampleTool,
    build: { out: "app.js" },
    runtime: { kind: "process", entry: "bin/run.exe" },
  }))).toThrow("不能同时声明");
});

it("rejects preload with a hint that names both replacements", () => {
  // 第 2 代契约删掉了 preload。这条不再"宽容解析"，而是明确拦下并写清改法——
  // 老包如果静默装进去，用户面对的会是一个白窗口，比装不上糟得多。
  expect(() => parseToolPackage(JSON.stringify({ ...sampleTool, preload: "bridge/main.js" })))
    .toThrow(/第 2 代/);
});

it("keeps bin/ out of sourceFiles but still lands it on disk", () => {
  const archive = archiveOf({
    "manifest.json": strToU8(JSON.stringify({
      ...sampleTool,
      html: "",
      runtime: { kind: "process", entry: "bin/run.exe" },
    })),
    "index.html": strToU8(""),
    "bin/run.exe": new Uint8Array([77, 90, 0, 1]),
    "bin/lib/runtime.dll": new Uint8Array([77, 90, 0, 2]),
  });
  const { tool, files, binBytes } = importToolArchive(archive);
  expect(tool.sourceFiles).toBeUndefined();
  expect(files["bin/run.exe"]).toBeDefined();
  // 体积单列：导入界面要能把"这个包实际占多大"说清楚。
  expect(binBytes).toBe(8);
});

it("treats bin/ inside sourceFiles as invalid", () => {
  expect(() => parseToolPackage(JSON.stringify({
    ...sampleTool,
    sourceFiles: { "bin/run.exe": "not really" },
  }))).toThrow(/sourceFiles/);
});
