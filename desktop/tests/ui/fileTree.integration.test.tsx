/**
 * 文件树全组件集成回归（FileTree + useFileTreeData + model + FileTreeList）：
 *
 * 用户复测症状（仓库根）：只渲染出一个未跟踪文件行、目录全部消失、
 * 行文字与吸顶目录文字重影。本测试用真实仓库根形状的载荷（Windows 反斜杠
 * 绝对路径、目录在前排序、混有未跟踪/修改 Git 状态）端到端验证：
 *
 * - 数据层：panelService.directory 的全部条目（目录 + 文件）都必须渲染为
 *   role=treeitem 行——构树不得丢目录；
 * - 渲染分支：仓库根 ≤100 行必须走静态分支（无 absolute 定位包装、容器高
 *   度不设 totalSize）；
 * - 定位：行不落在 top-0 绝对包装上（叠加/重影的 DOM 前提）。
 *
 * jsdom 无真实布局：定位断言走类名与内联样式；滚动几何由 store/回调解耦。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FileTree } from "../../src/ui/right-panel/FileTree.tsx";
import { panelService, type GitSnapshot } from "../../src/core/panelService.ts";

/** 模拟 Rust panel_directory 的返回：反斜杠路径、目录在前、小写名称序。 */
function repoRootListing(): { entries: never[]; truncated: boolean } {
  const names: [string, boolean][] = [
    ["desktop", true],
    ["docs", true],
    ["src", true],
    ["tests", true],
    ["cli", true],
    ["contracts", true],
    ["dist", true],
    ["%TEMP%suite_wf.json", false],
    [".dockerignore", false],
    [".gitattributes", false],
    [".gitignore", false],
    [".zcodeignore", false],
    ["LICENSE", false],
    ["README.md", false],
    ["install.sh", false],
    ["nul", false],
    ["programAwesome-Agent-Workflowout_r1_experiments.json", false],
  ];
  return {
    entries: names.map(([name, directory]) => ({
      path: `D:\\program\\Awesome-Agent-Workflow\\${name}`,
      name,
      directory,
      symlink: false,
    })) as never[],
    truncated: false,
  };
}

const gitSnapshot: GitSnapshot = {
  repoRoot: "D:/program/Awesome-Agent-Workflow",
  branch: "feat/stream-pump-raf",
  changes: [
    {
      path: "programAwesome-Agent-Workflowout_r1_experiments.json",
      oldPath: null,
      source: "untracked",
      status: "未跟踪",
    },
    {
      path: "desktop/src/ui/right-panel/FileTree.tsx",
      oldPath: null,
      source: "unstaged",
      status: "修改",
    },
  ],
  watchPaths: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(panelService, "directory").mockImplementation((path: string) => {
    if (
      path.replaceAll("\\", "/").replace(/\/{2,}/g, "/") ===
      "D:/program/Awesome-Agent-Workflow"
    ) {
      return Promise.resolve(repoRootListing() as never);
    }
    return Promise.resolve({ entries: [], truncated: false });
  });
  vi.spyOn(panelService, "gitStatus").mockResolvedValue(gitSnapshot);
  vi.spyOn(panelService, "watch").mockResolvedValue(() => {});
  vi.spyOn(panelService, "preview").mockResolvedValue({
    kind: "text",
    content: "预览正文内容",
    bytes: 18,
    mime: "",
  });
});

