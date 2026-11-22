import { expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { createStore } from "zustand";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import type { HostService } from "../../../src/plugins/host/service.ts";
import type { ToolPurgeReport } from "../../../src/plugins/host/types.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";
import { hostToolIO, memoryToolIO } from "../../../src/plugins/tools/runtime/io.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import { readToolDirFiles, runtimeFiles } from "../../../src/plugins/tools/runtime/project.ts";
import type { ToolsService } from "../../../src/plugins/tools/service.ts";
import type { PersonalTool } from "../../../src/plugins/tools/types.ts";
import { createWorkshop, syncToolGuide } from "../../../src/plugins/tools/ui/workshop.ts";

/**
 * 工坊的"人接手"路径：AI 回灌 3 轮还修不好时，必须把选择权交回用户——
 * 状态里留着项目路径（UI 用它渲染可复制的文本）和"重新校验"入口。
 * 只写一句"或直接改文件"等于把死路当结论（见 docs 22 §4 P0-2）。
 */
function harness(options: { native?: boolean; settings?: { read: () => string | undefined; write: (value: string | undefined) => void }; toolsService?: ToolsService; owner?: () => string | undefined } = {}) {
  const io = memoryToolIO();
  const dir = "/data/tools/projects/u1/demo";
  const openInFileManager = vi.fn().mockResolvedValue(undefined);
  // 二进制端口的最小实现：导入/导出文件夹时 listToolFiles / readBinaryFile 会用到。
  const binaries = new Map<string, string>();
  /** 列得出来但读不出来的文件：模拟"超过单包上限 / 被占用"。 */
  const unreadable = new Set<string>();
  const readBinaryFile = (path: string) => {
    if (unreadable.has(path)) return Promise.reject(new Error("这个文件读不出来"));
    // 二进制端口存的就是 base64 原文：不能再编码一次，否则读回来的是它的 base64。
    const saved = binaries.get(path);
    if (saved !== undefined) return Promise.resolve(saved);
    const raw = io.files.get(path);
    if (raw === undefined) return Promise.reject(new Error(`文件不存在：${path}`));
    // 文本要走 UTF-8 字节再转 base64：btoa 遇到中文直接抛（真实宿主读的是原始字节，无此问题）。
    const bytes = new TextEncoder().encode(raw);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return Promise.resolve(btoa(binary));
  };
  // 返回类型必须显式写上：否则 `[]` 会被推成 `never[]`，单个用例里
  // `mockResolvedValue({ removedDirs: ["/x"] })` 就报 TS2322。
  const toolPurge = vi.fn((): Promise<ToolPurgeReport> => Promise.resolve({ removedDirs: [], skippedDirs: [], failedDirs: [], removedData: false, removedBackup: false, removedSecrets: false }));
  const host = {
    isNative: () => options.native ?? true,
    skills: {
      // 卸载清理要走宿主端口：返回一份“什么都没删”的报告就够断言传给它的目录。
      toolPurge,
      // 模拟新契约：tools 分区由 Rust 按当前账号（u1）解析好。
      userDataDir: (namespace: string, directory: string) =>
        io.userDataDir(namespace, namespace === "tools" ? `${directory}/u1` : directory),
      pathExists: (path: string) => io.pathExists(path),
      listDirNames: (path: string) => io.listDirNames(path),
      writeTextFile: (path: string, contents: string) => io.writeTextFile(path, contents),
      listToolFiles: (root: string) =>
        Promise.resolve([...io.files.keys(), ...binaries.keys()]
          .filter((path) => path.startsWith(`${root}/`))
          .map((path) => path.slice(root.length + 1))),
      readBinaryFile,
      writeBinaryFile: (path: string, base64: string) => {
        binaries.set(path, base64);
        return Promise.resolve();
      },
      // 版本目录就位靠宿主 movePath：内存里文本与二进制两套都要跟着搬，
      // 否则「装完的副本」看起来缺文件（真实宿主只有一棵树，不存在这个问题）。
      moveToolPath: (from: string, to: string) => {
        for (const [path, value] of [...binaries]) {
          if (path !== from && !path.startsWith(`${from}/`)) continue;
          binaries.delete(path);
          binaries.set(`${to}${path.slice(from.length)}`, value);
        }
        return io.movePath(from, to);
      },
      dropToolStaging: (path: string) => {
        for (const key of [...binaries.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) binaries.delete(key);
        }
        return io.dropStaging ? io.dropStaging(path) : Promise.resolve();
      },
    },
    archives: { readTextFile: (path: string) => io.readTextFile(path) },
    files: { openInFileManager },
  } as unknown as HostService;

  const setRunDir = vi.fn();
  const setSourceDir = vi.fn();
  const toolStore = createStore<readonly PersonalTool[]>(() => []);
  /** 真正写进安装记录的那些包：断言"什么都没装"比断言 mock 被调用更直接。 */
  const installs: unknown[] = [];
  /** 真正被撤掉的记录 id（卸载成功才会往里写）。 */
  const removes: string[] = [];
  const tools = {
    state: toolStore,
    // 返回真实的 InstallOutcome：installArchive 之后 describeInstall 要读它。
    install: vi.fn((tool: { version: string }) => {
      installs.push(tool);
      return { version: tool.version, updated: false, versionChanged: false };
    }),
    rollback: vi.fn(),
    setRunDir,
    setSourceDir,
    open: vi.fn(),
    // 真正被撤掉的记录 id：断言"记录还在"比断言 mock 没被调用更直接
    // （且不必引用 mock 方法，避开 unbound-method 规则）。
    remove: vi.fn((id: string) => { removes.push(id); }),
    saveSettings: vi.fn(),
  } as unknown as ToolsService;
  const service = options.toolsService ?? tools;

  // 会话是否在跑由测试推：工坊订阅的是"true → false"这个沿。
  const session = createStore<{ isAgentRunning: boolean; activeSessionId: string }>(
    () => ({ isAgentRunning: false, activeSessionId: "s1" }),
  );
  const send = vi.fn();
  const startNewSession = vi.fn();
  const pickDirectory = vi.fn();
  // 前台工作区单独持有：测试要能模拟"用户切到了别的项目"。
  const workspace = createStore<{ activePath: string | null }>(() => ({ activePath: dir }));
  const project = {
    projects: {
      workspace,
      setRecentExclusions: vi.fn(),
      registerProject: vi.fn(),
      pickDirectory,
    },
    sessions: {
      catalog: createStore(() => ({ agentKey: "agent" })),
      startNewSession,
    },
    conversation: { send, foreground: { session } },
  } as unknown as ProjectService;

  const workshop = createWorkshop({ tools: service, project, host, owner: options.owner ?? (() => "u1"), ...(options.settings ? { settings: options.settings } : {}) });
  return { workshop, io, dir, send, openInFileManager, session, setRunDir, setSourceDir, project, startNewSession, pickDirectory, tools: service, fakeTools: tools, toolStore, host, toolPurge, workspace, unreadable, installs, removes };
}

/** 让 AI 停下来：工坊的回调是订阅里发的，不等它跑完就断言会读到旧状态。 */
function stopAgent(session: ReturnType<typeof harness>["session"]) {
  session.setState({ isAgentRunning: true });
  session.setState({ isAgentRunning: false });
}

it("hands over to the user after three repair rounds, with both actions wired", async () => {
  const { workshop, io, dir, send, session } = harness();
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
    actions: [{ id: "run", description: "跑", inputSchema: { type: "object", properties: {} } }],
  }));
  await io.writeTextFile(`${dir}/index.html`, "<p>没有实现</p>");
  await workshop.select(dir);
  expect(workshop.state.getState().check?.ready).toBe(false);

  for (let round = 1; round <= 3; round += 1) {
    stopAgent(session);
    // 回灌是订阅里的异步回调：等它真的发出去，否则下一轮读到的还是旧计数。
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(round));
  }
  expect(workshop.state.getState().stalled).toBe(false);

  // 第四轮：轮数用满，不再打扰 AI，改成把选择权交回用户。
  stopAgent(session);
  await vi.waitFor(() => expect(workshop.state.getState().stalled).toBe(true));
  expect(send).toHaveBeenCalledTimes(3);
  const stalled = workshop.state.getState().note?.text ?? "";
  expect(stalled).toContain("3 轮");
  expect(stalled).not.toContain("直接改文件");

  // 交接时项目路径还在状态里：UI 靠它渲染可复制的路径文本，不需要再打开目录。
  expect(workshop.state.getState().project?.dir).toBe(dir);

  await io.writeTextFile(`${dir}/index.html`, "<p>改好了</p><script>window.aawActions={run:async()=>({ok:true})}</script>");
  await workshop.verify();
  expect(workshop.state.getState().stalled).toBe(false);
  expect(workshop.state.getState().note?.text).toContain("校验通过");
  expect(workshop.state.getState().check?.ready).toBe(true);
});

