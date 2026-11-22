import { it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStore } from "zustand";
import { ToolsPanel } from "../../../src/plugins/tools/ui/ToolsPanel.tsx";
import { sampleTool } from "../../../src/plugins/tools/ui/sample.ts";
import type { PersonalTool, ToolPackage, ToolSettings } from "../../../src/plugins/tools/types.ts";
import type { ToolsService } from "../../../src/plugins/tools/service.ts";
import type { HostService } from "../../../src/plugins/host/service.ts";
import { importToolProject, exportToolProject } from "../../../src/plugins/tools/runtime/projectArchive.ts";
import { exampleTools } from "../../../src/plugins/tools/runtime/examples.ts";
import { ToolManagement } from "../../../src/plugins/tools/ui/ToolManagement.tsx";
import { fakeWorkshop } from "./fakeWorkshop.ts";

it("defers a selected source update until dirty settings are explicitly discarded", () => {
  const update = vi.fn();
  const { container } = render(<ToolManagement entry={{ package: sampleTool }} onBack={vi.fn()} onOpen={vi.fn()}
    onExport={vi.fn()} onUpdate={update} onSave={() => true} onRemove={vi.fn()} busy={false} />);
  fireEvent.change(screen.getByLabelText(/缩进空格数/), { target: { value: "4" } });
  expandSection(/源码与开发/);
  const file = new File(["{}"], "update.json", { type: "application/json" });
  const picker = container.querySelector('input[type="file"]')!;
  fireEvent.change(picker, { target: { files: [file] } });
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "继续编辑" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  expect(screen.getByLabelText(/缩进空格数/)).toHaveValue(4);
  fireEvent.change(picker, { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "放弃修改并继续" }));
  expect(update).toHaveBeenCalledExactlyOnceWith(file);
});

it("keeps unsaved settings until leaving the tool is explicitly confirmed", () => {
  const state = createStore<readonly PersonalTool[]>(() => [{ package: sampleTool }]);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true } as unknown as HostService;
  render(<ToolsPanel service={service} host={host} workshop={fakeWorkshop()} />);
  openCardMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "管理" }));
  fireEvent.change(screen.getByLabelText(/缩进空格数/), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: /返回工具中心/ }));
  expect(screen.getByRole("alert")).toHaveTextContent("未保存");
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  expect(screen.getByLabelText(/缩进空格数/)).toHaveValue(4);
  fireEvent.click(screen.getByRole("button", { name: /返回工具中心/ }));
  fireEvent.click(screen.getByRole("button", { name: "放弃修改并返回" }));
  expect(screen.getByRole("list", { name: "已安装工具" })).toBeVisible();
  expect(service.saveSettings).not.toHaveBeenCalled();
});

/**
 * 退版会让表单按上一版的 schema 重新挂载，没保存的草稿会一起没（OBS-07）。
 * 所以它必须和「更新源码」「返回」走同一个放弃确认，而且在用户点确认之前
 * 一条退版请求都不该发出去——连点两次触发也只能弹一次、发一条。
 */
it("rolls back only after unsaved settings are explicitly discarded, and only once", async () => {
  const rollback = vi.fn().mockResolvedValue({ text: "已退回 v0.9.0。" });
  const state = createStore<readonly PersonalTool[]>(() => [{ package: sampleTool, previousVersion: "0.9.0" }]);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true } as unknown as HostService;
  render(<ToolsPanel service={service} host={host} workshop={{ ...fakeWorkshop(), rollback }} />);
  openCardMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "管理" }));
  fireEvent.change(screen.getByLabelText(/缩进空格数/), { target: { value: "4" } });
  expandSection(/源码与开发/);
  fireEvent.click(screen.getByRole("button", { name: "退回上一版 v0.9.0" }));
  expect(rollback).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "继续编辑" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  // 选了「继续编辑」就只是回到编辑态：草稿还在，退版一条都没发。
  expect(screen.getByLabelText(/缩进空格数/)).toHaveValue(4);
  expect(rollback).not.toHaveBeenCalled();
  // 触发点连点两次不该排出两条队列（第二条会拿到刚换下来的那一版）。
  fireEvent.click(screen.getByRole("button", { name: "退回上一版 v0.9.0" }));
  fireEvent.click(screen.getByRole("button", { name: "退回上一版 v0.9.0" }));
  fireEvent.click(screen.getByRole("button", { name: "放弃修改并退回" }));
  await waitFor(() => expect(rollback).toHaveBeenCalledExactlyOnceWith(sampleTool.id));
  expect(screen.getByRole("status")).toHaveTextContent("已退回 v0.9.0");
});

