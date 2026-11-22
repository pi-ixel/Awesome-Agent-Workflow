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

function ScopedFixture() {
  const [compose, setCompose] = useState(false);
  const [settings, setSettings] = useState(false);
  return (
    <>
      <button onClick={() => setSettings(true)}>外观设置</button>
      <section aria-label="工作流面板">
        <button onClick={() => setCompose(true)}>打开撰写</button>
        {compose && (
          <ModalShell
            label="撰写"
            placement="container"
            size="composer"
            onDismiss={() => setCompose(false)}
          >
            <input aria-label="需求" autoFocus />
          </ModalShell>
        )}
      </section>
      {settings && (
        <ModalShell label="设置" onDismiss={() => setSettings(false)}>
          <button onClick={() => setSettings(false)}>关闭设置</button>
        </ModalShell>
      )}
    </>
  );
}

describe("ModalShell", () => {
  it("容器弹窗保留窗外入口，窗口弹窗可覆盖并在关闭后恢复各自的锁定范围", async () => {
    const { container } = render(<ScopedFixture />);
    const compose = screen.getByRole("button", { name: "打开撰写" });
    const settings = screen.getByRole("button", { name: "外观设置" });
    await userEvent.click(compose);
    expect(compose.inert).toBe(true);
    expect(settings.inert).not.toBe(true);
    const input = screen.getByRole("textbox", { name: "需求" });
    expect(input).toHaveFocus();
    await userEvent.click(settings);
    expect(container.inert).toBe(true);
    expect(screen.getByRole("button", { name: "关闭设置" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(container.inert).toBe(false);
    expect(compose.inert).toBe(true);
    expect(settings).toHaveFocus();
    await userEvent.click(input);
    await userEvent.keyboard("{Escape}");
    expect(compose.inert).toBe(false);
    expect(compose).toHaveFocus();
  });

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
