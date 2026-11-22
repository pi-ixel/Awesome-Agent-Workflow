import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { installDesktopWorkbench } from "../../../src/bootstrap/installDesktopWorkbench.ts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Feedback } from "../../../src/shared/ui/feedback.ts";
import { expect, it, vi } from "vitest";
import type {
  SkillCatalog,
  NativeSkillLibrary,
} from "../../../src/plugins/host/types.ts";
import { SkillLibrary } from "../../../src/plugins/skills/ui/SkillLibrary.tsx";
import { codeAgentSkillPackages } from "../../../src/plugins/agents/enhancements/codeagent/skillPackages.ts";
const root = "C:/Users/test/.cac/skills";
const skill = {
  name: "sample",
  source: root,
  path: root + "/sample",
  description: "样例",
  realPath: root + "/sample",
  preview: "正文",
  status: "正常",
  kind: "directory" as const,
  isLink: false,
  revision: "r1",
  usageCount: null,
};
const catalog: SkillCatalog = {
  profile: null,
  profiles: [],
  sources: [
    {
      path: root,
      label: ".cac",
      project: null,
      kind: "directory",
      enabled: true,
      canImport: true,
    },
  ],
  entries: [skill],
  trash: [],
  warnings: [],
};

it("启停只替换选中的技能，复用所在卡片和目录大小", async () => {
  const sibling = {
    ...skill,
    name: "other",
    path: root + "/other",
    realPath: root + "/other",
  };
  const stored = {
    id: "stopped",
    name: skill.name,
    description: skill.description,
    source: skill.source,
    path: skill.path,
    kind: skill.kind,
  };
  const list = vi
    .fn()
    .mockResolvedValue({ ...catalog, entries: [skill, sibling] });
  const toggle = vi
    .fn<NonNullable<NativeSkillLibrary["toggle"]>>()
    .mockResolvedValueOnce({
      message: "sample · 已停用",
      stopped: stored,
      entry: null,
    })
    .mockResolvedValueOnce({
      message: "sample · 已恢复",
      stopped: null,
      entry: { ...skill, revision: "r2" },
    });
  render(
    <SkillLibrary
      library={{
        list,
        toggle,
        candidates: () => Promise.resolve([]),
        change: () => Promise.resolve([]),
        sizes: (_query, selections) =>
          Promise.resolve(selections.map(() => 1024)),
      }}
      provider="codeagent"
      storage={window.localStorage}
      knownProjects={() => []}
      pick={() => Promise.resolve(null)}
      reveal={() => Promise.resolve()}
    />,
  );
  const card = await screen.findByRole("article", { name: "sample" });
  const other = screen.getByRole("article", { name: "other" });
  const control = within(card).getByRole("switch");
  await within(other).findByText(".cac · 1.0 KiB");
  await userEvent.click(control);
  await waitFor(() => expect(control).not.toBeChecked());
  expect(await screen.findByRole("article", { name: "sample" })).toBe(card);
  expect(screen.getByRole("article", { name: "other" })).toBe(other);
  expect(within(other).getByText(".cac · 1.0 KiB")).toBeVisible();
  expect(within(other).getByRole("switch")).toBeEnabled();
  await userEvent.click(control);
  await waitFor(() => expect(control).toBeChecked());
  expect(list).toHaveBeenCalledTimes(1);
  expect(toggle).toHaveBeenCalledTimes(2);
});

it("先显示技能卡片，随后补充当前列表的目录大小", async () => {
  let resolveSize!: (bytes: (number | null)[]) => void;
  const sizes = vi
    .fn<NonNullable<NativeSkillLibrary["sizes"]>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSize = resolve;
        }),
    )
    .mockResolvedValue([3072]);
  render(
    <SkillLibrary
      library={{
        list: () => Promise.resolve(catalog),
        candidates: () => Promise.resolve([]),
        change: () => Promise.resolve([]),
        sizes,
      }}
      provider="codeagent"
      storage={window.localStorage}
      knownProjects={() => []}
      pick={() => Promise.resolve(null)}
      reveal={() => Promise.resolve()}
    />,
  );
  const card = await screen.findByRole("article", { name: "sample" });
  expect(within(card).getByText(".cac")).toBeVisible();
  await waitFor(() => expect(sizes).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(await within(card).findByText(".cac · 3.0 KiB")).toBeVisible();
  await act(() => {
    resolveSize([512]);
    return Promise.resolve();
  });
  expect(within(card).queryByText(/512 B/)).toBeNull();
});

