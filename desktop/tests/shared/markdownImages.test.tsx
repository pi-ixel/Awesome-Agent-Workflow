import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MarkdownView } from "../../src/shared/ui/MarkdownView";

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