/** 退版失败时草稿必须还能编辑：失败提示是结果，不是把用户输入也一并清掉。 */
it("keeps the unsaved draft editable when a rollback fails", async () => {
  const rollback = vi.fn().mockResolvedValue({ text: "退回失败：上一版的运行副本不可用。", error: true });
  const state = createStore<readonly PersonalTool[]>(() => [{ package: sampleTool, previousVersion: "0.9.0" }]);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true } as unknown as HostService;
  render(<ToolsPanel service={service} host={host} workshop={{ ...fakeWorkshop(), rollback }} />);
  openCardMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "管理" }));
  fireEvent.change(screen.getByLabelText(/缩进空格数/), { target: { value: "4" } });
  expandSection(/源码与开发/);
  fireEvent.click(screen.getByRole("button", { name: "退回上一版 v0.9.0" }));
  fireEvent.click(screen.getByRole("button", { name: "放弃修改并退回" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("退回失败"));
  expect(screen.getByLabelText(/缩进空格数/)).toHaveValue(4);
  expect(screen.getByRole("button", { name: /源码与开发/ })).toHaveAttribute("aria-expanded", "true");
  expect(rollback).toHaveBeenCalledTimes(1);
});

/** 卡片上只剩「打开」与「⋯」，管理 / 导出 / 卸载都收进了菜单。 */
function openCardMenu(name = "JSON 格式化") {
  fireEvent.click(screen.getByRole("button", { name: `更多操作：${name}` }));
}

/** 管理页现在是折叠分区：想用某个分区里的按钮，先点开它的标题。 */
function expandSection(name: RegExp) {
  const head = screen.getByRole("button", { name });
  if (head.getAttribute("aria-expanded") === "false") fireEvent.click(head);
}