it("分批读取启用和停用技能的大小，后续批次失败时保留已有结果", async () => {
  const entries = Array.from({ length: 16 }, (_, index) => {
    const path = `${root}/skill-${index}`;
    return { ...skill, name: `技能 ${index}`, path, realPath: path };
  });
  const stopped = {
    ...skill,
    name: "停用技能",
    id: "stopped",
    path: `${root}/stopped`,
  };
  const unavailable = {
    ...stopped,
    name: "失效技能",
    id: "unavailable",
    unavailable: "原目录不可用",
  };
  const data: SkillCatalog = {
    ...catalog,
    entries: [...entries, { ...skill, kind: "inline", name: "配置技能" }],
    trash: [stopped, unavailable],
  };
  const sizes = vi
    .fn<NonNullable<NativeSkillLibrary["sizes"]>>()
    .mockResolvedValueOnce(entries.map(() => 1024))
    .mockRejectedValueOnce(new Error("读取失败"));
  render(
    <SkillLibrary
      library={{
        list: () => Promise.resolve(data),
        candidates: () => Promise.resolve([]),
        change: () => Promise.resolve([]),
        sizes,
      }}
      provider="codeagent"
      storage={window.localStorage}
      knownProjects={() => []}
      pick={() => Promise.resolve(null)}
      reveal={() => Promise.resolve()}
    />,
  );
  const first = within(await screen.findByRole("article", { name: "技能 0" }));
  expect(await first.findByText(".cac · 1.0 KiB")).toBeVisible();
  expect(sizes.mock.calls.map(([, batch]) => batch.length)).toEqual([16, 1]);
  expect(sizes.mock.calls[1]?.[1]).toEqual([
    {
      source: root,
      path: stopped.path,
      realPath: stopped.path,
      disabledId: stopped.id,
    },
  ]);
  expect(screen.getByRole("article", { name: "停用技能" })).toBeVisible();
  expect(first.getByText(".cac · 1.0 KiB")).toBeVisible();
});

it("详情浏览真实目录，在同一弹窗切换并复制完整原文", async () => {
  const user = userEvent.setup();
  const main = "---\r\nname: sample\r\n---\r\n# 真正文\r\n\r\n## 审查\r\n";
  const example = '{"enabled":true}\r\n';
  const files = vi.fn<NonNullable<NativeSkillLibrary["files"]>>(
    (_query, _entry, request) => {
      if (request.type === "directory") {
        return Promise.resolve({
          type: "directory",
          truncated: false,
          entries:
            request.path === "templates"
              ? [{ name: "example.json", kind: "file", bytes: 18 }]
              : [
                  { name: "templates", kind: "directory", bytes: null },
                  { name: "SKILL.md", kind: "file", bytes: main.length },
                  { name: "external", kind: "unavailable", bytes: null },
                ],
        });
      }
      return Promise.resolve({
        type: "text",
        text: request.path === "SKILL.md" ? main : example,
        modifiedAt: Date.UTC(2026, 10, 20),
      });
    },
  );
  render(
    <SkillLibrary
      library={{
        list: () => Promise.resolve(catalog),
        candidates: () => Promise.resolve([]),
        change: () => Promise.resolve([]),
        files,
      }}
      provider="codeagent"
      storage={window.localStorage}
      knownProjects={() => []}
      pick={() => Promise.resolve(null)}
      reveal={() => Promise.resolve()}
    />,
  );
  const opener = await screen.findByRole("button", {
    name: "查看 sample 详情",
  });
  await user.click(opener);
  const dialog = within(screen.getByRole("dialog", { name: "技能详情" }));
  expect(
    await dialog.findByRole("region", { name: "SKILL.md 正文" }),
  ).toBeVisible();
  const copy = dialog.getByRole("button", { name: "复制 SKILL.md" });
  const idleGlyph = copy.querySelector("svg path")?.getAttribute("d");
  expect(idleGlyph).toBeTruthy();
  await user.click(copy);
  expect(await navigator.clipboard.readText()).toBe(main);
  await waitFor(() => expect(copy).toHaveTextContent("已复制 SKILL.md"));
  expect(copy.querySelector("svg path")?.getAttribute("d")).not.toBe(idleGlyph);
  await user.click(dialog.getByRole("button", { name: "原文" }));
  const original = dialog.getByRole("region", { name: "SKILL.md 原文" });
  expect(original.querySelector("pre[aria-hidden=true]")).toHaveTextContent(
    "1 2 3 4 5 6 7",
  );
  expect(dialog.getByRole("button", { name: /external/ })).toBeDisabled();
  await user.click(dialog.getByRole("button", { name: "templates" }));
  await user.click(await dialog.findByRole("button", { name: /example.json/ }));
  expect(
    await dialog.findByRole("region", { name: "templates/example.json 原文" }),
  ).toHaveTextContent(example.trim());
  expect(dialog.queryByRole("group", { name: "文档显示方式" })).toBeNull();
  expect(dialog.getByText("最近更新")).toBeInTheDocument();
  expect(files).toHaveBeenCalledWith(
    { provider: "codeagent", profile: null, projects: [] },
    expect.objectContaining({ path: skill.path, realPath: skill.realPath }),
    { type: "read", path: "templates/example.json" },
  );
  await user.keyboard("{Escape}");
  expect(opener).toHaveFocus();
});

