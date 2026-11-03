import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { MarkdownView } from "../../src/ui/session/MarkdownView";
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