it("opens the tool directly, routes Manage separately, saves settings and exports source ZIP", async () => {
  const state = createStore<readonly PersonalTool[]>(() => [{ package: sampleTool, settings: { indent: 2 } }]);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn((_id: string, values: ToolSettings) => state.setState([{ package: sampleTool, settings: values }], true)) } satisfies ToolsService;
  const open = vi.fn().mockResolvedValue(undefined);
  const write = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  // 管理页卸载也走 purge（先清盘、成功后才撤记录），这里只断言它被调用。
  const purge = vi.fn().mockResolvedValue({ text: "已删除 2 个目录。" });
  const host = { isNative: () => true, openTool: open, writeToolArchive: write, stopTool: stop,
    dialogs: { saveFile: vi.fn().mockResolvedValue("E:/export.zip") } } as unknown as HostService;
  render(<ToolsPanel service={service} host={host} workshop={{ ...fakeWorkshop(), purge }} />);
  fireEvent.click(screen.getByRole("button", { name: "打开 JSON 格式化" }));
  // openTool 现在带安装记录里的运行副本目录（fakeWorkshop 默认合成一个）。
  await waitFor(() => expect(open).toHaveBeenCalledWith(sampleTool.id, `E:/AAW/tools/installed/${sampleTool.id}`));
  expect(document.querySelector("iframe")).toBeNull();
  openCardMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "管理" }));
  expect(screen.getByRole("button", { name: /自定义设置/ })).toHaveAttribute("aria-expanded", "true");
  fireEvent.change(screen.getByLabelText(/缩进空格数/), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  expect(service.saveSettings).toHaveBeenCalledWith(sampleTool.id, { indent: 4 });
  expandSection(/源码与开发/);
  fireEvent.click(screen.getByRole("button", { name: "导出源码 ZIP" }));
  await waitFor(() => expect(write).toHaveBeenCalled());
  const exported = importToolProject(write.mock.calls[0]![1] as Uint8Array);
  expect(exported.settingsSchema?.[0]?.default).toBe(2);
  expect(exported).not.toHaveProperty("settings");
  expect(exported.html).toBe(sampleTool.html);
  vi.mocked(host.dialogs.saveFile).mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole("button", { name: "导出源码 ZIP" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已取消导出"));
  expect(write).toHaveBeenCalledTimes(1);
  write.mockRejectedValueOnce(new Error("磁盘无法写入"));
  fireEvent.click(screen.getByRole("button", { name: "导出源码 ZIP" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("导出失败：磁盘无法写入"));
  expandSection(/卸载插件/);
  fireEvent.click(screen.getByRole("button", { name: "卸载" }));
  expect(purge).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认卸载" }));
  // 管理页的「卸载」与列表页勾了「同时删除文件」是同一件事：走 purge 先清盘，
  // 由它成功后再撤记录。以前这里只调 `service.remove`，运行副本、工具数据、
  // 密钥与备份全留在盘上——记录一没，界面上再没有能清掉它们的入口。
  await waitFor(() => expect(purge).toHaveBeenCalledWith(sampleTool.id));
  expect(service.remove).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("已卸载");
  // 卸载之后窗口不该继续活着：顺手走同一个停止通道把它关掉。
  expect(stop).toHaveBeenCalledWith(sampleTool.id);
});

/** 分区默认收起，只留摘要；来源目录是文本胶囊，界面不再写死不存在的文件。 */
it("collapses secondary sections and shows the source dir as a copyable text path", () => {
  const dir = "C:/Users/14993/AppData/Roaming/tools/projects/anonymous/json-formatter";
  render(<ToolManagement entry={{ package: sampleTool, sourceDir: dir }} onBack={vi.fn()} onOpen={vi.fn()}
    onExport={vi.fn()} onUpdate={vi.fn()} onSave={() => true} onRemove={vi.fn()} busy={false} />);
  expect(screen.getByRole("button", { name: /自定义设置/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /源码与开发/ })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: /AI 动作/ })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: /插件信息/ })).toHaveAttribute("aria-expanded", "false");
  expandSection(/源码与开发/);
  expect(document.querySelector(`[data-hint="${dir}"]`)).toBeTruthy();
  expect(screen.getByRole("button", { name: "复制路径" })).toBeTruthy();
  // 文件清单跟着导出器走：这个工具没有 AGENTS.md，界面就不该凭空写一个。
  expect(screen.getByText("README.md")).toBeTruthy();
  expect(screen.queryByText("AGENTS.md")).toBeNull();
});

/** AI 修不动时不能只留一句话：源码路径要看得见可复制，校验要能自己发起（docs 22 §4 P0-2）。 */
it("shows the source path and re-checking once AI gave up", () => {
  const state = createStore<readonly PersonalTool[]>(() => []);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true } as unknown as HostService;
  const verify = vi.fn().mockResolvedValue(null);
  const workshop = {
    ...fakeWorkshop({
      project: { dir: "E:/tools/demo", id: "demo", name: "演示" },
      // 展开的内容长在它那一行里：列表里得有这个项目，否则没有"行"可展开。
      projects: [{ dir: "E:/tools/demo", dirName: "demo", id: "demo", name: "演示", version: "1.0.0", hasHtml: true, network: false }],
      stalled: true,
      note: { text: "还有 2 个问题，AI 试了 3 轮也没修好。", error: true },
    }),
    verify,
  };
  render(<ToolsPanel service={service} host={host} workshop={workshop} />);
  fireEvent.click(screen.getByRole("button", { name: /开发工具/ }));
  expect(screen.getByText(/AI 试了 3 轮也没修好/)).toBeVisible();
  expect(screen.getByText("按这个路径自己改")).toBeVisible();
  // 路径是文本而不是按钮：完整值放在 data-hint 里，旁边有纯前端的复制入口。
  expect(document.querySelectorAll('[data-hint="E:/tools/demo"]').length).toBeGreaterThan(0);
  expect(screen.getAllByRole("button", { name: "复制路径" }).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "我改完了，重新校验" }));
  expect(verify).toHaveBeenCalledOnce();
});

