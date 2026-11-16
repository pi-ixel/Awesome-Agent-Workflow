/**
 * 页头（PageHeader）：一页 / 一块的标题行——标题、可选条数、一句说明、右侧操作。
 *
 * 从前各页各写一遍（text-3xl / text-lg / text-ui-lg 混用），这里只验两份刻度、
 * 语义标题层级和「条数的加减写法」。
 */
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { PageHeader } from "../../src/shared/ui/PageHeader.tsx";

it("页面级标题渲染 h1，条数跟在标题后", () => {
  render(<PageHeader title="工作流库" count={3} description="模板与运行分开看。" />);
  const heading = screen.getByRole("heading", { level: 1, name: /工作流库/ });
  expect(heading.className).toContain("text-ui-lg");
  expect(heading.parentElement).toHaveTextContent("工作流库3");
  expect(screen.getByText("模板与运行分开看。")).toBeInTheDocument();
});

it("分节标题降一级（h2）并小一档字号", () => {
  render(<PageHeader size="section" title="ACP 连接" />);
  const heading = screen.getByRole("heading", { level: 2, name: "ACP 连接" });
  expect(heading.className).toContain("text-ui-base");
});

it("不给条数时不渲染计数位；操作渲染在右侧槽里", () => {
  render(<PageHeader title="诊断" actions={<button type="button">刷新</button>} />);
  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^诊断$/);
});