/**
 * 开发规范是平台默认写给 AI 的，不再需要用户点「同步到 AI 技能目录」：
 * 建工坊时静默写一次，写的是含 R9 通用性红线与五个能力入口的那份正文。
 */
it("silently installs the same guide into the skill directory on startup", async () => {
  const { workshop, io } = harness();
  await vi.waitFor(() => expect(io.files.get("chrys/skills/tool-dev/SKILL.md")).toBeTruthy());
  const skill = io.files.get("chrys/skills/tool-dev/SKILL.md")!;
  expect(skill).toContain("R9");
  expect(skill).toContain("aawClipboard");
  expect(skill).toContain("什么是内核");
  workshop.dispose();
});

it("syncToolGuide writes the guide through the narrow file port", async () => {
  const io = memoryToolIO();
  await syncToolGuide(io);
  expect(io.files.get("chrys/skills/tool-dev/SKILL.md")).toContain("name: tool-dev");
});


/**
 * 从 ZIP 装进来的工具解到 `tools/installed/`，不进 `tools/projects/`。
 *
 * 两个目录的**归属**不同：`projects/` 是用户自己的源码（卸载时不替用户删），
 * `installed/` 是我们解出来的运行副本（卸载时该连 `node_modules` 一起清）。
 * 混在一起的代价以前是看得见的——导入一个 ZIP，那个工具会以"工具项目"的身份
 * 出现在用户从没创建过的项目列表里。
 */
