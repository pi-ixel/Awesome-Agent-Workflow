import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  ArrowUpIcon,
  ChevronRightIcon,
  FolderGlyph,
  ProjectGlyph,
} from "../../src/shared/ui/icons.tsx";
import { FilesIcon } from "../../src/shared/ui/file-icons/icons.tsx";

it("共享图标基底保留两组描边默认值并接受显式覆盖", () => {
  const { container, rerender } = render(<ChevronRightIcon />);
  expect(container.querySelector("svg")).toHaveAttribute("stroke-width", "1.8");
  rerender(<FilesIcon />);
  expect(container.querySelector("svg")).toHaveAttribute("stroke-width", "2");
  rerender(<FilesIcon strokeWidth={3} />);
  expect(container.querySelector("svg")).toHaveAttribute("stroke-width", "3");
});

it("发送箭头和开闭文件夹使用可缩放的装饰图形", () => {
  const { container, rerender } = render(
    <ArrowUpIcon className="ui-icon-16" />,
  );
  const svg = container.querySelector("svg");
  expect(svg).toHaveClass("ui-icon", "ui-icon-16");
  expect(svg).toHaveAttribute("stroke-width", "2");
  expect(svg).toHaveAttribute("aria-hidden", "true");
  rerender(<FolderGlyph isExpanded={false} />);
  const closed = container.querySelector("path")?.getAttribute("d");
  rerender(<FolderGlyph isExpanded />);
  expect(closed).toBeTruthy();
  expect(container.querySelector("path")).not.toHaveAttribute("d", closed);
});

it.each([
  [false, false], [false, true], [true, false], [true, true],
])("项目图标保留缩放和开合状态 remote=%s multiple=%s", (remote, multiple) => {
  const glyph = (expanded: boolean) => <ProjectGlyph {...{ remote, multiple, expanded }} />;
  const { container, rerender } = render(glyph(false));
  const svg = container.querySelector("svg")!;
  expect(svg).toHaveClass("ui-icon-16");
  expect(svg).not.toHaveAttribute("width");
  expect(svg.querySelector("rect") !== null).toBe(remote);
  expect(svg.querySelector(":scope > path") !== null).toBe(multiple);
  const indicator = svg.querySelector("g > path:last-child");
  expect(indicator).toHaveAttribute("opacity", "0");
  rerender(glyph(true));
  expect(indicator).toHaveAttribute("opacity", "1");
  expect(indicator).toHaveClass("motion-reduce:transition-none");
});
