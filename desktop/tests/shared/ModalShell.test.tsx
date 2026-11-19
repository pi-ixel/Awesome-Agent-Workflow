import { useState } from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ModalShell } from "../../src/shared/ui/ModalShell.tsx";
import { ConfirmationDialog } from "../../src/shared/ui/ConfirmationDialog.tsx";

function Fixture() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>打开设置</button>
      {open && (
        <ModalShell
          label="设置"
          size="settings"
          onDismiss={() => setOpen(false)}
        >
          <button onClick={() => setConfirm(true)}>重置</button>
          <button onClick={() => setOpen(false)}>关闭</button>
          <div hidden>
            <button>隐藏页签按钮</button>
          </div>
          {confirm && (
            <ConfirmationDialog
              label="确认"
              title="确认重置"
              confirmLabel="确定"
              onConfirm={() => setConfirm(false)}
              onCancel={() => setConfirm(false)}
            >
              说明
            </ConfirmationDialog>
          )}
        </ModalShell>
      )}
    </>
  );
}

describe("ModalShell", () => {
  it("限制焦点在可见控件内，关闭后恢复入口和背景交互", async () => {
    const { container } = render(<Fixture />);
    const trigger = screen.getByRole("button", { name: "打开设置" });
    await userEvent.click(trigger);
    expect(container.inert).toBe(true);
    const first = screen.getByRole("button", { name: "重置" });
    const last = screen.getByRole("button", { name: "关闭" });
    expect(first).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.inert).toBe(false);
    expect(trigger).toHaveFocus();
  });

  it("嵌套确认独占 Escape，先关闭确认并恢复父弹窗焦点", async () => {
    render(<Fixture />);
    await userEvent.click(screen.getByText("打开设置"));
    const reset = screen.getByRole("button", { name: "重置" });
    await userEvent.click(reset);
    const inner = screen.getByRole("dialog", { name: "确认" });
    expect(within(inner).getByRole("button", { name: "取消" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(inner).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeVisible();
    expect(reset).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("卡片内点击不关闭，遮罩点击关闭", async () => {
    render(<Fixture />);
    await userEvent.click(screen.getByText("打开设置"));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    fireEvent.click(dialog);
    expect(dialog).toBeInTheDocument();
    fireEvent.click(dialog.parentElement!);
    expect(dialog).not.toBeInTheDocument();
  });
});
