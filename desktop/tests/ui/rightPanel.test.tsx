import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PanelWorkspace,
  PanelButtons,
} from "../../src/ui/right-panel/RightPanel.tsx";
import { panelService, type FilePreview } from "../../src/core/panelService.ts";
import {
  restorePanels,
  useRightPanelStore,
} from "../../src/stores/rightPanelStore.ts";
import { useWorkbenchUiStore } from "../../src/stores/workbenchUiStore.ts";
import { usePanelWatch } from "../../src/ui/right-panel/usePanelWatch.ts";
import { GitDiffView } from "../../src/ui/right-panel/GitPanel.tsx";

beforeEach(() => {
  vi.restoreAllMocks();
  useRightPanelStore.setState({ projects: {} });
  useWorkbenchUiStore.setState({
    contextPath: "D:/a",
    treeView: "project-overview",
  });
  vi.spyOn(panelService, "directory").mockResolvedValue({
    entries: [
      { name: ".sdd", path: "D:/a/.sdd", directory: true, symlink: false },
    ],
    truncated: false,
  });
  vi.spyOn(panelService, "watch").mockResolvedValue(() => {});
});

describe("项目右栏", () => {
  it("拖宽跨过覆盖布局阈值仍保留最终宽度和聊天草稿", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    try {
      useRightPanelStore.getState().tool("D:/a", "files");
      render(
        <PanelWorkspace project="D:/a" enabled>
          <textarea aria-label="草稿" defaultValue="保留" />
        </PanelWorkspace>,
      );
      const input = screen.getByRole("textbox", { name: "草稿" });
      const divider = screen.getByRole("separator", { name: "调整右栏宽度" });
      Object.defineProperty(divider, "setPointerCapture", { value: vi.fn() });
      fireEvent.pointerDown(divider, { button: 0, clientX: 900 });
      fireEvent.pointerMove(divider, { clientX: 500 });
      fireEvent.pointerUp(divider, { clientX: 500 });
      expect(useRightPanelStore.getState().projects["d:/a"]?.width).toBe(800);
      expect(
        screen.getByRole("button", { name: "关闭右栏遮罩" }),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: "关闭右栏遮罩" }),
      );
      expect(screen.getByRole("textbox", { name: "草稿" })).toBe(input);
      expect(input).toHaveValue("保留");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("Git 手动宽度松手后保留，并在切换面板及重新加载后恢复", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.spyOn(panelService, "gitStatus").mockResolvedValue({
      repoRoot: "D:/a",
      branch: "main",
      changes: [],
      watchPaths: [],
    });
    try {
      useRightPanelStore.getState().tool("D:/a", "git");
      const view = render(
        <PanelWorkspace project="D:/a" enabled>
          <textarea aria-label="草稿" defaultValue="保留" />
        </PanelWorkspace>,
      );
      const divider = screen.getByRole("separator");
      Object.defineProperty(divider, "setPointerCapture", { value: vi.fn() });
      expect(screen.getByLabelText("项目右侧工具栏")).toHaveStyle({
        width: "840px",
      });
      fireEvent.pointerDown(divider, { button: 0, clientX: 900 });
      fireEvent.pointerMove(divider, { clientX: 1100 });
      expect(screen.getByLabelText("项目右侧工具栏")).toHaveStyle({
        width: "640px",
      });
      fireEvent.pointerUp(divider, { clientX: 1100 });
      expect(screen.getByLabelText("项目右侧工具栏")).toHaveStyle({
        width: "640px",
      });
      act(() => useRightPanelStore.getState().tool("D:/a", "files"));
      expect(screen.getByLabelText("项目右侧工具栏")).toHaveStyle({
        width: "420px",
      });
      act(() => useRightPanelStore.getState().tool("D:/a", "git"));
      expect(screen.getByLabelText("项目右侧工具栏")).toHaveStyle({
        width: "640px",
      });
      fireEvent.pointerDown(divider, { button: 0, clientX: 1100 });
      fireEvent.pointerMove(divider, { clientX: 880 });
      fireEvent.pointerUp(divider, { clientX: 880 });
      expect(screen.getByLabelText("项目右侧工具栏")).toHaveStyle({
        width: "860px",
      });
      const restored = restorePanels(
        localStorage.getItem("aaw-desktop/right-panel/v1"),
      );
      expect(restored["d:/a"]?.gitWidth).toBe(860);
      view.unmount();
      useRightPanelStore.setState({ projects: restored });
      render(
        <PanelWorkspace project="D:/a" enabled>
          聊天
        </PanelWorkspace>,
      );
      expect(screen.getByLabelText("项目右侧工具栏")).toHaveStyle({
        width: "860px",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("子目录差异同时监听项目和仓库元数据，关闭释放监听", async () => {
    const stop = vi.fn();
    const watch = vi.spyOn(panelService, "watch").mockResolvedValue(stop);
    vi.spyOn(panelService, "gitStatus").mockResolvedValue({
      repoRoot: "D:/repo",
      branch: "main",
      changes: [],
      watchPaths: ["D:/repo/app", "D:/repo/.git"],
    });
    vi.spyOn(panelService, "gitDiff").mockResolvedValue({
      patch: "@@ -1 +1 @@\n-old\n+new",
      notice: null,
    });
    const view = render(
      <GitDiffView
        project="D:/repo/app"
        repoRoot="D:/repo"
        change={{
          path: "app/a.txt",
          oldPath: null,
          source: "staged",
          status: "修改",
        }}
        onFile={() => {}}
      />,
    );
    expect(await screen.findByText("+new")).toBeInTheDocument();
    await waitFor(() =>
      expect(watch).toHaveBeenCalledWith(
        [
          { path: "D:/repo/app", recursive: true },
          { path: "D:/repo/.git", recursive: true },
        ],
        expect.any(Function),
        expect.any(Function),
      ),
    );
    view.unmount();
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });
  it("默认收起、展开和关闭不重挂输入框，项目总览也能浏览文件", async () => {
    render(
      <>
        <PanelButtons project="D:/a" />
        <PanelWorkspace project="D:/a" enabled>
          <textarea aria-label="聊天草稿" />
        </PanelWorkspace>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "聊天草稿" });
    await userEvent.type(input, "未发送的草稿");
    expect(
      screen.queryByRole("complementary", { name: "项目右侧工具栏" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开文件面板" }));
    expect(await screen.findByText(".sdd")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "收起右侧工具栏" }),
    );
    expect(screen.getByRole("textbox", { name: "聊天草稿" })).toBe(input);
    expect(input).toHaveValue("未发送的草稿");
  });
  it("切项目使迟到文件读取失效，预览不建立 watcher", async () => {
    let finish: ((data: FilePreview) => void) | undefined;
    vi.spyOn(panelService, "preview").mockImplementation((path) =>
      path.startsWith("D:/a")
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({
            kind: "text",
            content: "项目 B 内容",
            bytes: 10,
            mime: "",
          }),
    );
    useRightPanelStore.getState().openFile("D:/a", "D:/a/test.txt");
    useRightPanelStore.getState().openFile("D:/b", "D:/b/test.txt");
    const view = render(
      <PanelWorkspace project="D:/a" enabled>
        <div>聊天</div>
      </PanelWorkspace>,
    );
    view.rerender(
      <PanelWorkspace project="D:/b" enabled>
        <div>聊天</div>
      </PanelWorkspace>,
    );
    expect(await screen.findByText("项目 B 内容")).toBeInTheDocument();
    await act(async () => {
      finish?.({ kind: "text", content: "迟到的项目 A", bytes: 10, mime: "" });
      await Promise.resolve();
    });
    expect(screen.queryByText("迟到的项目 A")).not.toBeInTheDocument();
    expect(vi.spyOn(panelService, "watch")).not.toHaveBeenCalled();
  });
  it("目录监听在关闭后释放，包括异步注册晚于组件卸载", async () => {
    let complete: ((stop: () => void) => void) | undefined;
    const stop = vi.fn();
    vi.spyOn(panelService, "watch").mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    function Consumer() {
      usePanelWatch([{ path: "D:/a", recursive: false }], true);
      return null;
    }
    const view = render(<Consumer />);
    view.unmount();
    await act(async () => {
      complete?.(stop);
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalledOnce();
  });
  it("Esc 收起右栏，持久化的标签仍在", async () => {
    useRightPanelStore.getState().openFile("D:/a", "D:/a/gone.txt");
    vi.spyOn(panelService, "preview").mockRejectedValue(
      new Error("文件不存在"),
    );
    render(
      <PanelWorkspace project="D:/a" enabled>
        <div>聊天</div>
      </PanelWorkspace>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("文件不存在");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(useRightPanelStore.getState().projects["d:/a"]?.open).toBe(false),
    );
    expect(useRightPanelStore.getState().projects["d:/a"]?.tabs).toHaveLength(
      1,
    );
  });
});