/** 需求可以精心写，界面不再用「一句话」暗示只能随手写一句。 */
it("does not cap the brief to a single sentence, and drops the manual guide-sync module", () => {
  const state = createStore<readonly PersonalTool[]>(() => []);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true } as unknown as HostService;
  const { container } = render(<ToolsPanel service={service} host={host} workshop={fakeWorkshop()} />);
  fireEvent.click(screen.getByRole("button", { name: /开发工具/ }));
  expect(screen.getByLabelText("描述你要的工具")).toBeTruthy();
  expect(container.textContent).not.toContain("一句话描述你要的工具");
  expect(container.textContent).not.toContain("让 AI 也按这份指导做工具");
  expect(container.querySelector(".build-guide")).toBeNull();
});

/** 空状态是一个主 CTA + 两个统一尺寸的备选，不再是三种大小的按钮并排。 */
it("gives the empty library one primary CTA and two equally-sized alternatives", () => {
  const state = createStore<readonly PersonalTool[]>(() => []);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true } as unknown as HostService;
  const { container } = render(<ToolsPanel service={service} host={host} workshop={fakeWorkshop()} />);
  expect(container.querySelectorAll(".tools-empty-primary")).toHaveLength(1);
  expect(container.querySelectorAll(".tools-empty-alt")).toHaveLength(2);
  expect(container.querySelector(".tools-empty-examples")).toBeNull();
  expect(screen.getByRole("button", { name: "导入工具…" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "载入示例工具" })).toBeTruthy();
});

/** 导入只有一个入口：点「导入工具」弹菜单选 ZIP 还是文件夹（浏览器无文件夹项）。 */
it("routes both import kinds through a single menu entry", () => {
  const state = createStore<readonly PersonalTool[]>(() => []);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const importFromFolder = vi.fn(() => Promise.resolve({ text: "已导入。" }));
  const native = { isNative: () => true } as unknown as HostService;
  const workshop = { ...fakeWorkshop(), importFromFolder } as never;
  const first = render(<ToolsPanel service={service} host={native} workshop={workshop} />);
  // 头部不再有两个并排导入按钮：文件夹入口收进菜单。
  expect(screen.queryByRole("button", { name: "导入文件夹" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "导入工具" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "导入文件夹…" }));
  expect(importFromFolder).toHaveBeenCalledOnce();
  first.unmount();
  // 同一个菜单在浏览器宿主下不提供文件夹项：点了没用的项等于骗人。
  const web = { isNative: () => false } as unknown as HostService;
  render(<ToolsPanel service={service} host={web} workshop={workshop} />);
  fireEvent.click(screen.getByRole("button", { name: "导入工具" }));
  expect(screen.getByRole("menuitem", { name: "导入 ZIP 包…" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "导入文件夹…" })).toBeNull();
});

/**
 * 示例工具也必须走"物化一份完整副本再写记录"的安装链路（OBS-02）。
 *
 * 旧实现直接 `service.install()`：只写配置、不落盘，示例装完根本没有运行副本。
 * 主窗打开时会临时补一份，启动器小窗直接开就只能报一句路径。
 */
it("loads every example tool through the archive install path", async () => {
  const state = createStore<readonly PersonalTool[]>(() => []);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const installArchive = vi.fn((tool: ToolPackage) => Promise.resolve({ version: tool.version, updated: false, versionChanged: false }));
  const host = { isNative: () => true } as unknown as HostService;
  render(<ToolsPanel service={service} host={host} workshop={{ ...fakeWorkshop(), installArchive }} />);
  fireEvent.click(screen.getByRole("button", { name: "载入示例工具" }));
  await waitFor(() => expect(installArchive).toHaveBeenCalledTimes(exampleTools.length));
  expect(installArchive.mock.calls.map(([tool]) => tool.id)).toEqual(exampleTools.map((tool) => tool.id));
  expect(service.install).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent(`已载入 ${exampleTools.length} 个示例工具`);
});

