/**
 * 公共的提示条、行内二次确认、面包屑、展开收起、空状态。
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Breadcrumb } from "../../src/shared/ui/Breadcrumb.tsx";
import { Callout } from "../../src/shared/ui/Callout.tsx";
import { Disclosure } from "../../src/shared/ui/Disclosure.tsx";
import { EmptyState } from "../../src/shared/ui/EmptyState.tsx";
import { InlineConfirm } from "../../src/shared/ui/InlineConfirm.tsx";
import { TextLink } from "../../src/shared/ui/TextLink.tsx";

afterEach(() => cleanup());

it("shows a callout with its title first, folds details and offers dismiss", () => {
  const dismiss = vi.fn();
  render(<Callout tone="danger" title="归档失败" details="RUN_ALREADY_ACTIVE" onDismiss={dismiss}>运行停下后再试。</Callout>);
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("归档失败运行停下后再试。");
  expect(within(alert).getByText("详情").closest("details")).not.toHaveAttribute("open");
  fireEvent.click(within(alert).getByRole("button", { name: "关闭提示" }));
  expect(dismiss).toHaveBeenCalledOnce();
});

it("focuses cancel first and cancels on Escape", () => {
  const confirm = vi.fn();
  const cancel = vi.fn();
  render(<InlineConfirm label="确认删除" message="删除后不能恢复。" confirmLabel="删除" onConfirm={confirm} onCancel={cancel} />);
  const group = screen.getByRole("group", { name: "确认删除" });
  expect(within(group).getByRole("button", { name: "取消" })).toHaveFocus();
  fireEvent.keyDown(group, { key: "Escape" });
  expect(cancel).toHaveBeenCalledOnce();
  fireEvent.click(within(group).getByRole("button", { name: "删除" }));
  expect(confirm).toHaveBeenCalledOnce();
});

it("marks the last crumb as current unless a crumb says otherwise", () => {
  const back = vi.fn();
  const { rerender } = render(<Breadcrumb items={[{ label: "工作流库", onSelect: back }, { label: "AAW 轻量开发", onSelect: () => {} }]} />);
  const nav = screen.getByRole("navigation", { name: "位置" });
  expect(within(nav).getByText("AAW 轻量开发").closest("[aria-current]")).toHaveAttribute("aria-current", "page");
  fireEvent.click(within(nav).getByRole("button", { name: "工作流库" }));
  expect(back).toHaveBeenCalledOnce();
  // 运行页：两段都能点，没有当前项。
  rerender(<Breadcrumb items={[{ label: "工作流库", current: false, onSelect: back }, { label: "AAW 轻量开发", current: false, onSelect: () => {} }]} />);
  expect(within(nav).getAllByRole("button")).toHaveLength(2);
});

it("renders disclosure, empty state and text link with their roles", () => {
  const open = vi.fn();
  render(<>
    <Disclosure summary="原始结果"><pre>{"{}"}</pre></Disclosure>
    <EmptyState title="还没有运行" description="在工作流库里选一个工作流。" />
    <TextLink onClick={open}>需求</TextLink>
  </>);
  expect(screen.getByText("原始结果").closest("details")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("还没有运行在工作流库里选一个工作流。");
  fireEvent.click(screen.getByRole("button", { name: "需求" }));
  expect(open).toHaveBeenCalledOnce();
});
