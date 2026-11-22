import { expect, it, vi } from "vitest";
import { createStore } from "zustand";
import type { HostService } from "../../../src/plugins/host/service.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";
import { memoryToolIO } from "../../../src/plugins/tools/runtime/io.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import type { ToolsService } from "../../../src/plugins/tools/service.ts";
import type { PersonalTool } from "../../../src/plugins/tools/types.ts";
import { createWorkshop, syncToolGuide } from "../../../src/plugins/tools/ui/workshop.ts";

/**
 * 工坊的"人接手"路径：AI 回灌 3 轮还修不好时，必须把选择权交回用户——
 * 状态里留着项目路径（UI 用它渲染可复制的文本）和"重新校验"入口。
 * 只写一句"或直接改文件"等于把死路当结论（见 docs 22 §4 P0-2）。
 */
function harness(options: { native?: boolean; settings?: { read: () => string | undefined; write: (value: string | undefined) => void } } = {}) {
  const io = memoryToolIO();
  const dir = "/data/tools/projects/u1/demo";
  const openInFileManager = vi.fn().mockResolvedValue(undefined);
  // 二进制端口的最小实现：导入/导出文件夹时 listToolFiles / readBinaryFile 会用到。
  const binaries = new Map<string, string>();
  const readBinaryFile = (path: string) => {
    const raw = binaries.get(path) ?? io.files.get(path);
    if (raw === undefined) return Promise.reject(new Error(`文件不存在：${path}`));
    if (typeof raw !== "string") return Promise.resolve(raw);
    // 文本要走 UTF-8 字节再转 base64：btoa 遇到中文直接抛（真实宿主读的是原始字节，无此问题）。
    const bytes = new TextEncoder().encode(raw);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return Promise.resolve(btoa(binary));
  };
  const toolPurge = vi.fn(() => Promise.resolve({ removedDirs: [], removedData: false, skippedDirs: [] }));
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
    },
    archives: { readTextFile: (path: string) => io.readTextFile(path) },
    files: { openInFileManager },
  } as unknown as HostService;

  const setSource = vi.fn();
  const toolStore = createStore<readonly PersonalTool[]>(() => []);
  const tools = {
    state: toolStore,
    // 返回真实的 InstallOutcome：installArchive 之后 describeInstall 要读它。
    install: vi.fn((tool: { version: string }) => ({ version: tool.version, updated: false, versionChanged: false })),
    rollback: vi.fn(),
    setSource,
    open: vi.fn(),
    remove: vi.fn(),
    saveSettings: vi.fn(),
  } as unknown as ToolsService;

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

  const workshop = createWorkshop({ tools, project, host, owner: () => "u1", ...(options.settings ? { settings: options.settings } : {}) });
  return { workshop, io, dir, send, openInFileManager, session, setSource, project, startNewSession, pickDirectory, tools, toolStore, host, toolPurge, workspace };
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
  expect(toolFiles.every((path) => path.startsWith("tools/installed/u1/demo/"))).toBe(true);
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
  const { workshop, io, setSource } = harness();
  const tool = parseToolPackage(JSON.stringify({
    schemaVersion: 1, id: "legacy", name: "旧工具", version: "1.0.0", html: "<p>hi</p>",
  }));
  const result = await workshop.migrateLegacy([tool]);
  expect(result.created).toEqual(["tools/projects/u1/legacy"]);
  expect(await io.pathExists("tools/projects/u1/legacy/manifest.json")).toBe(true);
  expect(await io.pathExists("tools/projects/anonymous/legacy/manifest.json")).toBe(false);
  // 迁出来的目录要登记成这个工具的源码位置，卡片才判得出"项目改了没重装"。
  expect(setSource).toHaveBeenCalledWith("legacy", "tools/projects/u1/legacy");
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
  // 安装带上了来源目录，文件都写进了 installed/ 运行副本。
  expect(startNewSession).not.toHaveBeenCalled();
  expect(await io.pathExists("tools/installed/u1/demo/index.html")).toBe(true);
  expect(await io.pathExists("tools/installed/u1/demo/assets/data.txt")).toBe(true);
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
