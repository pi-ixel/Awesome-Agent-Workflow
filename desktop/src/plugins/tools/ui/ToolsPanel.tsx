import { useDeferredValue, useEffect, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent as ReactMouseEvent } from "react";
import { useStore } from "zustand";
import { pathKey } from "../../../shared/panelPaths.ts";
import { DangerButton, btnGhost, btnPrimary, btnSecondary } from "../../../shared/ui/controls.tsx";
import { ContextMenu } from "../../../shared/ui/ContextMenu.tsx";
import type { ContextMenuEntry } from "../../../shared/ui/ContextMenu.tsx";
import { SquareTerminalIcon, WrenchIcon } from "../../../shared/ui/icons.tsx";
// 外观由 tools.css 决定，挂共享常量是为了让编辑框守卫识别这两个输入框。
import { composerFieldClass, fieldSurfaceClass } from "../../../shared/ui/inputStyles.ts";
import { useMenuController } from "../../../shared/ui/useMenuController.ts";
import type { HostService } from "../../host/service.ts";
import type { ProjectService } from "../../project/service.ts";
import { exampleTools } from "../runtime/examples.ts";
import { exportToolProject, readToolUpload } from "../runtime/projectArchive.ts";
import { readToolDirFiles, checkToolProject } from "../runtime/project.ts";
import { NewToolForm } from "./ToolBuilder.tsx";
import { ToolManagement } from "./ToolManagement.tsx";
import { ToolPreview } from "./ToolPreview.tsx";
import { ToolProjectList } from "./ToolProjects.tsx";
import { projectIO, describeInstall } from "./workshop.ts";
import type { WorkshopService } from "./workshop.ts";
import { toolGlyph, toneOf } from "./mark.ts";
import type { ToolsService } from "../service.ts";
import type { ToolPackage } from "../types.ts";
import "./tools.css";

type View =
  | { kind: "library" }
  | { kind: "projects" }
  | { kind: "manage"; id: string }
  | { kind: "preview"; tool: ToolPackage; from: Tab };

type Tab = "library" | "projects";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * 空列表不是"什么都没有"的占位符，而是这个页面唯一一次讲清「工具能干嘛」的机会。
 *
 * 原来只有一个虚线框 + 一行灰字 + 两个按钮，既没说明做出来的东西长什么样，
 * 也没说 AI 会做哪些事，用户站在空页面前不知道该点哪。这里给出三步预期和
 * 一个具体例子，主按钮直接去「开发工具」——不再和页签摆两个同义入口。
 */
function EmptyLibrary({ onCreate, onImport, onExamples }: { onCreate: () => void; onImport: (event: ReactMouseEvent<HTMLButtonElement>) => void; onExamples: () => void }) {
  return <section className="tools-empty" aria-label="还没有工具">
    <div className="tools-empty-hero">
      <span className="tools-empty-glow" aria-hidden="true" />
      <span className="tools-empty-mark" aria-hidden="true"><WrenchIcon /></span>
    </div>
    <h3 className="tools-empty-title">从你的想法开始，做一个自己的工具</h3>
    <p className="tools-empty-lead">工具是能独立打开的小窗口：格式化 JSON、批量改文本、随手记点东西，或者让你的常用操作一键完成。</p>
    <ol className="tools-empty-steps">
      <li><span aria-hidden="true">1</span><div><strong>说清要做什么</strong><small>例如「把接口返回的 JSON 转成表格」</small></div></li>
      <li><span aria-hidden="true">2</span><div><strong>AI 写好并自动校验</strong><small>源码就在一个真实目录里，随时能改</small></div></li>
      <li><span aria-hidden="true">3</span><div><strong>验收后随时打开</strong><small>工具中心、启动器里都能一键唤起</small></div></li>
    </ol>
    <div className="tools-empty-actions">
      <button type="button" className={`${btnPrimary} tools-empty-primary`} onClick={onCreate}>开始做工具 <span aria-hidden="true">→</span></button>
      <div className="tools-empty-alts">
        <button type="button" className={`${btnSecondary} tools-empty-alt`} onClick={onImport}>导入工具…</button>
        <button type="button" className={`${btnSecondary} tools-empty-alt`} onClick={onExamples}>载入示例工具</button>
      </div>
    </div>
    <p className="tools-empty-foot">示例工具随时可以卸载；完整约定见「开发指导 ↗」。</p>
  </section>;
}