it("extracts an imported archive into installed/, never into the author's projects", async () => {
  const { workshop, io } = harness();
  const manifest = JSON.stringify({ schemaVersion: 1, id: "demo", name: "Demo", version: "1.0.0" });
  const installer = new TextEncoder();
  await workshop.installArchive(
    { schemaVersion: 1, id: "demo", name: "Demo", version: "1.0.0", html: "<p>hi</p>" },
    { "manifest.json": installer.encode(manifest), "index.html": installer.encode("<p>hi</p>") },
  );
  const written = [...io.files.keys()];
  // 只关心工具落盘那部分：建工坊时还会往技能目录静默写一份开发规范。
  const toolFiles = written.filter((path) => path.startsWith("tools/"));
  expect(toolFiles.length).toBeGreaterThan(0);
  expect(toolFiles.filter((path) => path.startsWith("tools/projects/"))).toEqual([]);
  // 落点是 `versions/<版本>/`：一次安装一个独立目录，不再往同一个目录叠盖。
  expect(toolFiles.every((path) => path.startsWith("tools/installed/u1/demo/versions/"))).toBe(true);
  workshop.dispose();
});

/**
 * 契约不够的包要"从头到尾没碰过磁盘"。
 *
 * 以前闸门只在 `tools.install()` 里，而 installArchive 是先把 ZIP 解压、
 * 写进 `installed/<账号>/<id>/` 再调 install。被拒之后注册表没记录，
 * 目录却留着：界面看不见、卸载清不到、白占空间（带 node_modules 时尤其明显）。
 */
it("rejects an incompatible archive before creating any directory", async () => {
  const { workshop, io } = harness();
  const tool = parseToolPackage(JSON.stringify({
    schemaVersion: 1, id: "future", name: "未来版工具", version: "1.0.0",
    html: "<p>hi</p>", requires: { contract: 99 },
  }));
  const encoder = new TextEncoder();
  await expect(workshop.installArchive(tool, {
    "manifest.json": encoder.encode(JSON.stringify({ schemaVersion: 1, id: "future", name: "未来版工具", version: "1.0.0", requires: { contract: 99 } })),
    "index.html": encoder.encode("<p>hi</p>"),
  })).rejects.toThrow(/第 99 代/);
  expect([...io.files.keys()].filter((path) => path.startsWith("tools/installed/"))).toEqual([]);
  workshop.dispose();
});

/**
 * 迁移的落点必须跟项目列表同一个账号层。
 *
 * 以前这一步在面板里直接调 `migrateLegacyTools(io, tools)`，没传 owner，
 * 于是所有旧工具都迁进了 `projects/anonymous/`，而项目列表扫的是
 * `projects/<账号>/`——用户看到"已把 2 个旧工具迁成项目目录"，去「开发工具」
 * 里却一个也没有。这条断言盯的就是那个 anonymous 目录不再出现。
 */
it("migrates legacy tools into the signed-in account, not into anonymous", async () => {
  const { workshop, io, setRunDir, setSourceDir } = harness();
  const tool = parseToolPackage(JSON.stringify({
    schemaVersion: 1, id: "legacy", name: "旧工具", version: "1.0.0", html: "<p>hi</p>",
  }));
  const result = await workshop.migrateLegacy([{ package: tool }]);
  expect(result.created).toEqual(["tools/projects/u1/legacy"]);
  expect(await io.pathExists("tools/projects/u1/legacy/manifest.json")).toBe(true);
  expect(await io.pathExists("tools/projects/anonymous/legacy/manifest.json")).toBe(false);
  // 迁出来的目录只登记成**开发来源**：运行副本还是安装记录里那一份。
  // 以前这里顺手指了运行目录，带二进制附件的工具当场读不到附件。
  expect(setSourceDir).toHaveBeenCalledWith("legacy", "tools/projects/u1/legacy");
  expect(setRunDir).not.toHaveBeenCalled();
  workshop.dispose();
});

/**
 * 自定义根目录：新建/迁移落它，列表两根都扫（去重）。
 *
 * 以前列表只扫默认根目录——用户用「选择目录」把项目建在别处后，重启就再也
 * 找不到它；列表里同名/相似名的旧条目点「继续开发」只会开在默认位置。
 * 这是"会话开错目录"那个 bug 的结构性根源。
 */