/** 导入 ZIP 要把包里的文件一起交给安装链路，而不是只吞下清单。 */
it("installs an imported ZIP together with the files it carries", async () => {
  const state = createStore<readonly PersonalTool[]>(() => []);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const installArchive = vi.fn((tool: ToolPackage) => Promise.resolve({ version: tool.version, updated: false, versionChanged: false }));
  const host = { isNative: () => true } as unknown as HostService;
  const { container } = render(<ToolsPanel service={service} host={host} workshop={{ ...fakeWorkshop(), installArchive }} />);
  const bytes = exportToolProject(sampleTool, {});
  const zip = new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" });
  const file = new File([zip], `${sampleTool.id}.zip`, { type: "application/zip" });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  await waitFor(() => expect(installArchive).toHaveBeenCalledOnce());
  const [tool, files] = installArchive.mock.calls[0]! as unknown as [ToolPackage, Record<string, Uint8Array>];
  expect(tool.id).toBe(sampleTool.id);
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["manifest.json", "index.html"]));
  expect(screen.getByRole("status")).toHaveTextContent(sampleTool.name);
});

/** 常驻工具：关窗只是隐藏，所以列表要标明，菜单要留一条真出口。 */
it("marks background tools and offers a real stop from the card menu", async () => {
  const tool = { ...sampleTool, background: { reason: "剪切板历史" } };
  const state = createStore<readonly PersonalTool[]>(() => [{ package: tool }]);
  const stopTool = vi.fn(async () => {});
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true, stopTool } as unknown as HostService;
  render(<ToolsPanel service={service} host={host} workshop={fakeWorkshop()} />);
  expect(screen.getByText("后台")).toBeVisible();
  openCardMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "停止后台运行" }));
  await waitFor(() => expect(stopTool).toHaveBeenCalledExactlyOnceWith(tool.id));
  expect(screen.getByRole("status")).toHaveTextContent("已停止该工具的后台运行");
});

/** 非常驻工具不该出现「停止后台运行」：菜单里放一条点了没用的项等于骗人。 */
it("does not offer the background stop for tools that never keep running", () => {
  const state = createStore<readonly PersonalTool[]>(() => [{ package: sampleTool }]);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true } as unknown as HostService;
  render(<ToolsPanel service={service} host={host} workshop={fakeWorkshop()} />);
  openCardMenu();
  expect(screen.queryByRole("menuitem", { name: "停止后台运行" })).toBeNull();
});

/** 常驻挂载之后，重新可见是唯一的刷新时机：不然 AI 刚写完的项目永远不露面。 */
it("refreshes the project list whenever the panel becomes visible again", () => {
  const state = createStore<readonly PersonalTool[]>(() => []);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true } as unknown as HostService;
  const refreshProjects = vi.fn(() => Promise.resolve());
  const workshop = { ...fakeWorkshop(), refreshProjects };
  const panel = render(<ToolsPanel service={service} host={host} workshop={workshop} visible={false} />);
  expect(refreshProjects).not.toHaveBeenCalled();
  panel.rerender(<ToolsPanel service={service} host={host} workshop={workshop} visible />);
  expect(refreshProjects).toHaveBeenCalledOnce();
});

/**
 * 一个项目只占一行：展开的内容长在它自己的行里，不再是另一张浮动卡片。
 *
 * 点开 = 处理这个项目；再点一次 = 收起。没有第三条"关不掉"的路径。
 */
