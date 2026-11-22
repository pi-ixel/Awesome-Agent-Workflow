import { createRoot } from "react-dom/client";
import { createStore } from "zustand";
import { ToolsPanel } from "../../src/plugins/tools/ui/ToolsPanel.tsx";
import { ToolsPanelSurface } from "../../src/plugins/tools/ui/surface.tsx";
import { sampleTool } from "../../src/plugins/tools/ui/sample.ts";
import { resolveToolSettings } from "../../src/plugins/tools/runtime/settings.ts";
import type { PersonalTool } from "../../src/plugins/tools/types.ts";
import type { ToolsService } from "../../src/plugins/tools/service.ts";
import { fakeWorkshop } from "../plugins/tools/fakeWorkshop.ts";
import type { HostService } from "../../src/plugins/host/service.ts";
import "../../src/shared/styles/index.css";

const params = new URLSearchParams(location.search);
if (params.has("warm")) document.documentElement.classList.add("theme-warm");
// `?empty` 摆出"一个工具都没有"的首次使用现场：空状态不是一行灰字就够，
// 得在真实渲染里看三步引导挤不挤、主按钮够不够醒目。
const entries: PersonalTool[] = params.has("empty") ? [] : [
  { package: { ...sampleTool, settingsSchema: [
    ...sampleTool.settingsSchema!,
    { id: "label", label: "工作区名称", type: "text", default: "我的工作区" },
    { id: "sort", label: "排序方式", type: "select", default: "original", options: [{ value: "original", label: "保持原序" }, { value: "alpha", label: "按名称排序" }] },
    { id: "copy", label: "处理后自动复制", type: "boolean", default: false },
  ] },
    // 真实安装都会记下来源目录。特意用一条长路径：它曾把管理页撑出横向滚动条。
    dir: "C:/Users/14993/AppData/Roaming/tools/projects/anonymous/json-formatter" },
  { package: { ...sampleTool, id: "legacy-tool", name: "未声明设置的工具", settingsSchema: [] } },
  // 再多几个：紧凑列表的价值就在于"一屏能看七八个"，只有三个工具看不出密度。
  ...["Markdown 导出", "CSV 拆分", "时间戳转换", "正则测试", "颜色取值", "URL 解析"].map((name, at) => ({
    package: { ...sampleTool, id: `extra-tool-${at + 1}`, name, settingsSchema: [] },
  })),
];
const state = createStore<readonly PersonalTool[]>(() => entries);
const service: ToolsService = {
  state,
  // 真的写进状态：视觉用例要能验证「载入示例工具」之后列表确实长出来。
  install: (tool) => {
    state.setState((current) => current.some((entry) => entry.package.id === tool.id)
      ? current
      : [...current, { package: tool, installedAt: Date.now() }], true);
    return Promise.resolve({ version: tool.version, updated: false, versionChanged: false });
  },
  rollback: () => Promise.resolve(undefined),
  setRunDir: () => {},
  setSourceDir: () => {},
  open: () => {}, remove: () => Promise.resolve(),
  saveSettings: (id, values) => state.setState(state.getState().map((entry) => entry.package.id === id ? { ...entry, settings: resolveToolSettings(entry.package, values) } : entry), true),
};
const host = {
  isNative: () => !new URLSearchParams(location.search).has("web"),
  openTool: async () => {},
  stopTool: async () => {},
  openToolsGuide: async () => {},
} as unknown as HostService;
// `?stalled` 摆出"AI 修不动了"的交接态：360px 下两个按钮加一段说明会不会挤，
// 只能看真实渲染。
const jsonTable = {
  dir: "E:/AAW/tools/projects/u1/json-table",
  dirName: "json-table",
  id: "json-table",
  name: "接口 JSON 转表格",
  version: "1.2.0",
  hasHtml: true,
  network: false,
};
const otherProjects = [
  { dir: "E:/AAW/tools/projects/u1/markdown-export", dirName: "markdown-export", id: "markdown-export", name: "Markdown 导出", version: "0.3.1", hasHtml: true, network: false },
  { dir: "E:/AAW/tools/projects/u1/timestamp", dirName: "timestamp", id: "timestamp", name: "时间戳转换", version: "", hasHtml: false, network: false },
];
const workshop = fakeWorkshop(params.has("stalled") ? {
  project: { dir: jsonTable.dir, id: jsonTable.id, name: jsonTable.name },
  stalled: true,
  note: { text: "还有 2 个问题，AI 试了 3 轮也没修好。", error: true },
  projects: [jsonTable],
  check: {
    tool: sampleTool,
    ready: false,
    blocking: [
      { ruleId: "R3", level: "block", where: "index.html", message: "清单里声明了动作 run，页面里没有实现", hint: "在页面里挂 window.aawActions.run" },
      { ruleId: "R1", level: "block", message: "改了 id", hint: "别改 id" },
    ],
    warnings: [],
  },
} : params.has("projects") ? {
  // 多项目现场：只展开一行，其余收起后只剩标题 + 两个最常做的动作。
  project: { dir: jsonTable.dir, id: jsonTable.id, name: jsonTable.name },
  projects: [jsonTable, ...otherProjects],
  check: {
    tool: { ...sampleTool, id: jsonTable.id, name: jsonTable.name, version: jsonTable.version },
    ready: true,
    blocking: [],
    warnings: [],
  },
} : params.has("blank") ? {
  // 刚建好的项目：目录已经写出来了，列表扫描还没回来（所以是合成行），
  // 结论也还没到。这是最容易变成"一整块灰按钮 + 还没有 index.html"的一刻。
  project: { dir: jsonTable.dir, id: jsonTable.id, name: jsonTable.name },
  projects: [...otherProjects],
  check: null,
} : {});
createRoot(document.getElementById("root")!).render(
  // 和真实应用一样挂进外壳里（`ToolsPanelSurface` 就是 workbench.tsx 里那个）。
  // 以前夹具直接把面板塞进 <main>：父级是 block，面板必然满宽，于是「面板在
  // 横排 flex 里塌成一条竖条」这种 bug 永远拍不出来。
  <main style={{ height: "100vh" }}>
    <ToolsPanelSurface visible>
      <ToolsPanel service={service} host={host} workshop={workshop} />
    </ToolsPanelSurface>
  </main>,
);