it("scans both roots and creates into the custom root", async () => {
  let stored: string | undefined;
  stored = "custom/root";
  const second = harness({ settings: { read: () => stored, write: (value) => { stored = value; } } });
  second.startNewSession.mockResolvedValue({ ok: true });

  // 默认位置里先放一个旧项目。
  await second.io.writeTextFile("tools/projects/u1/other/manifest.json", JSON.stringify({
    schemaVersion: 1, id: "other", name: "别的", version: "1.0.0",
  }));
  await second.io.writeTextFile("tools/projects/u1/other/index.html", "<p>x</p>");

  // 不选目录直接新建：应落在自定义根目录（不套账号段）。
  second.workshop.setBrief("make a thing");
  await second.workshop.create();
  expect(await second.io.pathExists("custom/root/make-a-thing/manifest.json")).toBe(true);

  await second.workshop.refreshProjects();
  const dirs = second.workshop.state.getState().projects.map((entry) => entry.dir);
  expect(dirs).toContain("tools/projects/u1/other");
  expect(dirs).toContain("custom/root/make-a-thing");

  // 恢复默认：设置清空，之后新建回默认位置。
  second.workshop.resetProjectsRoot();
  expect(stored).toBeUndefined();
  expect(second.workshop.state.getState().customRoot).toBeNull();
  second.workshop.dispose();
});

/**
 * 「继续开发」的防呆：目录里已经没有 manifest.json 时绝不开会话。
 *
 * 照着过期列表开会话，得到的是一条落在空目录的对话——用户会以为是自己
 * 改错了地方。宁可当场报错让他刷新列表。
 */
it("refuses to resume when the directory no longer has a manifest", async () => {
  const { workshop, startNewSession } = harness();
  await workshop.resume("/gone/tool");
  expect(startNewSession).not.toHaveBeenCalled();
  expect(workshop.state.getState().note?.error).toBe(true);
  expect(workshop.state.getState().note?.text).toContain("manifest.json");
});

/**
 * 文件夹导入：manifest + index.html + 其余文件一起走 ZIP 同一条安装链路，
 * 落进 installed/（运行副本），不碰用户项目区。
 */