describe("文件树仓库根集成", () => {
  it("根目录全部条目渲染为行：目录不丢、垃圾文件与正常文件并存", async () => {
    render(
      <FileTree root={"D:\\program\\Awesome-Agent-Workflow"} onOpen={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByRole("tree", { name: "Awesome-Agent-Workflow" })).toBeInTheDocument();
    });
    const tree = screen.getByRole("tree", { name: "Awesome-Agent-Workflow" });
    await waitFor(() => {
      expect(tree.querySelectorAll('[role="treeitem"]')).toHaveLength(17);
    });
    // 目录行存在（症状「目录全部消失」的数据层反证）
    for (const name of ["desktop", "docs", "src", "tests"]) {
      expect(screen.getAllByTitle(name)[0]).toBeDefined();
    }
    // 垃圾文件行存在（用户可见的那一行）
    expect(
      screen.getAllByTitle(
        "programAwesome-Agent-Workflowout_r1_experiments.json",
      )[0],
    ).toBeDefined();
  });

  it("≤100 行走静态分支：行不在绝对定位包装上，容器高度不取 totalSize", async () => {
    render(
      <FileTree root={"D:\\program\\Awesome-Agent-Workflow"} onOpen={() => {}} />,
    );
    const tree = await screen.findByRole("tree", { name: "Awesome-Agent-Workflow" });
    await waitFor(() => {
      expect(tree.querySelectorAll('[role="treeitem"]').length).toBe(17);
    });
    // 静态分支：行包装 = w-full px-1 流式容器内的 w-full 行
    expect(tree.className).not.toContain("px-1");
    expect(tree.firstElementChild?.className).toContain("px-1");
    for (const wrapper of Array.from(tree.firstElementChild!.children)) {
      expect(wrapper.className).not.toContain("absolute");
      expect(wrapper.className).not.toContain("top-0");
      expect((wrapper as HTMLElement).style.transform).toBe("");
    }
    // 容器高度未取 totalSize（虚拟分支才会设 px 高度）
    expect((tree).style.height).toBe("");
  });

  it("点击目录行触发子目录加载，目录不会从树中消失", async () => {
    render(
      <FileTree root={"D:\\program\\Awesome-Agent-Workflow"} onOpen={() => {}} />,
    );
    const tree = await screen.findByRole("tree", { name: "Awesome-Agent-Workflow" });
    await waitFor(() => {
      expect(tree.querySelectorAll('[role="treeitem"]').length).toBe(17);
    });
    const desktop = screen.getAllByTitle("desktop")[0]!;
    fireEvent.click(desktop);
    await waitFor(() => {
      expect(
        vi.mocked(panelService.directory).mock.calls.some(
          ([path]) => path.replace(/\\/g, "/").endsWith("/desktop"),
        ),
      ).toBe(true);
    });
  });

  it(">100 行走虚拟分支：渲染行带互异的 translateY，容器高度取 totalSize", async () => {
    // jsdom 视口 0 高时虚拟器返回空窗口：桩定视口高让窗口化真实发生
    const prototype = HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(prototype, "clientHeight");
    Object.defineProperty(prototype, "clientHeight", {
      configurable: true,
      value: 392,
    });
    try {
      const entries = Array.from({ length: 150 }, (_, index) => ({
        path: `D:\\program\\Awesome-Agent-Workflow\\file-${String(index).padStart(3, "0")}.ts`,
        name: `file-${String(index).padStart(3, "0")}.ts`,
        directory: false,
        symlink: false,
      }));
      vi.spyOn(panelService, "directory").mockResolvedValue({
        entries,
        truncated: false,
      });
      render(
        <FileTree root={"D:\\program\\Awesome-Agent-Workflow"} onOpen={() => {}} />,
      );
      const tree = await screen.findByRole("tree", { name: "Awesome-Agent-Workflow" });
      await waitFor(() => {
        const rows = tree.querySelectorAll('[role="treeitem"]');
        // 视口 392px = 14 行 + overscan 12：窗口行远少于 150，
        // 但绝不能把 150 行全部渲染，也不能一个都不渲染
        expect(rows.length).toBeGreaterThan(1);
        expect(rows.length).toBeLessThan(150);
      });
      const wrappers = Array.from(tree.children) as HTMLElement[];
      const offsets = wrappers.map((wrapper) => wrapper.style.transform);
      // 行必须落在互异的 translateY 上（叠加 = 全 0 的坍缩形态）
      expect(new Set(offsets).size).toBe(offsets.length);
      expect(wrappers.every((wrapper) => wrapper.className.includes("absolute"))).toBe(true);
      expect((tree).style.height).toBe("3600px");
    } finally {
      if (original) Object.defineProperty(prototype, "clientHeight", original);
      else delete (prototype as unknown as Record<string, unknown>)["clientHeight"];
    }
  });

  it("点击文件行：并列预览区换内容，树保持完整、选中行呈 pill、不外开 tab", async () => {
    const onOpen = vi.fn();
    render(
      <FileTree root={"D:\\program\\Awesome-Agent-Workflow"} onOpen={onOpen} />,
    );
    const tree = await screen.findByRole("tree", { name: "Awesome-Agent-Workflow" });
    await waitFor(() => {
      expect(tree.querySelectorAll('[role="treeitem"]').length).toBe(17);
    });
    const pane = screen.getByLabelText("预览区");
    // 未选中文件：空态
    expect(pane.textContent).toContain("从目录中选择一个文件");
    const junk = screen.getAllByTitle(
      "programAwesome-Agent-Workflowout_r1_experiments.json",
    )[0]!;
    fireEvent.click(junk);
    // 预览区出现面包屑（项目名 > 文件名）与正文内容
    await waitFor(() => {
      expect(pane.textContent).toContain("预览正文内容");
    });
    expect(pane.textContent).toContain("Awesome-Agent-Workflow");
    expect(pane.textContent).toContain(
      "programAwesome-Agent-Workflowout_r1_experiments.json",
    );
    // 树保持完整（不遮挡、不替换），选中行呈灰色 pill
    expect(tree.querySelectorAll('[role="treeitem"]').length).toBe(17);
    expect(junk.className).toContain("bg-surface-hover");
    // 预览区无关闭钮（关闭路径 = 顶栏分段开关）
    expect(screen.queryByRole("button", { name: /关闭/ })).toBeNull();
    // 树内点击不再外开 tab（无 tab 芯片形态的来源）
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("预览面包屑点击目录层级：树展开并选中该目录，预览内容不换", async () => {
    const rootPath = "D:/program/Awesome-Agent-Workflow";
    vi.spyOn(panelService, "directory").mockImplementation((path: string) => {
      const normalized = path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
      if (normalized === rootPath) {
        return Promise.resolve(repoRootListing() as never);
      }
      if (normalized === `${rootPath}/desktop`) {
        return Promise.resolve({
          entries: [
            {
              path: "D:\\program\\Awesome-Agent-Workflow\\desktop\\src",
              name: "src",
              directory: true,
              symlink: false,
            },
            {
              path: "D:\\program\\Awesome-Agent-Workflow\\desktop\\package.json",
              name: "package.json",
              directory: false,
              symlink: false,
            },
          ],
          truncated: false,
        } as never);
      }
      return Promise.resolve({ entries: [], truncated: false });
    });
    render(
      <FileTree root={"D:\\program\\Awesome-Agent-Workflow"} onOpen={() => {}} />,
    );
    const tree = await screen.findByRole("tree", { name: "Awesome-Agent-Workflow" });
    await waitFor(() => {
      expect(tree.querySelectorAll('[role="treeitem"]').length).toBe(17);
    });
    fireEvent.click(screen.getAllByTitle("desktop")[0]!);
    await waitFor(() => {
      expect(screen.getAllByTitle("desktop/package.json")[0]).toBeDefined();
    });
    fireEvent.click(screen.getAllByTitle("desktop/package.json")[0]!);
    const pane = screen.getByLabelText("预览区");
    await waitFor(() => {
      expect(pane.textContent).toContain("预览正文内容");
    });
    // 面包屑：Awesome-Agent-Workflow > desktop > package.json；点 desktop 层级
    fireEvent.click(
      within(pane).getByRole("button", { name: "desktop" }),
    );
    // 树中 desktop 行被选中（pill），预览内容保持
    await waitFor(() => {
      expect(screen.getAllByTitle("desktop")[0]!.className).toContain(
        "bg-surface-hover",
      );
    });
    expect(pane.textContent).toContain("预览正文内容");
  });

  it("滚动后吸顶目录条出现且列表带顶部遮罩（分组头不与行重影的前提）", async () => {
    // desktop/ 子目录载荷：展开后滚动，探针行才有祖先目录可吸顶
    vi.spyOn(panelService, "directory").mockImplementation((path: string) => {
      const normalized = path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
      if (normalized === "D:/program/Awesome-Agent-Workflow/desktop") {
        return Promise.resolve({
          entries: [
            { path: "D:\\...\\desktop\\src", name: "src", directory: true, symlink: false },
            { path: "D:\\...\\desktop\\tests", name: "tests", directory: true, symlink: false },
            { path: "D:\\...\\desktop\\package.json", name: "package.json", directory: false, symlink: false },
          ],
          truncated: false,
        } as never);
      }
      if (
        normalized === "D:/program/Awesome-Agent-Workflow" ||
        normalized.startsWith("D:/program/Awesome-Agent-Workflow/desktop/")
      ) {
        return Promise.resolve(repoRootListing() as never);
      }
      return Promise.resolve({ entries: [], truncated: false });
    });
    render(
      <FileTree root={"D:\\program\\Awesome-Agent-Workflow"} onOpen={() => {}} />,
    );
    const tree = await screen.findByRole("tree", { name: "Awesome-Agent-Workflow" });
    await waitFor(() => {
      expect(tree.querySelectorAll('[role="treeitem"]').length).toBe(17);
    });
    fireEvent.click(screen.getAllByTitle("desktop")[0]!);
    await waitFor(() => {
      expect(screen.getAllByTitle("package.json")[0]).toBeDefined();
    });
    // 桩定滚动几何（jsdom 无布局），滚过 3 行（3×24px）触发吸顶
    const scrollNode = tree.closest("div.h-full") as HTMLElement;
    Object.defineProperty(scrollNode, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scrollNode, "clientHeight", { value: 400, configurable: true });
    scrollNode.scrollTop = 72;
    fireEvent.scroll(scrollNode);
    await waitFor(() => {
      const overlay = scrollNode.querySelector(".sticky.top-0");
      expect(overlay).not.toBeNull();
      // 分组头显示的是祖先目录行
      expect(overlay!.textContent).toContain("desktop");
      // 列表带顶部遮罩：真实布局下遮住吸顶层下经过的原行（防重影）
      const listStyle = (tree).style;
      expect(
        listStyle.getPropertyValue("-webkit-mask-image") ||
          listStyle.webkitMaskImage,
      ).toContain("linear-gradient");
    });
  });
});