export function ToolsPanel({ service, host, project, workshop, visible: panelVisible = true, onPreviewProject }: {
  service: ToolsService;
  host: HostService;
  project?: ProjectService;
  workshop: WorkshopService;
  /**
   * 面板当前是否可见（右栏常驻挂载后靠它判断“重新露面”）。
   *
   * 以前面板失活即卸载，每次回来都会重新挂载并刷一次项目列表；常驻之后
   * 不再重挂，新项目（AI 刚写完的、外部加的）就再也不会出现在列表里。
   * 所以刷新时机改成“每次重新可见”。
   */
  visible?: boolean;
  /**
   * 在右栏另开一个预览标签（会话留在中间）。
   *
   * 省略时退回"把工具中心整页换成预览"的旧行为——那是给浏览器预览模式
   * 与没有右栏的场合留的后路。
   */
  onPreviewProject?: (dir: string, name?: string) => void;
}) {
  const tools = useStore(service.state);
  const workshopState = useStore(workshop.state);
  const [view, setView] = useState<View>({ kind: "library" });
  const [search, setSearch] = useState("");
  const [removing, setRemoving] = useState<{ id: string; files: boolean }>();
  const [feedback, setFeedback] = useState<{ text: string; error?: true }>();
  const [busy, setBusy] = useState(false);
  const cardMenu = useMenuController();
  const picker = useRef<HTMLInputElement>(null);
  const active = view.kind === "preview" ? view : undefined;
  const managed = view.kind === "manage" ? tools.find(({ package: tool }) => tool.id === view.id) : undefined;
  const tab: Tab = view.kind === "projects" ? "projects" : "library";
  // 列表可能上百条：搜索输入先降级渲染，打字时不会卡在过滤上。
  const query = useDeferredValue(search);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? tools.filter(({ package: tool }) => `${tool.name} ${tool.id}`.toLowerCase().includes(needle))
    : tools;
  /**
   * 页签上的项目数要跟列表里真正的行数一致。
   *
   * 刚建好的项目在扫描结果回来之前只存在于快照里，列表会把那一行合成出来
   * （否则用户会以为刚建的项目没了）。只数 `projects.length` 的话，页签写
   * 「开发工具 · 2」而列表写着「3 个项目」——两个数字当场打架。
   */
  const openDir = workshopState.project ? pathKey(workshopState.project.dir) : "";
  const scanned = workshopState.projects;
  const projectCount = scanned.length
    + (openDir && !scanned.some((entry) => pathKey(entry.dir) === openDir) ? 1 : 0);

  // 每次重新可见刷一次项目列表：AI 刚写完的项目要能立刻出现（常驻挂载后
  // 不会再有“重新挂载”这个刷新时机了）。
  useEffect(() => {
    if (panelVisible) void workshop.refreshProjects();
  }, [panelVisible, workshop]);

  // 旧版本的工具体存在 configuration 里；首次打开时迁成项目目录（只写不删）。
  // 交给工坊做：落点必须跟项目列表用同一个账号那层，否则迁出来的目录
  // 落在 `projects/anonymous/`，用户在「开发工具」里看不见。
  const migrated = useRef(false);
  useEffect(() => {
    if (!project || !host.isNative() || migrated.current || tools.length === 0) return;
    migrated.current = true;
    void (async () => {
      try {
        const result = await workshop.migrateLegacy(tools.map((entry) => entry.package));
        if (result.created.length) {
          setFeedback({ text: `已把 ${result.created.length} 个旧工具迁成项目目录，可以在「开发工具」里继续开发。` });
          void workshop.refreshProjects();
        }
      } catch { /* 迁移失败不该影响使用，下次打开再试 */ }
    })();
  }, [host, project, tools, workshop]);

  function run(action: () => void) {
    setFeedback(undefined);
    try {
      action();
    } catch (error) {
      setFeedback({ text: errorText(error), error: true });
    }
  }

  /** 彻底停掉常驻工具：关窗只是隐藏，这条才真的退出。 */
  async function stopBackground(id: string) {
    if (busy) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      if (!host.isNative()) throw new Error("请在 AAW 桌面版中停止后台工具。");
      await host.stopToolsElectron(id);
      // 本来就没在跑时结果也是"不在后台运行"，说同一句话不算骗人。
      setFeedback({ text: "已停止该工具的后台运行。" });
    } catch (error) {
      setFeedback({ text: errorText(error), error: true });
    } finally { setBusy(false); }
  }

  async function openElectron(id?: string) {
    if (busy) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      if (!host.isNative()) throw new Error("请在 AAW 桌面版中打开 Electron 插件窗口。");
      await host.openToolsElectron(id);
    } catch (error) {
      setFeedback({ text: errorText(error), error: true });
    } finally { setBusy(false); }
  }

  function installPackage(tool: ToolPackage) {
    setFeedback({ text: describeInstall(service.install(tool, true), tool.name) });
  }

  /** 示例工具走和导入 ZIP 完全一样的 install 路径，不搞特殊数据通道。 */
  function installExamples() {
    try {
      const names = exampleTools.map((tool) => {
        service.install(tool, true);
        return tool.name;
      });
      setFeedback({ text: `已载入 ${names.length} 个示例工具：${names.join("、")}。在「已安装」里可以打开、改设置或卸载；卸载完空状态里还能再载入一次。` });
    } catch (error) {
      setFeedback({ text: `载入示例失败：${errorText(error)}`, error: true });
    }
  }

  /**
   * 导入只有一个入口：点「导入工具」弹出选择菜单（ZIP 包 / 文件夹）。
   * 之前是两个并排按钮——头部多占一格还让人犹豫该点哪个；选择交给菜单，
   * 按钮只负责说“从这里导入”。文件夹入口仅限本地宿主（浏览器没有目录选择）。
   */
  function openImportMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    // 菜单 id 用冒号前缀：工具 id 的合法字符集是 a-z0-9.-，冒号不可能撞车。
    cardMenu.open(":import", "导入工具", [
      { id: "import-zip", label: "导入 ZIP 包…", onSelect: () => picker.current?.click() },
      ...(host.isNative()
        ? [{ id: "import-folder", label: "导入文件夹…", disabled: busy, onSelect: () => void importFolder() }]
        : []),
    ], { x: rect.right, y: rect.bottom + 4, side: "bottom", align: "end" });
  }

  /** 从本地文件夹导入一个工具目录：与 ZIP 同一条安装链路（校验 → 落盘 → 安装）。 */
  async function importFolder() {
    if (busy) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      const note = await workshop.importFromFolder();
      setFeedback({ text: note.text, ...(note.error ? { error: true as const } : {}) });
    } catch (error) {
      setFeedback({ text: errorText(error), error: true });
    } finally { setBusy(false); }
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    const failures: string[] = [];
    const lines: string[] = [];
    for (const file of files) {
      try {
        const upload = await readToolUpload(file);
        const outcome = await workshop.installArchive(upload.tool, upload.files);
        lines.push(describeInstall(outcome, upload.tool.name));
        if (upload.tool.permissions?.network) lines.push(`注意：${upload.tool.name} 会联网（作者声明的）。`);
        // 带依赖的包：说清依赖落在哪，用户以后想改/找不到时有个确切位置。
        // 只数 node_modules 下的文件——`files` 里还有 manifest.json、index.html、
        // AGENTS.md 这些作者自己的文件，把它们说成"依赖"会让用户以为装了个重包。
        const dependencies = Object.keys(upload.files ?? {}).filter((path) => path.startsWith("node_modules/")).length;
        if (dependencies) lines.push(`${upload.tool.name} 自带 ${dependencies} 个依赖文件，已写入工具目录。`);
      } catch (error) {
        failures.push(`${file.name}：${errorText(error)}`);
      }
    }
    setFeedback(failures.length ? { text: [...lines, ...failures].join("\n"), error: true } : { text: lines.join("\n") });
  }

  async function exportTool(tool: ToolPackage, dir?: string) {
    if (busy) return;
    setBusy(true);
    setFeedback(undefined);
    const filename = `${tool.id}-${tool.version}-source.zip`;
    try {
      // 工具目录里可能有 node_modules、图片、wasm：这些不打进去，收件人拿到的
      // 包就跑不起来，而作者会以为"我明明发的是完整项目"。
      const extra = dir && host.isNative() ? await readToolDirFiles(projectIO(host), dir) : { files: {}, skipped: [] };
      const bytes = exportToolProject(tool, extra.files);
      let destination = filename;
      if (host.isNative()) {
        const path = await host.dialogs.saveFile({ defaultPath: filename, filters: [{ name: "工具源码", extensions: ["zip"] }] });
        if (!path) { setFeedback({ text: "已取消导出。" }); return; }
        await host.writeToolArchive(path, bytes);
        destination = path;
      } else {
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: "application/zip" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      // 之前写的是"拖回工具中心即可导入"——但拖拽从来没被支持过，用户会照着做然后发现没反应。
      // 只说真实存在的路径：点「导入工具」选「导入 ZIP 包」再选中这个文件。
      const skipped = extra.skipped.length ? `（有 ${extra.skipped.length} 个文件超过单包上限，没打进去）` : "";
      setFeedback({ text: `已导出到 ${destination}${skipped}。要导入时点「导入工具」，选「导入 ZIP 包」再选中这个文件即可。` });
    } catch (error) {
      setFeedback({ text: `导出失败：${errorText(error)}`, error: true });
    } finally { setBusy(false); }
  }

  /** 打开「工具开发指导」窗口：内容与 AI 读的规范同源。 */
  async function openGuide() {
    if (busy) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      await host.openToolsGuide();
    } catch (error) {
      setFeedback({ text: errorText(error), error: true });
    } finally { setBusy(false); }
  }

  async function previewProject(dir: string) {
    // 预览不改工作台状态。
    //
    // 这里以前先 `workshop.select(dir)`：于是"我就看一眼"会把这个项目展开、
    // 把用户正在弄的那个收起，列表还按最近操作重排一次——三个变化都不是他
    // 点的那件事。改成只读一次盘拿工具包，读完就不再碰状态。
    let tool: ToolPackage | undefined;
    try {
      tool = (await checkToolProject(projectIO(host), dir)).tool;
    } catch (error) {
      setFeedback({ text: errorText(error), error: true });
      return;
    }
    if (!tool) {
      // 刚建好的项目清单是合法的、页面内容还空着：这不是"坏了"，是"还没写完"。
      setFeedback({ text: "这个项目还没有可预览的内容，展开它能看到校验结论；AI 写完后再预览。", error: true });
      return;
    }
    if (onPreviewProject) {
      const name = workshop.state.getState().projects
        .find((entry) => pathKey(entry.dir) === pathKey(dir))?.name;
      onPreviewProject(dir, name);
      return;
    }
    // 没有右栏预览时的兑底：整页换成预览。记住从哪个页签进来，
    // 关掉预览回那里——以前硬编码回「已安装」，正在看的开发列表直接消失。
    setView({ kind: "preview", tool, from: tab });
  }

  /**
   * 卡片上只留一个主操作（打开），其余收进「⋯」：之前 5 个按钮平铺，扫视
   * 成本高，而且「卸载」和「导出」的视觉权重完全一样。
   */
  function openCardMenu(event: ReactMouseEvent<HTMLButtonElement>, tool: ToolPackage) {
    const rect = event.currentTarget.getBoundingClientRect();
    const entry = tools.find((item) => item.package.id === tool.id);
    const entries: ContextMenuEntry[] = [
      { id: "manage", label: "管理", onSelect: () => { setFeedback(undefined); setView({ kind: "manage", id: tool.id }); } },
      { id: "export", label: "导出源码", disabled: busy, onSelect: () => void exportTool(tool, entry?.dir) },
      // 常驻工具点关闭只是隐藏窗口，进程还活着。不给这条出口，用户只能退出
      // 整个工具宿主才能停掉它。
      ...(tool.background
        ? [{ id: "stop", label: "停止后台运行", onSelect: () => void stopBackground(tool.id) }]
        : []),
      // 只有"装过至少两次"的工具才有上一版：装坏了这一步能救回来。
      ...(entry?.previousVersion
        ? [{ id: "rollback", label: `退回上一版 v${entry.previousVersion}`, onSelect: () => void rollbackTool(tool.id) }]
        : []),
      { type: "separator" as const },
      { id: "remove", label: "卸载", danger: true, onSelect: () => setRemoving({ id: tool.id, files: false }) },
    ];
    cardMenu.open(tool.id, `${tool.name} 操作`, entries, { x: rect.right, y: rect.bottom + 4, side: "bottom", align: "end" });
  }

  async function rollbackTool(id: string) {
    const note = await workshop.rollback(id);
    setFeedback({ text: note.text, ...(note.error ? { error: true as const } : {}) });
  }

  async function confirmRemove(id: string, files: boolean) {
    setRemoving(undefined);
    run(() => service.remove(id));
    // 卸载之后它的窗口不该继续活着（常驻工具尤其如此）：走同一个停止通道顺手关掉。
    // 失败不影响卸载本身，最多是那个窗口留到用户自己关。
    if (host.isNative()) void host.stopToolsElectron(id).catch(() => {});
    if (!files) return;
    const note = await workshop.purge(id);
    setFeedback({ text: `已卸载。${note.text}`, ...(note.error ? { error: true as const } : {}) });
  }

  if (managed) return <ToolManagement key={`${managed.package.id}:${JSON.stringify(managed.settings)}:${JSON.stringify(managed.package.settingsSchema)}`} entry={managed} busy={busy} feedback={feedback}
    onBack={() => { setView({ kind: "library" }); setFeedback(undefined); }}
    onOpen={() => void openElectron(managed.package.id)} onExport={() => void exportTool(managed.package, managed.dir)}
    onRollback={() => void rollbackTool(managed.package.id)}
    onSave={(values) => { try { service.saveSettings(managed.package.id, values); setFeedback({ text: "设置已保存，重新打开插件后生效。" }); return true; } catch (error) { setFeedback({ text: errorText(error), error: true }); return false; } }}
    onRemove={() => {
      run(() => { service.remove(managed.package.id); setView({ kind: "library" }); });
      // 管理页也是卸载入口，同样要把它的窗口关掉——常驻工具不关就还在后台跑。
      if (host.isNative()) void host.stopToolsElectron(managed.package.id).catch(() => {});
    }}
    onUpdate={(file) => { void (async () => { try {
      const upload = await readToolUpload(file);
      if (upload.tool.id !== managed.package.id) throw new Error("更新包的插件 ID 必须与当前插件一致。");
      const outcome = await workshop.installArchive(upload.tool, upload.files);
      setFeedback({ text: describeInstall(outcome, upload.tool.name) });
    } catch (error) { setFeedback({ text: errorText(error), error: true }); } })(); }} />;

  if (active) {
    return <ToolPreview
      tool={active.tool}
      onBack={() => setView({ kind: active.from })}
      onInstall={() => { run(() => installPackage(active.tool)); setView({ kind: "library" }); }}
      installLabel="安装到工具中心"
    />;
  }

  return (
    <section aria-label="工具" className="aaw-tools flex h-full min-h-0 flex-col bg-base">
      <header className="tools-header border-b border-line px-4 pb-3 pt-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex ui-icon-40 shrink-0 items-center justify-center rounded-xl border border-info/20 bg-info/10 text-info"><WrenchIcon className="ui-icon-20" /></span>
          <div className="tools-title mr-auto"><h2 className="text-ui-xl font-semibold text-ink">工具中心</h2><p className="mt-1 text-ui-sm text-ink-subtle">描述你的需求，AI 做一个能用的小工具</p></div>
          {host.isNative() && <button type="button" className={btnSecondary} onClick={() => void openElectron()}>打开启动器 ↗</button>}
          <button type="button" className={btnSecondary} aria-haspopup="menu" aria-expanded={cardMenu.menu?.id === ":import"} disabled={busy} onClick={openImportMenu}>导入工具</button>
        </div>
        <div className="tools-tabs mt-4 flex flex-wrap items-center gap-2">
          <button type="button" className={tab === "library" ? btnSecondary : btnGhost} aria-pressed={tab === "library"} onClick={() => setView({ kind: "library" })}>已安装 · {tools.length}</button>
          {/* 顶部不再放「新建工具」：它和这个页签是同一个界面，两个入口只会让人
              以为点了会去别的地方。做工具统一从这里进，名字也统一叫「开发工具」。 */}
          <button type="button" className={tab === "projects" ? btnSecondary : btnGhost} aria-pressed={tab === "projects"} onClick={() => { setView({ kind: "projects" }); void workshop.refreshProjects(); }}>开发工具 · {projectCount}</button>
          {/* 开发指导独立成窗口：内容是全平台通用的规范，不该混在"做某个工具"的流程里。 */}
          <button type="button" className={`${btnGhost} tools-guide`} onClick={() => void openGuide()} disabled={busy}>开发指导 ↗</button>
        </div>
        <input ref={picker} type="file" className={fieldSurfaceClass} multiple accept=".zip,.json,application/zip,application/json" onChange={(event) => void importFiles(event)} hidden />
      </header>
      <div className="tools-content min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {feedback && (
          <p role={feedback.error ? "alert" : "status"} className={`whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2 text-ui-sm ${feedback.error ? "text-danger-ink" : "text-ink-subtle"}`}>
            {feedback.text}
          </p>
        )}

        {tab === "projects" && <>
          <NewToolForm workshop={workshop} available={host.isNative()} />
          <ToolProjectList
            workshop={workshop}
            installed={tools}
            available={host.isNative()}
            onPreview={(dir) => void previewProject(dir)}
          />
        </>}

        {tab === "library" && <>
          {tools.length === 0 && (
            <EmptyLibrary
              onCreate={() => setView({ kind: "projects" })}
              onImport={openImportMenu}
              onExamples={installExamples}
            />
          )}
          {tools.length > 0 && <label className="tools-search"><span aria-hidden="true">⌕</span><input className={composerFieldClass} aria-label="搜索已安装工具" placeholder="搜索你的工具…" value={search} onChange={(event) => setSearch(event.target.value)} /><span>{tools.length}</span></label>}
          {/* 紧凑行而不是大卡片：右栏只有 360px 左右，卡片式一屏只能放三个，
              而"打开某个工具"是这一页最高频的动作。一行一个，扫视成本最低。 */}
          <ul aria-label="已安装工具" className="tool-rows">
            {visible.map(({ package: tool, broken }) => (
              <li key={tool.id} className={`tool-row ${removing?.id === tool.id ? "is-expanded" : ""} ${broken ? "is-broken" : ""}`}>
                {/* 图标与底色都由工具 id 决定，与小窗完全一致：字形优先，缺省用名称首字。 */}
                <span aria-hidden="true" className={`tool-symbol is-row tone-${toneOf(tool.id)}`}>{toolGlyph(tool)}</span>
                <div className="tool-row-main">
                  <span className="tool-row-name">{tool.name}</span>
                  {/* 不可用的工具**保留在列表里**，只标记原因——宁可显示一张跑不了的
                      卡片，也不能让它无声消失。完整说明挂在 data-hint 上。 */}
                  <span className="tool-row-meta" data-hint={broken ? `${broken.reason}${broken.hint}` : undefined}>
                    {broken ? (
                      <span className="tool-row-tag is-warn">不兼容</span>
                    ) : (
                      <>
                        v{tool.version}
                        {!!tool.actions?.length && <span className="tool-row-tag"><SquareTerminalIcon className="ui-icon-12" />{tool.actions.length} 动作</span>}
                        {tool.permissions?.network && <span className="tool-row-tag">可联网</span>}
                        {/* 这个标记不是装饰：常驻工具关窗后仍在跑，用户得知道
                            "关掉了"和"真退出了"是两回事。 */}
                        {tool.background && (
                          <span className="tool-row-tag" data-hint={`关闭窗口后仍在后台运行：${tool.background.reason ?? "工具声明了常驻"}。可在「⋯」里彻底停止。`}>后台</span>
                        )}
                      </>
                    )}
                  </span>
                </div>
                {removing?.id === tool.id ? (
                  <div className="tool-remove is-row">
                    <div className="tool-remove-actions">
                      <button type="button" className={btnGhost} onClick={() => setRemoving(undefined)}>取消</button>
                      {/* 危险动作给危险配色，取消退回中性：之前两者权重是反的。 */}
                      <DangerButton onClick={() => void confirmRemove(tool.id, removing.files)}>卸载</DangerButton>
                    </div>
                    <label className="tool-remove-option">
                      <input type="checkbox" checked={removing.files} onChange={(event) => setRemoving({ id: tool.id, files: event.target.checked })} />
                      同时删除项目目录与工具数据
                    </label>
                  </div>
                ) : (
                  <div className="tool-row-actions">
                    <button type="button" className="tool-row-open" aria-label={`打开 ${tool.name}`} disabled={busy || broken !== undefined} data-hint={broken?.hint} onClick={() => void openElectron(tool.id)}>打开</button>
                    <button type="button" className="tool-row-more" aria-label={`更多操作：${tool.name}`} aria-haspopup="menu" aria-expanded={cardMenu.menu?.id === tool.id} onClick={(event) => openCardMenu(event, tool)}>⋯</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {needle && visible.length === 0 && (
            <div className="tools-search-empty">
              <span aria-hidden="true">⌕</span>
              <div>
                <strong>没有找到匹配的工具</strong>
                <p>名字或 ID 里没有「{query.trim()}」。换个关键词，或者看看是不是还没导入。</p>
              </div>
              <button type="button" className={btnGhost} onClick={() => setSearch("")}>清空搜索</button>
            </div>
          )}
        </>}
      </div>
      {cardMenu.menu && (
        <ContextMenu
          entries={cardMenu.menu.entries}
          placement={cardMenu.menu.placement}
          label={cardMenu.menu.label}
          closing={cardMenu.menu.closing}
          onDismiss={cardMenu.dismiss}
        />
      )}
    </section>
  );
}
