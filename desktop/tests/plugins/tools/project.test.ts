import { expect, it } from "vitest";
import {
  checkToolProject, createToolProject, listToolProjects, migrateLegacyTools,
  listToolProjectSummaries, readToolProject, renameToolProject, runtimeFiles, toolFromProject,
  toolOwnerSegment, toolProjectIdFromBrief, type ToolProjectIO,
} from "../../../src/plugins/tools/runtime/project.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import { sampleTool } from "../../../src/plugins/tools/ui/sample.ts";

/** 内存版宿主：把路径当字符串、文件当 Map，用来验证落盘逻辑本身。 */
function memoryIO(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const io: ToolProjectIO = {
    userDataDir: (namespace, directory) => Promise.resolve(`/data/${namespace}/${directory}`),
    pathExists: (path) => Promise.resolve(
      files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
    ),
    listDirNames: (path) => Promise.resolve([...new Set([...files.keys()]
      .filter((key) => key.startsWith(`${path}/`))
      .map((key) => key.slice(path.length + 1).split("/")[0]!)
      .filter((name) => name.includes("/") === false))]),
    readTextFile: (path) => {
      const value = files.get(path);
      return value === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(value);
    },
    writeTextFile: (path, contents) => { files.set(path, contents); return Promise.resolve(); },
    movePath: (from, to) => {
      const moved = [...files.keys()].filter((key) => key === from || key.startsWith(`${from}/`));
      if (!moved.length) return Promise.reject(new Error(`ENOENT ${from}`));
      for (const key of moved) {
        const value = files.get(key)!;
        files.delete(key);
        files.set(`${to}${key.slice(from.length)}`, value);
      }
      return Promise.resolve();
    },
  };
  return { io, files };
}

const page = `<h1>演示</h1><button id="go">运行</button>
<script>window.aawActions={run:async()=>({ok:true})}</script>`;

it("creates a project whose guide and manifest are already on disk", async () => {
  const { io, files } = memoryIO();
  const created = await createToolProject(io, { id: "demo", name: "演示", owner: "u1" });
  expect(created.dir).toBe("/data/tools/projects/u1/demo");
  expect(files.get("/data/tools/projects/u1/demo/AGENTS.md")).toContain("R1");
  expect(JSON.parse(files.get("/data/tools/projects/u1/demo/manifest.json")!)).toMatchObject({ id: "demo", version: "0.1.0" });
  // html 留空 = 还没写完，此时不允许安装。
  const check = await checkToolProject(io, created.dir);
  expect(check.ready).toBe(false);
  expect(check.blocking[0]!.where).toBe("html");
});

it("treats index.html as the entry point and becomes installable once it is complete", async () => {
  const { io } = memoryIO();
  const { dir } = await createToolProject(io, { id: "demo", name: "演示", owner: "u1" });
  await io.writeTextFile(`${dir}/index.html`, page);
  const read = await readToolProject(io, dir);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.tool.html).toBe(page);
  // 骨架没声明 actions，但有 aawActions 实现 → 只是"建议"，不该拦住安装。
  const check = await checkToolProject(io, dir);
  expect(check.ready).toBe(true);
  expect(check.warnings.map((problem) => problem.ruleId)).toContain("R3");
});

it("blocks installation when a declared action has no implementation", async () => {
  const { io } = memoryIO();
  const { dir } = await createToolProject(io, { id: "demo", name: "演示", owner: "u1" });
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
    actions: [{ id: "run", description: "跑", inputSchema: { type: "object", properties: {} } }],
  }));
  await io.writeTextFile(`${dir}/index.html`, "<p>没有实现</p>");
  const check = await checkToolProject(io, dir);
  expect(check.ready).toBe(false);
  expect(check.blocking.map((problem) => problem.ruleId)).toContain("R3");
});

it("explains a missing manifest instead of throwing", async () => {
  const { io } = memoryIO();
  const read = await readToolProject(io, "/data/tools/projects/none");
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.violations[0]!.message).toContain("manifest.json");
  expect(read.violations[0]!.hint).toContain("新建");
});