it("keeps one row per project and expands only the open one", () => {
  const state = createStore<readonly PersonalTool[]>(() => []);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true } as unknown as HostService;
  const select = vi.fn(() => Promise.resolve());
  const dismiss = vi.fn();
  const workshop = {
    ...fakeWorkshop({
      project: { dir: "E:/tools/a", id: "a", name: "甲" },
      check: { ready: true, blocking: [], warnings: [], tool: sampleTool },
      projects: [
        { dir: "E:/tools/a", dirName: "a", id: "a", name: "甲", version: "1.0.0", hasHtml: true, network: false },
        { dir: "E:/tools/b", dirName: "b", id: "b", name: "乙", version: "0.2.0", hasHtml: true, network: false },
      ],
    }),
    select,
    dismiss,
  } as never;

  render(<ToolsPanel service={service} host={host} workshop={workshop} />);
  fireEvent.click(screen.getByRole("button", { name: /开发工具/ }));

  // 两行各一个；展开的只有「甲」——「源码位置」只在展开内容里出现一次。
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getAllByText("源码位置")).toHaveLength(1);
  // 「乙」是收起态：动作只有最常做的两个。
  const rowB = screen.getByRole("button", { name: "乙" });
  expect(rowB).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(rowB);
  expect(select).toHaveBeenCalledWith("E:/tools/b");
  fireEvent.click(screen.getByRole("button", { name: "甲" }));
  expect(dismiss).toHaveBeenCalledOnce();
});

/**
 * 还没读出结论时，展开行不能是一整块灰按钮。
 *
 * 新建项目的那几秒（以及清单读坏的时候）`check` 是 null。三个动作都用它
 * 做 disabled，于是「继续开发」也点不了——而它恰恰是回去让 AI 修的唯一入口。
 */
it("keeps project actions usable before the first check lands", () => {
  const dir = "E:/tools/brand-new";
  const state = createStore<readonly PersonalTool[]>(() => []);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true } as unknown as HostService;
  const verify = vi.fn().mockResolvedValue(null);
  const workshop = {
    ...fakeWorkshop({
      project: { dir, id: "brand-new", name: "新建的工具" },
      projects: [{ dir, dirName: "brand-new", id: "brand-new", name: "新建的工具", version: "", hasHtml: true, network: false }],
      check: null,
    }),
    verify,
  };
  render(<ToolsPanel service={service} host={host} workshop={workshop} />);
  fireEvent.click(screen.getByRole("button", { name: /开发工具/ }));

  expect(screen.getByRole("button", { name: "继续开发" })).toBeEnabled();
  // 没有结论时也要有重新读一次的出口，否则只能靠等。
  fireEvent.click(screen.getByRole("button", { name: "重新校验" }));
  expect(verify).toHaveBeenCalledOnce();
  // 还没读盘不能断言"没有 index.html"——那会让用户以为 AI 什么都没写。
  expect(screen.queryByText("还没有 index.html")).toBeNull();
});

/**
 * 带文件删除的卸载是"先清磁盘、成功后才撤记录"。
 *
 * 顺序反过来的话（先 remove 再 purge），清理失败（目录被占用、权限不足）会让卡片
 * 从列表里消失、几十上百 MB 却留在盘上——用户连重试的入口都没有了。
 */
it("keeps the tool listed when file cleanup fails during uninstall", async () => {
  const state = createStore<readonly PersonalTool[]>(() => [{ package: sampleTool }]);
  const service = { state, install: vi.fn(), rollback: vi.fn(), setRunDir: vi.fn(), setSourceDir: vi.fn(), open: vi.fn(), remove: vi.fn(), saveSettings: vi.fn() } satisfies ToolsService;
  const host = { isNative: () => true, stopTool: vi.fn().mockResolvedValue(undefined) } as unknown as HostService;
  const purge = vi.fn().mockResolvedValue({ text: "清理失败：目录被占用", error: true });
  render(<ToolsPanel service={service} host={host} workshop={{ ...fakeWorkshop(), purge }} />);

  openCardMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "卸载" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /同时删除项目目录与工具数据/ }));
  fireEvent.click(screen.getByRole("button", { name: "卸载" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("清理失败：目录被占用"));
  expect(purge).toHaveBeenCalledWith(sampleTool.id);
  // 记录不能先撤：撤了列表就空了，用户没地方重试。
  expect(service.remove).not.toHaveBeenCalled();
  expect(screen.getByRole("list", { name: "已安装工具" })).toBeVisible();
  expect(screen.getByText("JSON 格式化")).toBeVisible();
});