it("imports a tool from a folder through the same archive pipeline", async () => {
  const { workshop, io, pickDirectory, startNewSession } = harness();
  const source = "E:/somewhere/my-tool";
  await io.writeTextFile(`${source}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0",
  }));
  await io.writeTextFile(`${source}/index.html`, "<p>hi</p>");
  await io.writeTextFile(`${source}/assets/data.txt`, "数据");
  pickDirectory.mockResolvedValue(source);

  const note = await workshop.importFromFolder();
  expect(note.error).toBeUndefined();
  // 文件都写进了 installed/ 下的版本副本（含附件），不碰用户项目区。
  expect(startNewSession).not.toHaveBeenCalled();
  expect(await io.pathExists("tools/installed/u1/demo/versions/1.0.0/index.html")).toBe(true);
  expect(await io.pathExists("tools/installed/u1/demo/versions/1.0.0/assets/data.txt")).toBe(true);
  workshop.dispose();
});

it("folder import fails clearly when there is no manifest", async () => {
  const { workshop, pickDirectory } = harness();
  pickDirectory.mockResolvedValue("E:/somewhere/empty");
  const note = await workshop.importFromFolder();
  expect(note.error).toBe(true);
  expect(note.text).toContain("manifest.json");
  workshop.dispose();
});

/**
 * 校验是异步读盘的：读的过程中用户切到了另一个项目，晚到的结果不能
 * 盖掉新项目的结论——否则卡片会拿 A 的"可以验收"去描述 B。
 */
it("ignores a late check result after the user switched projects", async () => {
  const { workshop, io, dir } = harness();
  const other = "/data/tools/projects/u1/other";
  for (const [path, id] of [[dir, "demo"], [other, "other"]] as const) {
    await io.writeTextFile(`${path}/manifest.json`, JSON.stringify({
      schemaVersion: 1, id, name: id, version: "1.0.0", html: "",
    }));
    await io.writeTextFile(`${path}/index.html`, "<p>hi</p>");
  }
  // 让第一个项目的读取慢下来，确保它的结果一定落在第二个之后。
  const read = io.readTextFile.bind(io);
  vi.spyOn(io, "readTextFile").mockImplementation(async (path) => {
    if (path.startsWith(dir)) await new Promise((done) => setTimeout(done, 20));
    return read(path);
  });
  void workshop.select(dir);
  await workshop.select(other);
  await vi.waitFor(() => expect(workshop.state.getState().check?.tool?.id).toBe("other"));
  await new Promise((done) => setTimeout(done, 40));
  expect(workshop.state.getState().project?.dir).toBe(other);
  expect(workshop.state.getState().check?.tool?.id).toBe("other");
});

/**
 * 「有改动」必须比内容，不只是版本号与 html：AI 改了动作/设置却没动这两样时，
 * 用户会看到"已安装"，打开却是旧行为。
 */
it("flags drift when only the manifest changed, not the html or version", async () => {
  const { workshop, io, dir, toolStore } = harness();
  const manifest = {
    schemaVersion: 1 as const, id: "demo", name: "演示", version: "1.0.0", html: "",
    actions: [{ id: "run", description: "跑", inputSchema: { type: "object", properties: {} } }],
  };
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify(manifest));
  await io.writeTextFile(`${dir}/index.html`, "<p>hi</p><script>window.aawActions={run:async()=>({ok:true})}</script>");
  // 装进去的那份只有动作不一样——版本与 html 完全相同。
  toolStore.setState([{
    package: { ...manifest, actions: [{ id: "other", description: "另一个", inputSchema: { type: "object", properties: {} } }] },
  }], true);
  await workshop.select(dir);
  expect(workshop.state.getState().installed).toBe(true);
  expect(workshop.state.getState().drift).toBe(true);
});

/** 切会话不是「AI 停了」：新会话的空闲状态不该触发自动校验与回灌。 */
it("does not mistake switching sessions for the agent stopping", async () => {
  const { workshop, io, dir, session, send } = harness();
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
  }));
  await workshop.select(dir);
  session.setState({ isAgentRunning: true });
  session.setState({ activeSessionId: "s2", isAgentRunning: false });
  await new Promise((done) => setTimeout(done, 10));
  expect(send).not.toHaveBeenCalled();
  expect(workshop.state.getState().note).toBeNull();
});

/** 连点「继续开发」只开一条会话：同步标志位挡住 await 窗口里的第二次点击。 */
it("resumes once even if the button is double-clicked", async () => {
  const { workshop, io, dir, startNewSession } = harness();
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
  }));
  startNewSession.mockResolvedValue({ ok: true });
  await Promise.all([workshop.resume(dir), workshop.resume(dir)]);
  expect(startNewSession).toHaveBeenCalledOnce();
});

/** 自定义根目录下的项目也是这个工具的源码：删除工具时必须一并交给宿主清理。 */
it("purges the project under a custom root too", async () => {
  let stored: string | undefined = "/data/custom";
  const { workshop, io, toolPurge } = harness({
    settings: { read: () => stored, write: (value) => { stored = value; } },
  });
  await io.writeTextFile("/data/custom/demo/manifest.json", JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
  }));
  await io.writeTextFile("/data/custom/demo/index.html", "<p>hi</p>");
  await workshop.purge("demo");
  expect(toolPurge).toHaveBeenCalledWith(expect.objectContaining({ projectDirs: ["/data/custom/demo"] }));
});

/**
 * 收起不是删除：状态清空，但目录一个文件都不能动。
 *
 * 以前「当前项目」只有入口没有出口（select 能设、界面上关不掉），于是它是
 * 一个只进不出的状态——目录被删掉之后卡片还能一直挂着。
 */
it("collapses the tracked project without touching the disk", async () => {
  const { workshop, io, dir } = harness();
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
  }));
  await workshop.select(dir);
  expect(workshop.state.getState().project?.dir).toBe(dir);

  workshop.dismiss();
  expect(workshop.state.getState().project).toBeNull();
  expect(workshop.state.getState().check).toBeNull();
  expect(await io.pathExists(`${dir}/manifest.json`)).toBe(true);
});

/**
 * 目录被外部删掉之后再点「重新校验」：不能只报一句错然后原地不动。
 *
 * 用户实测的僵尸卡片就是这么来的——报错写进 note，project 仍在，
 * 卡片于是永远挂在那里，没有任何出口。
 */
it("drops the project when its directory disappears", async () => {
  const { workshop, io, dir } = harness();
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
  }));
  await io.writeTextFile(`${dir}/index.html`, "<p>hi</p>");
  await workshop.select(dir);

  io.files.delete(`${dir}/manifest.json`);
  io.files.delete(`${dir}/index.html`);
  await workshop.verify();

  const state = workshop.state.getState();
  expect(state.project).toBeNull();
  expect(state.missing).toBe(false);
  expect(state.note?.text).toContain("目录已经不在了");
});

/** AI 写完那一刻目录也没了：同样收敛成"移除 + 说明"，而不是"没修好"。 */
it("does not report a deleted project as unfixed work", async () => {
  const { workshop, io, dir, session } = harness();
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
  }));
  await workshop.select(dir);
  io.files.delete(`${dir}/manifest.json`);

  stopAgent(session);
  await vi.waitFor(() => expect(workshop.state.getState().project).toBeNull());
  expect(workshop.state.getState().stalled).toBe(false);
  expect(workshop.state.getState().note?.text).toContain("目录已经不在了");
});

/**
 * 「正在写」只属于前台会话所在的项目。
 *
 * 以前只看 isAgentRunning：在 A 里等 B 的结果时，A 那张卡片也会显示
 * 「AI 正在写…」，用户以为 AI 在处理 A。
 */
it("reports running only for the project the foreground session is on", async () => {
  const { workshop, io, dir, session, workspace } = harness();
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
  }));
  await workshop.select(dir);
  session.setState({ isAgentRunning: true });
  expect(workshop.state.getState().running).toBe(true);

  // 前台切到别的项目：这个项目不该继续转圈。
  workspace.setState({ activePath: "/data/other" });
  session.setState({ isAgentRunning: false });
  session.setState({ isAgentRunning: true });
  expect(workshop.state.getState().running).toBe(false);
});

/**
 * 切项目时旧结论要跟着走。
 *
 * 「还有 3 个问题没解决」是 A 的结论，切到 B 还贴在顶栏上，用户会以为
 * B 也有 3 个问题——两条状态栏各说一件事，谁都不对。
 */
it("drops the previous project's note when switching projects", async () => {
  const { workshop, io, dir } = harness();
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
    actions: [{ id: "run", description: "跑", inputSchema: { type: "object", properties: {} } }],
  }));
  await io.writeTextFile(`${dir}/index.html`, "<p>没有实现</p>");
  await workshop.select(dir);
  await workshop.verify();
  expect(workshop.state.getState().note).not.toBeNull();

  // 切到一个真实存在的另一个项目：note 属于上一个项目，不该带过来。
  const other = "/data/tools/projects/u1/other";
  await io.writeTextFile(`${other}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "other", name: "另一个", version: "1.0.0", html: "",
  }));
  await workshop.select(other);
  expect(workshop.state.getState().project?.dir).toBe(other);
  expect(workshop.state.getState().note).toBeNull();
});