it("migrates legacy tools once and never overwrites an existing project", async () => {
  const { io, files } = memoryIO();
  const tool = parseToolPackage(JSON.stringify({
    schemaVersion: 1, id: "legacy", name: "旧工具", version: "1.0.0", html: page,
  }));
  const first = await migrateLegacyTools(io, [tool], { owner: "u1" });
  expect(first.created).toEqual(["/data/tools/projects/u1/legacy"]);
  expect(files.get("/data/tools/projects/u1/legacy/index.html")).toBe(page);
  // 第二轮：目录已在，必须跳过，不能把用户后来的改动盖掉。
  files.set("/data/tools/projects/u1/legacy/index.html", "<p>改过</p>");
  const second = await migrateLegacyTools(io, [tool], { owner: "u1" });
  expect(second.created).toEqual([]);
  expect(second.skipped).toEqual(["/data/tools/projects/u1/legacy"]);
  expect(files.get("/data/tools/projects/u1/legacy/index.html")).toBe("<p>改过</p>");
});

it("lists projects and reads one back through the same contract as installing", async () => {
  const { io } = memoryIO();
  const { dir } = await createToolProject(io, { id: "one", name: "一", owner: "u1" });
  await io.writeTextFile(`${dir}/index.html`, page);
  expect(await listToolProjects(io, { owner: "u1" })).toEqual(["/data/tools/projects/u1/one"]);
  const result = await toolFromProject(io, dir);
  expect(result.ok).toBe(true);
});

it("gives every account its own projects root", async () => {
  const { io, files } = memoryIO();
  const mine = await createToolProject(io, { id: "word-count", name: "字数", owner: "u1" });
  const theirs = await createToolProject(io, { id: "word-count", name: "字数", owner: "u2" });
  // 同一个 id 在两个人名下互不干扰——这正是"目录按账号"要买的东西。
  expect(mine.dir).toBe("/data/tools/projects/u1/word-count");
  expect(theirs.dir).toBe("/data/tools/projects/u2/word-count");
  expect(await listToolProjects(io, { owner: "u1" })).toEqual([mine.dir]);
  expect(await listToolProjects(io, { owner: "u2" })).toEqual([theirs.dir]);
  expect(files.has("/data/tools/projects/u1/word-count/index.html")).toBe(true);
});

it("never overwrites a same-named project, it takes the next free name", async () => {
  const { io, files } = memoryIO();
  const first = await createToolProject(io, { id: "demo", name: "演示", owner: "u1" });
  await io.writeTextFile(`${first.dir}/index.html`, page);
  const second = await createToolProject(io, { id: "demo", name: "演示", owner: "u1" });
  expect(second.id).toBe("demo-2");
  expect(second.dir).toBe("/data/tools/projects/u1/demo-2");
  // 第一份必须原样留着：以前这里会被清空，等于吃掉用户做好的东西。
  expect(files.get(`${first.dir}/index.html`)).toBe(page);
});

it("turns an account id into a safe directory segment", () => {
  expect(toolOwnerSegment("12345")).toBe("12345");
  expect(toolOwnerSegment("zhang.san@corp")).toBe("zhang.san_corp");
  expect(toolOwnerSegment("a/b:c")).toBe("a_b_c");
});

/**
 * 读不到账号时宁可报错，也不能退回 `anonymous`。
 *
 * 这个兜底害过两次：旧工具迁移把源码落进 `projects/anonymous/`，用户在
 * 「开发工具」里一个都看不见；`aawStore` 把数据落进 `storage/anonymous/`，
 * 登录后读 `<账号>/` 全是空的，看起来像数据凭空消失。两次都是"能写进去"
 * 掩盖了"读不回来"。
 */
it("refuses to invent an anonymous owner instead of silently misplacing data", () => {
  for (const bad of [undefined, "", "   ", "..", "..."]) {
    expect(() => toolOwnerSegment(bad), `owner=${JSON.stringify(bad)}`).toThrow(/账号|目录名/);
  }
});