it("切换文件后，迟到的预览不会替换当前正文或复制内容", async () => {
  const user = userEvent.setup();
  type TextFile = { type: "text"; text: string; modifiedAt: null };
  let finishFirst!: (result: TextFile) => void;
  const first = new Promise<TextFile>((resolve) => {
    finishFirst = resolve;
  });
  const exact = '{"version":2}\r\n';
  const files = vi.fn<NonNullable<NativeSkillLibrary["files"]>>(
    (_query, _entry, request) => {
      if (request.type === "directory")
        return Promise.resolve({
          type: "directory",
          truncated: false,
          entries: ["first.json", "second.json"].map((name) => ({
            name,
            kind: "file",
            bytes: 20,
          })),
        });
      if (request.path === "first.json") return first;
      return Promise.resolve({
        type: "text",
        text: request.path === "second.json" ? exact : "# 技能",
        modifiedAt: null,
      });
    },
  );
  render(
    <SkillLibrary
      library={{
        list: () => Promise.resolve(catalog),
        candidates: () => Promise.resolve([]),
        change: () => Promise.resolve([]),
        files,
      }}
      provider="codeagent"
      storage={window.localStorage}
      knownProjects={() => []}
      pick={() => Promise.resolve(null)}
      reveal={() => Promise.resolve()}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "查看 sample 详情" }),
  );
  const dialog = within(screen.getByRole("dialog", { name: "技能详情" }));
  await user.click(await dialog.findByRole("button", { name: /first\.json/ }));
  expect(
    dialog.queryByRole("button", { name: /^(复制原文|复制 SKILL\.md)$/ }),
  ).toBeNull();
  await user.click(dialog.getByRole("button", { name: /second\.json/ }));
  await act(async () => {
    finishFirst({ type: "text", text: '{"version":1}', modifiedAt: null });
    await first;
  });
  expect(
    await dialog.findByRole("region", { name: "second.json 原文" }),
  ).toHaveTextContent(exact.trim());
  await user.click(dialog.getByRole("button", { name: "复制原文" }));
  expect(await navigator.clipboard.readText()).toBe(exact);
});