/**
 * 在「已安装」里卸载之后，开发页不能再显示「已安装到工具中心」。
 *
 * 这时目录一个字节都没变，没有任何一次读盘会触发重算：徽标会骗人，
 * 而且「确认安装」按钮只在未安装时出现——用户会以为自己装不回去了。
 */
it("re-reads the installed badge when the tool leaves the installed list", async () => {
  const { workshop, io, dir, toolStore } = harness();
  const pack = {
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
    actions: [{ id: "run", description: "跑", inputSchema: { type: "object", properties: {} } }],
  };
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify(pack));
  await io.writeTextFile(`${dir}/index.html`, "<script>window.aawActions={run:async()=>({ok:true})}</script>");
  await workshop.select(dir);
  await workshop.install();
  expect(workshop.state.getState().installed).toBe(true);

  // 用户从「已安装」页签卸载：注册表变了，磁盘没变。
  toolStore.setState([], true);
  expect(workshop.state.getState().installed).toBe(false);
});

/**
 * 校验途中切了项目：不能拿新项目的 `missing` 给旧项目判死刑。
 *
 * `readCheck` 已经不再把晚到的结果写进状态，但 `verify` 之后还会读一次
 * 全局的 `missing`——那是刚选中的那个项目的，用它去移除另一个项目，
 * 用户会看到"B 的目录已经不在了"，而 B 明明好好的。
 */