it("derives a usable id from a Chinese wish", () => {
  expect(toolProjectIdFromBrief("Text Tool")).toBe("text-tool");
  // 中文抽不出可读 ascii 时退回 tool，由 freeProjectDir 依次给出 tool、tool-2…
  expect(toolProjectIdFromBrief("我想要一个字数统计")).toBe("tool");
});

it("summarises projects from manifest without loading the whole page", async () => {
  const { io } = memoryIO();
  const { dir } = await createToolProject(io, { id: "demo", name: "演示", owner: "u1" });
  await io.writeTextFile(`${dir}/index.html`, page);
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.2.0", html: "", permissions: { network: true },
  }));
  // 一个 manifest 坏掉的目录：列表要能指出来，而不是让用户点进去才发现。
  await createToolProject(io, { id: "broken", name: "坏的", owner: "u1" });
  await io.writeTextFile("/data/tools/projects/u1/broken/manifest.json", "{ 不是 JSON");

  const summaries = await listToolProjectSummaries(io, { owner: "u1" });
  expect(summaries.find((entry) => entry.dirName === "demo")).toMatchObject({
    id: "demo", name: "演示", version: "1.2.0", hasHtml: true, network: true,
  });
  expect(summaries.find((entry) => entry.dirName === "broken")?.broken).toBeTruthy();
});

it("renames a project in place, and moves the directory when the id changes", async () => {
  const { io, files } = memoryIO();
  const created = await createToolProject(io, { id: "demo", name: "演示", owner: "u1" });
  await io.writeTextFile(`${created.dir}/index.html`, page);

  // 只改显示名：目录不动，页面不动，只有清单和 AGENTS.md 跟着改名。
  const renamed = await renameToolProject(io, { dir: created.dir, name: "接口 JSON 转表格" });
  expect(renamed).toMatchObject({ id: "demo", name: "接口 JSON 转表格", moved: false, previousId: "demo" });
  expect(files.get(`${created.dir}/index.html`)).toBe(page);
  expect(files.get(`${created.dir}/AGENTS.md`)).toContain("接口 JSON 转表格");

  // 改 id：目录跟着搬，旧目录必须消失——"复制一份再留个旧目录"会变成两个项目。
  const moved = await renameToolProject(io, { dir: renamed.dir, id: "json-table" });
  expect(moved).toMatchObject({ id: "json-table", moved: true });
  expect(moved.dir).toBe("/data/tools/projects/u1/json-table");
  expect(files.has("/data/tools/projects/u1/demo/manifest.json")).toBe(false);
  expect(JSON.parse(files.get(`${moved.dir}/manifest.json`)!)).toMatchObject({ id: "json-table", name: "接口 JSON 转表格" });
  expect(files.get(`${moved.dir}/index.html`)).toBe(page);
});

it("refuses a rename that would collide, and explains why", async () => {
  const { io } = memoryIO();
  const first = await createToolProject(io, { id: "one", name: "一", owner: "u1" });
  await createToolProject(io, { id: "two", name: "二", owner: "u1" });
  await expect(renameToolProject(io, { dir: first.dir, id: "two" })).rejects.toThrow("已经有 two");
  await expect(renameToolProject(io, { dir: first.dir, id: "Bad Name" })).rejects.toThrow("目录名");
  await expect(renameToolProject(io, { dir: first.dir, name: "  " })).rejects.toThrow("名字不能为空");
});

it("runtimeFiles 只含 manifest.json 与 index.html，字段与包严格一致", () => {
  const files = runtimeFiles(sampleTool);
  expect(Object.keys(files).sort()).toEqual(["index.html", "manifest.json"]);
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]!));
  expect(manifest).toMatchObject({ schemaVersion: sampleTool.schemaVersion, id: sampleTool.id, name: sampleTool.name, version: sampleTool.version });
  // html 是运行时文件，不属于清单：混进去会污染校验与导出。
  expect("html" in manifest).toBe(false);
  expect(new TextDecoder().decode(files["index.html"]!)).toBe(sampleTool.html);
});