it("配置内技能只展示当前定义且不请求目录文件", async () => {
  const files = vi.fn<NonNullable<NativeSkillLibrary["files"]>>();
  const inline = {
    ...skill,
    kind: "inline" as const,
    preview: "name: sample\ndescription: 样例",
    status: "配置内定义",
  };
  render(
    <SkillLibrary
      library={{
        list: () => Promise.resolve({ ...catalog, entries: [inline] }),
        candidates: () => Promise.resolve([]),
        change: () => Promise.resolve([]),
        files,
      }}
      provider="icode"
      storage={window.localStorage}
      knownProjects={() => []}
      pick={() => Promise.resolve(null)}
      reveal={() => Promise.resolve()}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "查看 sample 详情" }),
  );
  const dialog = within(screen.getByRole("dialog", { name: "技能详情" }));
  expect(
    dialog.getByRole("region", { name: "配置定义 原文" }),
  ).toHaveTextContent("name: sample");
  expect(dialog.getByRole("button", { name: "定位配置" })).toBeVisible();
  expect(dialog.queryByText("目录文件")).toBeNull();
  expect(files).not.toHaveBeenCalled();
});
it("旧回收记录作为停用卡片，可查看原文、恢复或删除", async () => {
  const data = {
    ...catalog,
    trash: [
      {
        ...skill,
        id: "old",
        name: "旧技能",
        kind: "inline" as const,
        description: "旧版说明",
        preview: "name: archived",
      },
    ],
  };
  const change = vi
    .fn<NativeSkillLibrary["change"]>()
    .mockResolvedValue(["已跳过，同名配置已存在"]);
  const user = userEvent.setup();
  render(
    <SkillLibrary
      library={{
        list: () => Promise.resolve(data),
        candidates: () => Promise.resolve([]),
        change,
      }}
      provider="icode"
      storage={window.localStorage}
      knownProjects={() => []}
      pick={() => Promise.resolve(null)}
      reveal={async () => {}}
    />,
  );
  await user.click(await screen.findByRole("combobox", { name: "技能状态" }));
  await user.click(screen.getByRole("option", { name: "已停用" }));
  const card = await screen.findByRole("article", { name: "旧技能" });
  expect(screen.queryByRole("article", { name: "sample" })).toBeNull();
  expect(within(card).getByText("旧版说明")).toBeVisible();
  await user.click(
    within(card).getByRole("button", { name: "查看 旧技能 详情" }),
  );
  const detail = screen.getByRole("dialog", { name: "技能详情" });
  expect(
    within(detail).getByRole("region", { name: "配置定义 原文" }),
  ).toHaveTextContent("name: archived");
  expect(within(detail).queryByRole("button", { name: "定位配置" })).toBeNull();
  await user.keyboard("{Escape}");
  const control = within(card).getByRole("switch", { name: "旧技能 启用" });
  expect(control).not.toBeChecked();
  await user.click(control);
  expect(change).toHaveBeenCalledWith(
    { provider: "icode", profile: null, projects: [] },
    { type: "restore", ids: ["old"] },
  );
  expect(await screen.findByText(/同名配置已存在/)).toBeVisible();
  expect(control).not.toBeChecked();
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(within(card).getByRole("button", { name: "旧技能 删除" }));
  await user.click(screen.getByRole("button", { name: "永久删除" }));
  expect(change).toHaveBeenLastCalledWith(
    { provider: "icode", profile: null, projects: [] },
    { type: "purge", ids: ["old"] },
  );
});
it("从设置切换 Agent 时只请求当前来源，忽略旧请求及未适配的 Agent", async () => {
  let finishFirst!: (data: SkillCatalog) => void;
  const list = vi
    .fn<NativeSkillLibrary["list"]>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockResolvedValue(catalog);
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    async (ctx) => {
      Object.assign(ctx.host.skills, { library: { list } });
      await installDesktopWorkbench(ctx);
    },
  );
  try {
    const { workbench } = await runtime.ready;
    const agents = runtime.agents!;
    agents.select("chrys");
    const WorkArea = workbench
      .getSnapshot()
      .sidebar.find((entry) => entry.id === "plugin-management")!.WorkArea!;
    const view = render(<WorkArea project={null} />);
    expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull();
    expect(list.mock.calls.map(([q]) => q.provider)).toEqual(["icode"]);
    act(() => agents.select("codeagent"));
    await screen.findByRole("article", { name: "sample" });
    await act(async () => {
      finishFirst({ ...catalog, entries: [] });
      await Promise.resolve();
    });
    expect(screen.getByRole("article", { name: "sample" })).toBeInTheDocument();
    act(() => {
      expect(agents.addCustomAgent("无技能管理", "custom-agent")).toBeNull();
      agents.select(
        agents.configuration
          .getState()
          .agents.find((a) => a.name === "无技能管理")!.id,
      );
    });
    expect(screen.getByText(/暂未提供技能管理/)).toBeInTheDocument();
    expect(list.mock.calls.map(([q]) => q.provider)).toEqual([
      "icode",
      "codeagent",
    ]);
    view.unmount();
  } finally {
    await runtime.shutdown();
  }
});
it("导入前显示目标目录，批量操作只提交勾选的名称", async () => {
  const change = vi
    .fn<NativeSkillLibrary["change"]>()
    .mockResolvedValue(["sample · 已跳过，目标已存在"]);
  render(
    <SkillLibrary
      library={{
        list: () => Promise.resolve(catalog),
        candidates: () => Promise.resolve(["sample", "extra"]),
        change,
      }}
      provider="codeagent"
      storage={window.localStorage}
      knownProjects={() => ["D:/project"]}
      pick={() => Promise.resolve("D:/source")}
      reveal={async () => {}}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "导入技能" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "选择导入技能" });
  expect(within(dialog).getByText(root, { exact: false })).toBeInTheDocument();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "extra" }),
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "导入所选" }),
  );
  expect(change).toHaveBeenCalledWith(
    { provider: "codeagent", profile: null, projects: ["D:/project"] },
    {
      type: "import",
      from: "D:/source",
      destination: root,
      enable: false,
      names: ["sample"],
    },
  );
  expect(await screen.findByText(/sample · 已跳过/)).toBeInTheDocument();
});
it("同名技能按来源查看和删除，路径操作在详情工作台", async () => {
  const change = vi
    .fn<NativeSkillLibrary["change"]>()
    .mockResolvedValue(["已永久删除"]);
  const alt = root.replace(".cac", ".agents");
  const data = {
    ...catalog,
    profile: "Code.yaml",
    profiles: ["Code.yaml"],
    sources: [catalog.sources[0]!, { ...catalog.sources[0]!, path: alt }],
    entries: [
      skill,
      { ...skill, source: alt, path: alt + "/sample", isLink: true },
    ],
  };
  const notify = vi.fn();
  const reveal = vi.fn(() => Promise.resolve());
  render(
    <Feedback.Provider value={notify}>
      <SkillLibrary
        library={{
          list: () => Promise.resolve(data),
          candidates: () => Promise.resolve([]),
          change,
        }}
        provider="icode"
        storage={window.localStorage}
        knownProjects={() => []}
        pick={() => Promise.resolve(null)}
        reveal={reveal}
      />
    </Feedback.Provider>,
  );
  const cards = await screen.findAllByRole("article", { name: "sample" });
  const user = userEvent.setup();
  await user.click(
    within(cards[1]!).getByRole("switch", { name: "sample 启用" }),
  );
  const sharedConfirm = within(
    screen.getByRole("dialog", { name: "确认技能操作" }),
  );
  expect(sharedConfirm.getByText(/共用此目录的 Agent 下次加载/)).toBeVisible();
  await user.keyboard("{Escape}");
  expect(change).not.toHaveBeenCalled();
  const more = within(cards[1]!).getByRole("button", {
    name: "sample 更多操作",
  });
  await user.click(more);
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["查看详情"]);
  await user.click(screen.getByRole("menuitem", { name: "查看详情" }));
  const detail = within(screen.getByRole("dialog", { name: "技能详情" }));
  expect(detail.getByText(alt + "/sample")).toBeInTheDocument();
  await user.click(detail.getByRole("button", { name: "打开目录" }));
  expect(reveal).toHaveBeenCalledWith(alt + "/sample", "open-directory");
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await user.click(detail.getByRole("button", { name: "复制路径" }));
  expect(write).toHaveBeenCalledWith(alt + "/sample");
  expect(notify).toHaveBeenCalledWith({
    message: "已复制",
    variant: "ok",
    dedupeKey: "skill-path-copy",
  });
  write.mockRestore();
  await user.keyboard("{Escape}");
  expect(more).toHaveFocus();
  const remove = within(cards[1]!).getByRole("button", { name: "sample 删除" });
  await user.click(remove);
  const dialog = within(screen.getByRole("dialog", { name: "确认技能操作" }));
  expect(dialog.getByText(/仅删除本条链接/)).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(change).not.toHaveBeenCalled();
  await user.click(remove);
  await user.click(screen.getByRole("button", { name: "永久删除" }));
  expect(change).toHaveBeenCalledWith(
    { provider: "icode", profile: "Code.yaml", projects: [] },
    {
      type: "deletePermanent",
      item: { path: alt + "/sample", revision: "r1", name: "sample" },
    },
  );
});
it("全局分区优先，同一项目的多个来源合并，搜索和刷新保持顺序", async () => {
  const projects = ["D:/pinned", "D:/recent"];
  const source = catalog.sources[0]!;
  const sources = [
    { ...source, project: projects[1]!, path: "D:/recent/.agents/skills" },
    { ...source, project: projects[0]!, path: "D:/pinned/.agents/skills" },
    { ...source, project: "d:/PINNED", path: "D:/pinned/.claude/skills" },
    source,
  ];
  const data = {
    ...catalog,
    sources,
    entries: sources.map((s) => ({
      ...skill,
      source: s.path,
      path: s.path + "/sample",
    })),
  };
  const list = vi.fn(() => Promise.resolve(data));
  render(
    <SkillLibrary
      library={{
        list,
        candidates: () => Promise.resolve([]),
        change: () => Promise.resolve([]),
      }}
      provider="icode"
      storage={window.localStorage}
      knownProjects={() => projects}
      pick={() => Promise.resolve(null)}
      reveal={() => Promise.resolve()}
    />,
  );
  async function expectOrder() {
    await screen.findByRole("region", { name: "全局技能" });
    const sections = within(
      screen.getByRole("region", { name: "技能管理" }),
    ).getAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual([
      "全局技能",
      ...projects,
    ]);
    expect(within(sections[1]!).getAllByRole("article")).toHaveLength(2);
  }
  await expectOrder();
  await userEvent.type(
    screen.getByRole("textbox", { name: "搜索技能" }),
    "sam",
  );
  await expectOrder();
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  await expectOrder();
  expect(list).toHaveBeenCalledTimes(2);
});
it("插件包开关只停用当前技能，其他技能保持启用", async () => {
  const source = "C:/Users/test/.cac/plugins/cache/local/tools/1.0/skills";
  const entry = {
    ...skill,
    kind: "package" as const,
    source,
    path: source + "/sample",
    realPath: source + "/sample",
  };
  const sibling = {
    ...entry,
    name: "other",
    path: source + "/other",
    realPath: source + "/other",
  };
  const data = {
    ...catalog,
    entries: [entry, sibling],
    sources: [
      {
        ...catalog.sources[0]!,
        path: source,
        kind: "package" as const,
        canImport: false,
      },
    ],
  };
  const list = vi
    .fn<NativeSkillLibrary["list"]>()
    .mockResolvedValueOnce(data)
    .mockResolvedValue({
      ...data,
      entries: [sibling],
      trash: [{ ...entry, id: "paused" }],
    });
  const change = vi.fn<NativeSkillLibrary["change"]>().mockResolvedValue([]);
  render(
    <SkillLibrary
      library={{ list, candidates: () => Promise.resolve([]), change }}
      provider="codeagent"
      storage={window.localStorage}
      knownProjects={() => []}
      pick={() => Promise.resolve(null)}
      reveal={async () => {}}
    />,
  );
  const control = await screen.findByRole("switch", { name: "sample 启用" });
  expect(control).toBeChecked();
  await userEvent.click(control);
  expect(change).toHaveBeenCalledWith(
    { provider: "codeagent", profile: null, projects: [] },
    {
      type: "delete",
      items: [{ name: entry.name, path: entry.path, revision: entry.revision }],
    },
  );
  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "sample 启用" }),
    ).not.toBeChecked(),
  );
  expect(screen.getByRole("switch", { name: "other 启用" })).toBeChecked();
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("保留已卸载插件包记录的原生重装能力", async () => {
  let items = [
    { id: "tools@local", scope: "user", installPath: "C:/plugins/tools" },
  ];
  const runCommand = vi.fn((_program: string, args: readonly string[]) =>
    Promise.resolve({
      code: 0,
      stderr: "",
      stdout: args.includes("--help")
        ? "plugin list install --json --scope"
        : JSON.stringify(items),
    }),
  );
  const packages = codeAgentSkillPackages(
    { pathExists: () => Promise.resolve(true), runCommand },
    "codeagent",
  );
  const pkg = { id: "tools@local", path: "C:/plugins/tools" };
  await expect(packages.install(pkg)).resolves.toContain("已跳过");
  items = [];
  await expect(packages.install(pkg)).resolves.toContain("已重新安装");
  expect(runCommand).toHaveBeenCalledWith("codeagent", [
    "plugin",
    "install",
    "tools@local",
    "--scope",
    "user",
  ]);
});