it("does not pour one project's verdict onto another after a switch", async () => {
  const { workshop, io, dir } = harness();
  const other = "/data/tools/projects/u1/other";
  await io.writeTextFile(`${dir}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0", html: "",
  }));
  await io.writeTextFile(`${other}/manifest.json`, JSON.stringify({
    schemaVersion: 1, id: "other", name: "另一个", version: "1.0.0", html: "",
  }));
  await workshop.select(dir);

  // 切到 B（它是好的），然后给 A 点重新校验：A 的目录已经不在了。
  await workshop.select(other);
  await workshop.verify(dir);

  // 结论属于 A 那个已经消失的目录，不能改写 B 的状态，也不能在 B 的提示条上
  // 写「还有 N 个问题」——那是 A 的事。
  expect(workshop.state.getState().project?.dir).toBe(other);
  expect(workshop.state.getState().note).toBeNull();
  expect(workshop.state.getState().missing).toBe(false);
});

/**
 * 建完项目立刻给结论。
 *
 * 不读盘的话展开行停在「读取中…」：合成行会误报「还没有 index.html」，
 * 而三个动作按钮全用 `check` 做 disabled —— 新建出来的项目是一整块死区，
 * 会话没连上时连长按「继续开发」重试都做不到。
 */
it("reads the new project right after creating it", async () => {
  const { workshop, startNewSession } = harness();
  startNewSession.mockResolvedValue({ ok: true });
  workshop.setBrief("把接口返回的 JSON 转成表格");

  await workshop.create();

  const state = workshop.state.getState();
  expect(state.project).not.toBeNull();
  // 脚手架只写清单，页面内容留给 AI：所以这一刻读得出"清单合法、html 还是空的"。
  // 重点是 check 有值——没有它，展开行是一整块灰按钮。
  expect(state.check).not.toBeNull();
  expect(state.check?.blocking.some((problem) => problem.where === "html")).toBe(true);
  expect(state.note?.error).toBeUndefined();
});

/* ─────────────────────────────────────────────── 组合操作回归（2026-11-22 审计）*/

const combo = (version: string, id = "combo") => parseToolPackage(JSON.stringify({
  schemaVersion: 1, id, name: "组合操作", version, html: `<p>runtime-${version}</p>`,
}));

/** 真工具服务 + 工坊：安装记录、版本目录、备份都是真的，只有宿主是内存实现。 */
async function withRealTools(run: (context: Context) => Promise<void>) {
  localStorage.clear();
  let context: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (value) => { context = value; },
  );
  try {
    await runtime.ready;
    if (!context) throw new Error("缺少桌面上下文");
    context.account.loginAsDev({ name: "工坊回归", employeeId: "tools-workshop-regression" });
    await run(context);
  } finally {
    await runtime.shutdown();
  }
}

/**
 * OBS-03：更新中途失败，已经生效的那一版必须一个字节都不动。
 *
 * 以前安装是往生效目录里直接覆盖写、写完才校验：写到一半失败，清单还是 v1，
 * 页面已经变成 v2。现在写的是暂存目录，失败只清它自己。
 */
it("a failed update leaves the live version and its page untouched", async () => {
  await withRealTools(async ({ tools, account }) => {
    const h = harness({ toolsService: tools, owner: () => account.state.getState().currentUser?.id });
    try {
      const v1 = combo("1.0.0");
      const installed = await h.workshop.installArchive(v1, runtimeFiles(v1));
      vi.spyOn(h.host.skills, "writeBinaryFile").mockRejectedValueOnce(new Error("模拟附件写入失败"));
      await expect(h.workshop.installArchive(combo("2.0.0"), {
        ...runtimeFiles(combo("2.0.0")),
        "assets/stop.bin": Uint8Array.of(255),
      })).rejects.toThrow("模拟附件写入失败");

      const entry = tools.state.getState()[0];
      expect(entry?.package.version).toBe("1.0.0");
      expect(entry?.dir).toBe(installed.dir);
      expect(await h.io.readTextFile(`${entry?.dir}/index.html`)).toContain("runtime-1.0.0");
      // 失败的那次只留下清理干净的暂存：别在磁盘上留一份孤儿副本。
      expect([...h.io.files.keys()].filter((path) => path.includes(".staging-"))).toEqual([]);
    } finally { h.workshop.dispose(); }
  });
});

/**
 * OBS-08：新版目录里不该有上一版的文件，导出也就不会把它们带走。
 *
 * 以前同目录叠盖：v2 不再提供的附件还留在那儿，导出递归读整个目录，收件人
 * 拿到的包里带着上一个版本的文件。
 */
it("exports only the files this version actually installed", async () => {
  await withRealTools(async ({ tools, account }) => {
    const h = harness({ toolsService: tools, owner: () => account.state.getState().currentUser?.id });
    try {
      const v1 = combo("1.0.0");
      const stale = "assets/v1-only.txt";
      await h.workshop.installArchive(v1, { ...runtimeFiles(v1), [stale]: new TextEncoder().encode("v1 only") });
      const newer = await h.workshop.installArchive(combo("2.0.0"), runtimeFiles(combo("2.0.0")));

      const exported = await readToolDirFiles(hostToolIO(h.host), newer.dir!);
      expect(exported.files[stale]).toBeUndefined();
      expect(tools.state.getState()[0]?.package.version).toBe("2.0.0");
      // 两版各占一个目录：上一版还在，退版有东西可切（切目录的断言在 tools.test.ts）。
      expect(newer.dir).not.toBe(tools.state.getState()[0]?.previousDir);
      expect(await h.io.pathExists(tools.state.getState()[0]!.previousDir!)).toBe(true);
    } finally { h.workshop.dispose(); }
  });
});

/**
 * OBS-05：安装的是开发目录的一份快照。
 *
 * 以前工坊把作者目录同时当运行地址，作者改完页面、没重新安装，已安装的工具
 * 就已经读到新内容了——与管理页承诺的"快照"相反。
 */
it("keeps reading the installed snapshot after the author edits the project", async () => {
  await withRealTools(async ({ tools, account }) => {
    const h = harness({ toolsService: tools, owner: () => account.state.getState().currentUser?.id });
    try {
      await h.io.writeTextFile(`${h.dir}/manifest.json`, JSON.stringify({
        schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0",
      }));
      await h.io.writeTextFile(`${h.dir}/index.html`, "<p>runtime-1.0.0</p>");
      await h.workshop.select(h.dir);
      expect(await h.workshop.install()).toBe(true);

      // 只改开发目录，不重新安装。
      await h.io.writeTextFile(`${h.dir}/index.html`, "<p>还没装的草稿</p>");
      const opened = await h.workshop.resolveOpenDir("demo");
      expect(opened).not.toBe(h.dir);
      expect(await h.io.readTextFile(`${opened}/index.html`)).toContain("runtime-1.0.0");
      // 来源另存一份：管理页仍能指出"从哪儿装的"，但它不参与运行。
      expect(tools.state.getState()[0]?.sourceDir).toBe(h.dir);
    } finally { h.workshop.dispose(); }
  });
});

/**
 * OBS-02：旧版补齐不再改写运行目录。
 *
 * 面板首扫会拿全部已安装包去"迁移旧记录"。以前这一步顺手把安装记录的运行
 * 路径指到了刚生成的脚手架，带二进制附件的工具当场读不到附件。
 */
it("migrating legacy records never repoints a working runtime copy", async () => {
  await withRealTools(async ({ tools, account }) => {
    const h = harness({ toolsService: tools, owner: () => account.state.getState().currentUser?.id });
    try {
      const tool = combo("1.0.0");
      const installed = await h.workshop.installArchive(tool, {
        ...runtimeFiles(tool),
        "assets/probe.bin": Uint8Array.of(255, 128, 1),
      });
      await h.workshop.migrateLegacy(tools.state.getState());
      const dir = await h.workshop.resolveOpenDir(tool.id);
      expect(dir).toBe(installed.dir);
      expect(await h.host.skills.readBinaryFile!(`${dir}/assets/probe.bin`, 64)).toBe("/4AB");

      // 再进一次面板：不重复生成项目、不重复写记录。
      await h.workshop.migrateLegacy(tools.state.getState());
      expect(await h.io.pathExists("tools/projects/u1/combo/manifest.json")).toBe(false);
    } finally { h.workshop.dispose(); }
  });
});

/** 只带清单、缺运行入口的包明确拒绝，而不是装一个点不动的空壳。 */
it("refuses a package that only carries the manifest", async () => {
  await withRealTools(async ({ tools, account }) => {
    const h = harness({ toolsService: tools, owner: () => account.state.getState().currentUser?.id });
    try {
      const bundled = parseToolPackage(JSON.stringify({
        schemaVersion: 1, id: "bundled", name: "打包页", version: "1.0.0",
        html: '<script src="./app.js"></script>', build: { out: "app.js" },
      }));
      await expect(h.workshop.installArchive(bundled)).rejects.toThrow("app.js");
      expect(tools.state.getState()).toEqual([]);
    } finally { h.workshop.dispose(); }
  });
});

/**
 * 导入文件夹：只要有文件读不出来（超上限 / 被占用），整体不装。
 *
 * 以前这里只把数量写进成功提示、照样把读到的部分装进去。少几个依赖的副本
 * 打开不报错、点哪儿都空白——比当场失败难查得多。「确认安装」那条路
 * （`installFiles`）一直守着这条纪律，两条入口不该有两个标准。
 */
it("refuses to import a folder when any file cannot be read", async () => {
  const h = harness();
  try {
    await h.io.writeTextFile(`${h.dir}/manifest.json`, JSON.stringify({
      schemaVersion: 1, id: "demo", name: "演示", version: "1.0.0",
    }));
    await h.io.writeTextFile(`${h.dir}/index.html`, "<p>demo</p>");
    await h.io.writeTextFile(`${h.dir}/assets/logo.png`, "binary");
    h.unreadable.add(`${h.dir}/assets/logo.png`);
    h.pickDirectory.mockResolvedValue(h.dir);

    const note = await h.workshop.importFromFolder();

    expect(note.error).toBe(true);
    expect(note.text).toContain("这次没有导入");
    expect(note.text).toContain("logo.png");
    expect(h.installs).toEqual([]);
  } finally {
    h.workshop.dispose();
  }
});

/**
 * 卸载报告要把"密钥也清了"单独说出来。
 *
 * 密钥不在 `storage/<id>.json` 里，用户勾的「删除工具数据」在他理解中覆盖不到
 * 这一份。只在删掉时提一句，删失败时这句话不出现——不能拿一句笼统的
 * "已清理"糊过去。
 */
it("says so when uninstall also removed the tool's stored secrets", async () => {
  const h = harness();
  h.toolPurge.mockResolvedValue({
    removedDirs: ["E:/AAW/tools/installed/u1/demo"],
    skippedDirs: [],
    failedDirs: [],
    removedData: true,
    removedBackup: true,
    removedSecrets: true,
  });
  try {
    const note = await h.workshop.purge("demo");
    expect(note.error).toBeUndefined();
    expect(note.text).toContain("已删除工具数据");
    expect(note.text).toContain("密钥");
  } finally {
    h.workshop.dispose();
  }
});

/**
 * "该删但没删掉"不等于卸载成功。
 *
 * 记录一撤，卡片就从列表里消失；盘上那几十 MB（被占用、权限不足）再没有任何
 * 入口能清，用户连重试的按钮都没有。所以这一路必须留住记录并明说原因——
 * 与"校验没过、本来就该跳过的目录"要分开处理。
 */
it("keeps the record when a directory could not be deleted", async () => {
  const h = harness();
  h.toolPurge.mockResolvedValue({
    removedDirs: [],
    skippedDirs: [],
    failedDirs: ["E:/AAW/tools/installed/u1/demo/versions/1.0.0"],
    removedData: false,
    removedBackup: false,
    removedSecrets: false,
  });
  try {
    const note = await h.workshop.purge("demo");
    expect(note.error).toBe(true);
    expect(note.text).toContain("没删掉");
    expect(h.removes).toEqual([]);
  } finally {
    h.workshop.dispose();
  }
});
