import type { GitChange, GitDiff, GitSnapshot } from "../../src/contracts/git.ts";
import { useRightPanelStore } from "../helpers/layout.ts";
import { createGitWorkbench } from "../helpers/gitWorkbench.tsx";
import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitReviewDiff } from "../../src/plugins/git/ui/GitReviewDiff.tsx";
import { reviewModel } from "../../src/plugins/git/review.ts";
import { GitPanel } from "../../src/plugins/git/ui/GitPanel.tsx";
import { panelService } from "../../src/plugins/host/panelService.ts";

const a: GitChange = {
  path: "src/a.txt",
  oldPath: null,
  source: "unstaged",
  status: "修改",
  added: 2,
  removed: 1,
};
const b: GitChange = { ...a, path: "b.txt", source: "untracked", removed: 0 };
const staged: GitChange = { ...a, source: "staged", added: 4 };
const branch: GitChange = { ...a, path: "committed.txt", source: "branch" };
const snapshot: GitSnapshot = {
  repoRoot: "D:/repo",
  branch: "main",
  changes: [a, b, staged],
  watchPaths: [],
  upstream: "origin/main",
  branchChanges: [branch],
};
const diff = (text: string): GitDiff => ({
  patch: `@@ -1 +1 @@\n-old\n+${text}\n`,
  notice: null,
  beforeContent: "old\n",
  afterContent: `${text}\n`,
});

let fixture: ReturnType<typeof createGitWorkbench>;

afterEach(() => fixture.dispose());
beforeEach(() => {
  fixture = createGitWorkbench();
  vi.restoreAllMocks();
  useRightPanelStore.setState({ projects: {} });
  vi.spyOn(panelService, "watch").mockResolvedValue(() => {});
  vi.spyOn(panelService, "gitStatus").mockResolvedValue(snapshot);
  vi.spyOn(panelService, "gitDiff").mockImplementation((_project, change) =>
    Promise.resolve(diff(change.path === "b.txt" ? "target B" : "target A")),
  );
});

