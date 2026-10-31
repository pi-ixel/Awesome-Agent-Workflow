/**
 * src/ui/workbench/CloseConfirmModal 测试：统一关闭确认的双变体——
 * 忙（中断警示 + 危险钮 + 挂起审批计数）与闲（退出提示 + 主色钮），
 * 取消/确认回调各触发一次；快照语义（busy 决定变体）由 props 直测。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CloseConfirmModal,
  ExitOverlay,
} from "../../src/ui/workbench/CloseConfirmModal";

describe("CloseConfirmModal", () => {
  it("闲变体：退出提示 + 主色退出钮，取消/确认各触发一次回调", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CloseConfirmModal
        busy={false}
        pendingCount={0}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText("确定退出 AAW？")).toBeInTheDocument();
    expect(
      screen.getByText(/收口所有 agent 进程与终端会话/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("忙变体：中断警示含挂起审批计数 + 危险中断钮，不出现闲变体文案", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CloseConfirmModal
        busy={true}
        pendingCount={2}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText("agent 仍在工作")).toBeInTheDocument();
    expect(screen.getByText(/2 项挂起的审批\/提问/)).toBeInTheDocument();
    expect(screen.queryByText("确定退出 AAW？")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "中断并关闭" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "退出" })).toBeNull();
  });

  it("忙变体零挂起审批时不渲染计数从句", () => {
    render(
      <CloseConfirmModal
        busy={true}
        pendingCount={0}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByText(/挂起的审批/)).toBeNull();
  });

  it("退出遮罩：呈现「正在退出」状态（hide 失效时的兜底呈现）", () => {
    render(<ExitOverlay />);
    expect(screen.getByRole("status")).toHaveTextContent("正在退出…");
  });
});
