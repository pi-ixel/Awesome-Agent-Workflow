import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MarkdownView } from "../../src/shared/ui/MarkdownView";

it("only links verified reply paths and opens the canonical file at its line", async () => {
  const root = "D:/repo/.worktrees/task";
  const open = vi.fn();
  const external = vi.fn(() => Promise.resolve());
  const verify = vi.fn((_root: string, path: string) =>
    Promise.resolve(
      path === root + "/src/main.ts" || path === root + "/README.md"
        ? { path, kind: "file" as const }
        : null,
    ),
  );
  render(
    <MarkdownView
      text={
        "看 [入口](src/main.ts#L12) 和 `README.md:8`，缺失 `src/missing.ts`，越界 [上级](../README.md)，外链 [文档](https://example.test/)。\n\n~~~ts\nsrc/snippet.ts\n~~~"
      }
      fileRoot="D:/repo"
      replyFiles={{ root, verify, open }}
      onOpenFile={open}
      onOpenExternal={external}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "入口" }),
  ).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "入口" }));
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(root + "/src/main.ts", 12),
  );
  fireEvent.click(await screen.findByRole("button", { name: "README.md:8" }));
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(root + "/README.md", 8),
  );
  expect(screen.getByText("src/missing.ts")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "src/missing.ts" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "上级" }),
  ).not.toBeInTheDocument();
  expect(verify).not.toHaveBeenCalledWith(root, root + "/src/snippet.ts");
  expect(
    verify.mock.calls.every(
      ([cwd, path]) => cwd === root && path.startsWith(root + "/"),
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "文档" }));
  expect(external).toHaveBeenCalledWith("https://example.test/");
});

it("makes inline absolute paths clickable without looking up files on render", () => {
  const verify = vi.fn(() => Promise.resolve(null));
  const openAbsolute = vi.fn();
  render(
    <MarkdownView
      text={[
        "打开 `D:\\outside\\with space\\demo.md:12:3`",
        "或 `D:/reports/100%/demo.md#L5`",
        "以及 `/home/user/note.md`。",
        "原样保留 D:\\outside\\plain.md 和 `start demo.html`。",
        "\n\n~~~text\nD:\\outside\\snippet.md\n~~~",
      ].join(" ")}
      replyFiles={{ root: "D:/repo", verify, open: openAbsolute }}
    />,
  );
  const [first, second] = screen.getAllByRole("button", { name: "demo.md" });
  expect(first).toHaveAttribute("data-hint", "D:/outside/with space/demo.md");
  expect(second).toHaveAttribute("data-hint", "D:/reports/100%/demo.md");
  expect(verify).not.toHaveBeenCalled();
  fireEvent.click(first!);
  fireEvent.click(second!);
  fireEvent.click(screen.getByRole("button", { name: "note.md" }));
  expect(openAbsolute.mock.calls).toEqual([
    ["D:/outside/with space/demo.md", 12],
    ["D:/reports/100%/demo.md", 5],
    ["/home/user/note.md", undefined],
  ]);
  expect(
    screen.queryByRole("button", {
      name: /plain\.md|snippet\.md|start demo\.html/,
    }),
  ).toBeNull();
});

it("leaves an existing reference as text if the file disappears before the click", async () => {
  const root = "D:/repo";
  const open = vi.fn(() => Promise.reject(new Error("文件已不存在")));
  const verify = vi
    .fn<
      (
        _root: string,
        path: string,
      ) => Promise<{ path: string; kind: "file" } | null>
    >()
    .mockResolvedValueOnce({ path: root + "/README.md", kind: "file" })
    .mockResolvedValue(null);
  render(
    <MarkdownView
      text={"[说明](./README.md)"}
      replyFiles={{ root, verify, open }}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "说明" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "说明" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByText("说明")).toBeVisible();
  expect(open).toHaveBeenCalledWith(root + "/README.md", undefined);
});

it("流式代码围栏成形后才挂载代码工具，已完成正文保留", () => {
  const prose = "## 说明\n\n先看正文。\n\n";
  const open = prose + "~~~typescript\nconst answer = 42;";
  const view = render(<MarkdownView text={open} streaming />);
  expect(screen.getByRole("heading", { name: "说明" })).toBeInTheDocument();
  expect(screen.getByText("const answer = 42;")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "复制代码" })).toBeNull();

  view.rerender(<MarkdownView text={open + "\n~~~\n\n后续正文。"} streaming />);
  expect(screen.getByRole("button", { name: "复制代码" })).toBeInTheDocument();
  expect(screen.getByText("后续正文。")).toBeInTheDocument();
});
it("Markdown 文本更新不重挂已加载的远程图片", () => {
  const text = "![示意图](https://example.com/image.png)";
  const view = render(<MarkdownView text={text} />);
  const image = screen.getByAltText("示意图");
  fireEvent.load(image);
  expect(
    screen.queryByRole("status", { name: "加载中" }),
  ).not.toBeInTheDocument();
  view.rerender(<MarkdownView text={`${text}\n\n追加说明`} />);
  expect(screen.getByAltText("示意图")).toBe(image);
  expect(
    screen.queryByRole("status", { name: "加载中" }),
  ).not.toBeInTheDocument();
});

it("通过传入的打开操作处理网页链接，并由文档服务解析本地图", () => {
  const openExternal = vi.fn<(url: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const assetUrl = vi.fn(() => "https://asset.localhost/project-image.png");
  render(
    <MarkdownView
      text={"[帮助](https://example.test/help)\n\n![项目图片](./img.png)"}
      fileRoot="D:/project"
      onOpenExternal={openExternal}
      assetUrl={assetUrl}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "帮助" }));
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(
    "https://example.test/help",
  );
  expect(assetUrl).toHaveBeenCalledWith("D:/project/img.png");
  expect(screen.getByAltText("项目图片")).toHaveAttribute(
    "src",
    "https://asset.localhost/project-image.png",
  );
});
