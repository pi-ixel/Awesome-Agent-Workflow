import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { installDesktopWorkbench } from "../../../src/bootstrap/installDesktopWorkbench.ts";
import { act, render, screen, within } from "@testing-library/react";
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
  expect(copy).toHaveTextContent("已复制 SKILL.md");
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
it("回收站卡片悬浮显示描述，缺少描述时不显示路径", async () => {
  const data = {
    ...catalog,
    trash: [
      { ...skill, id: "first" },
      { ...skill, id: "second", name: "empty", description: "" },
    ],
  };
  render(
    <SkillLibrary
      trash
      library={{
        list: () => Promise.resolve(data),
        candidates: () => Promise.resolve([]),
        change: () => Promise.resolve([]),
      }}
      provider="codeagent"
      storage={window.localStorage}
      knownProjects={() => []}
      pick={() => Promise.resolve(null)}
      reveal={async () => {}}
    />,
  );
  expect(
    await screen.findByRole("button", { name: "选择 sample" }),
  ).toHaveAttribute("data-hint", skill.description);
  expect(
    screen.getByRole("button", { name: "选择 empty" }),
  ).not.toHaveAttribute("data-hint");
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
it("同名技能按来源选择，删除提交当前配置及选中项的版本", async () => {
  const change = vi
    .fn<NativeSkillLibrary["change"]>()
    .mockResolvedValue(["已移入回收站"]);
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
  let finishCopy!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishCopy = resolve;
      }),
  );
  await user.click(within(cards[1]!).getByRole("button", { name: "更多" }));
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["详情", "打开目录", "复制路径"]);
  await user.click(screen.getByRole("menuitem", { name: "打开目录" }));
  expect(reveal).toHaveBeenCalledWith(alt + "/sample", "open-directory");
  await user.click(within(cards[1]!).getByRole("button", { name: "更多" }));
  const copy = screen.getByRole("menuitem", { name: "复制路径" });
  await user.click(copy);
  expect(write).toHaveBeenCalledWith(alt + "/sample");
  expect(screen.getByRole("button", { name: "批量选择" })).toBeEnabled();
  expect(
    within(cards[0]!).getByRole("button", { name: "移入回收站" }),
  ).toBeEnabled();
  await act(async () => {
    finishCopy();
    await Promise.resolve();
  });
  expect(notify).toHaveBeenCalledWith({
    message: "已复制",
    variant: "ok",
    dedupeKey: "skill-path-copy",
  });
  expect(
    within(cards[0]!).queryByRole("button", { name: "复制路径" }),
  ).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  write.mockRestore();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getAllByRole("region", { name: "全局技能" })).toHaveLength(1);
  await user.click(within(cards[1]!).getByRole("button", { name: "更多" }));
  await user.click(screen.getByRole("menuitem", { name: "详情" }));
  const detail = screen.getByRole("dialog", { name: "技能详情" });
  expect(within(detail).getByText(alt + "/sample")).toBeInTheDocument();
  await userEvent.click(
    within(detail).getByRole("button", { name: "移入回收站" }),
  );
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    screen.getByRole("dialog", { name: "确认技能操作" }),
  ).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(
    within(screen.getByRole("dialog", { name: "技能详情" })).getByText(
      alt + "/sample",
    ),
  ).toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(within(cards[1]!).getByRole("button", { name: "更多" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "批量选择" }));
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "打开目录" })).toBeNull();
  expect(screen.queryByRole("button", { name: "查看 sample 详情" })).toBeNull();
  expect(screen.getByRole("button", { name: "全选" })).toBeEnabled();
  const recycleSelected = screen.getByRole("button", {
    name: "将所选技能移入回收站",
  });
  expect(recycleSelected).toBeDisabled();
  expect(recycleSelected).toHaveAttribute("data-icon-hover-button");
  const choices = await screen.findAllByRole("button", {
    name: "选择 sample",
  });
  const choice = choices[1]!;
  expect(choice).toHaveTextContent(/^sample$/);
  await userEvent.click(choice);
  expect(choice).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.keyboard(" ");
  expect(choice).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(choice);
  await userEvent.click(recycleSelected);
  const dialog = await screen.findByRole("dialog", { name: "确认技能操作" });
  expect(within(dialog).getByText(/仅移除链接/)).toBeInTheDocument();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "移入回收站" }),
  );
  expect(change).toHaveBeenCalledWith(
    { provider: "icode", profile: "Code.yaml", projects: [] },
    {
      type: "delete",
      items: [{ path: alt + "/sample", revision: "r1", name: "sample" }],
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
it("插件包技能支持单项回收和批量全选", async () => {
  const source = "C:/Users/test/.cac/plugins/cache/local/tools/1.0/skills";
  const entry = {
    ...skill,
    kind: "package" as const,
    source,
    path: source + "/sample",
  };
  const sibling = { ...entry, name: "other", path: source + "/other" };
  const change = vi.fn<NativeSkillLibrary["change"]>().mockResolvedValue([]);
  const selection = ({ name, path, revision }: typeof entry) => ({
    name,
    path,
    revision,
  });
  const query = { provider: "codeagent", profile: null, projects: [] };
  render(
    <SkillLibrary
      library={{
        list: () =>
          Promise.resolve({
            ...catalog,
            entries: [entry, sibling],
            sources: [
              {
                ...catalog.sources[0]!,
                path: source,
                kind: "package",
                canImport: false,
              },
            ],
          }),
        candidates: () => Promise.resolve([]),
        change,
      }}
      provider="codeagent"
      storage={window.localStorage}
      knownProjects={() => []}
      pick={() => Promise.resolve(null)}
      reveal={async () => {}}
    />,
  );
  const card = await screen.findByRole("article", { name: "sample" });
  await userEvent.click(
    within(card).getByRole("button", { name: "移入回收站" }),
  );
  const confirm = async () => {
    const dialog = await screen.findByRole("dialog", {
      name: "确认技能操作",
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "移入回收站" }),
    );
  };
  await confirm();
  expect(change).toHaveBeenLastCalledWith(query, {
    type: "delete",
    items: [selection(entry)],
  });

  await userEvent.click(screen.getByRole("button", { name: "批量选择" }));
  await userEvent.click(screen.getByRole("button", { name: "全选" }));
  expect(screen.getByRole("button", { name: "选择 sample" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "选择 other" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "将所选技能移入回收站" }),
  );
  await confirm();
  expect(change).toHaveBeenLastCalledWith(query, {
    type: "delete",
    items: [selection(entry), selection(sibling)],
  });
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