describe("ZCode 风格 Git 审查", () => {
  it("统计失败仍显示文件列表和独立差异，不把未知统计显示成零", async () => {
    vi.mocked(panelService.gitStatus).mockResolvedValue({
      ...snapshot,
      changes: [{ ...a, added: 0, removed: 0, statsUnavailable: true }],
      statsWarning: "统计暂不可用：unstaged 读取失败",
    });
    render(<GitPanel git={fixture.git} project="D:/repo-stats-failed" />);
    await screen.findByText("统计暂不可用：unstaged 读取失败");
    const row = await screen.findByRole("button", { name: /展开 src\/a\.txt/ });
    expect(row).toHaveTextContent("统计暂不可用");
    expect(row).not.toHaveTextContent("+0");
    await userEvent.click(row);
    await screen.findAllByText(/target A/);
    expect(panelService.gitDiff).toHaveBeenCalled();
  });
  it("连续展示跟踪文件，未跟踪文件独立分组按需读取，不显示来源标签和查找输入", async () => {
    render(
      <StrictMode>
        <GitPanel git={fixture.git} project="D:/repo" />
      </StrictMode>,
    );
    // 模型 a：diff 默认收起——两行文件头在，差异体不挂载（缓存仍预取）
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /展开 (src\/a\.txt|b\.txt)/ }),
      ).toHaveLength(2),
    );
    expect(panelService.gitDiff).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("option", { name: "上一轮" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("变更来源")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unversioned Files" }),
    ).toHaveAttribute("aria-expanded", "false");

    // 点文件头展开：差异体挂载
    await userEvent.click(
      screen.getAllByRole("button", { name: "展开 src/a.txt" })[0]!,
    );
    expect(await screen.findByLabelText("Git 左右差异")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Unversioned Files" }),
    );
    expect(panelService.gitDiff).toHaveBeenCalledTimes(2);
    const file = screen.getByRole("button", { name: "定位 b.txt" });
    expect(file).toHaveClass("text-danger-ink");
    await userEvent.click(file);
    expect(await screen.findByText("target B")).toBeInTheDocument();
    expect(file).toHaveAttribute("aria-current", "true");
    expect(screen.queryByLabelText("筛选文件")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("查找变更内容")).not.toBeInTheDocument();
    expect(screen.queryByText(/未暂存|已暂存/)).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Unversioned Files" }),
    );
    expect(screen.getByText("target B")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "定位 b.txt" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unversioned Files" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("committed.txt")).not.toBeInTheDocument();
  });
  it("悬浮入口反复请求均展开目标组，不批量读取未跟踪文件", async () => {
    render(<GitPanel git={fixture.git} project="D:/repo" />);
    await screen.findByRole("button", { name: "Unversioned Files" });
    await waitFor(() => expect(panelService.gitDiff).toHaveBeenCalledTimes(2));
    for (let i = 0; i < 2; i++) {
      act(() =>
        useRightPanelStore.getState().gitSource("D:/repo", "untracked"),
      );
      expect(
        screen.getByRole("button", { name: "Unversioned Files" }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(
        screen.getByRole("button", { name: "定位 b.txt" }),
      ).toBeInTheDocument();
      expect(panelService.gitDiff).toHaveBeenCalledTimes(2);
      await userEvent.click(
        screen.getByRole("button", { name: "Unversioned Files" }),
      );
    }
  });
  it("自动刷新保留已显示差异，相同行数的内容更新仍重新读取，失败保留旧内容", async () => {
    const oneFile = { ...snapshot, changes: [staged] };
    vi.spyOn(panelService, "gitStatus").mockResolvedValue(oneFile);
    render(<GitPanel git={fixture.git} project="D:/repo" />);
    // 模型 a：diff 默认收起，数据到位后点文件头展开
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "展开 src/a.txt" }))[0]!,
    );
    await screen.findAllByText("target A");
    let finish: ((value: GitDiff) => void) | undefined;
    vi.spyOn(panelService, "gitStatus").mockResolvedValue({ ...oneFile });
    vi.spyOn(panelService, "gitDiff").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(finish).toBeDefined());
    expect(screen.getByText("target A")).toBeInTheDocument();
    expect(screen.queryByText("正在读取差异…")).not.toBeInTheDocument();
    await act(async () => {
      finish?.(diff("updated"));
      await Promise.resolve();
    });
    expect(await screen.findByText("updated")).toBeInTheDocument();
    expect(screen.queryByText("target A")).not.toBeInTheDocument();
    vi.spyOn(panelService, "gitStatus").mockResolvedValue({ ...oneFile });
    vi.spyOn(panelService, "gitDiff").mockRejectedValue(new Error("读取失败"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "刷新" })).not.toBeDisabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("显示上次内容");
    expect(screen.getByText("updated")).toBeInTheDocument();
  });
  it("刷新后忽略旧缓存迟到结果", async () => {
    let finish: ((value: GitDiff) => void) | undefined;
    vi.spyOn(panelService, "gitDiff")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(diff("fresh"));
    const view = render(<GitPanel git={fixture.git} project="D:/repo" />);
    // 模型 a：diff 默认收起，数据到位后点文件头展开
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "展开 src/a.txt" }))[0]!,
    );
    await screen.findAllByRole("button", { name: "收起 src/a.txt" });
    vi.spyOn(panelService, "gitStatus").mockResolvedValue({ ...snapshot });
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect((await screen.findAllByText("fresh")).length).toBeGreaterThan(0);
    await act(async () => {
      finish?.(diff("late"));
      await Promise.resolve();
    });
    expect(screen.queryByText("late")).not.toBeInTheDocument();
    view.unmount();
    render(<GitPanel git={fixture.git} project="D:/repo" />);
    expect(
      await screen.findByRole("button", { name: "Unversioned Files" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});

it("左右差异将不等长修改块配对留空，搜索只标记目标侧", () => {
  const model = reviewModel({
    patch: "@@ -1,2 +1 @@\n-old1\n-old2\n+new\n",
    beforeContent: "old1\nold2\n",
    afterContent: "new\n",
    notice: null,
  });
  render(
    <GitReviewDiff
      model={model}
      query="new"
      match={{ key: "x", row: 2, start: 0, length: 3, side: "next" }}
    />,
  );
  const before = screen.getByLabelText("修改前"),
    after = screen.getByLabelText("修改后");
  expect(within(before).getByText("old1")).toBeInTheDocument();
  expect(within(before).getByText("old2")).toBeInTheDocument();
  expect(within(after).getByText("new")).toHaveAttribute(
    "data-current-hit",
    "true",
  );
  expect(within(after).getByText("new")).toHaveClass(
    "bg-find-highlight-active",
  );
  expect(before.firstElementChild?.children).toHaveLength(2);
  expect(after.firstElementChild?.children).toHaveLength(2);
});

it("查找命中按 ZCode 原值 token 高亮：当前命中 active 档，其余命中普通档", () => {
  const model = reviewModel({
    patch: "@@ -1,2 +1 @@\n-old\n+new new\n",
    beforeContent: "old\n",
    afterContent: "new new\n",
    notice: null,
  });
  render(
    <GitReviewDiff
      model={model}
      query="new"
      match={{ key: "x", row: 1, start: 4, length: 3, side: "next" }}
    />,
  );
  const after = screen.getByLabelText("修改后");
  const hits = within(after).getAllByText("new");
  expect(hits).toHaveLength(2);
  expect(hits[0]).toHaveClass("bg-find-highlight");
  expect(hits[1]).toHaveClass("bg-find-highlight-active");
});

vi.mock(import("../../src/plugins/workbench/layoutView.ts"), async (original) => {
  const { layoutViewFixture } = await import("../helpers/layout.ts");
  return { ...(await original()), ...layoutViewFixture() };
});
