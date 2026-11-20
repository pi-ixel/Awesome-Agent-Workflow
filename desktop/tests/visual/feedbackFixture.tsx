import { useState } from "react";
import { Callout, type CalloutTone } from "../../src/shared/ui/Callout.tsx";
import { ConfirmationDialog } from "../../src/shared/ui/ConfirmationDialog.tsx";
import { ConfirmIconAction } from "../../src/shared/ui/ConfirmIconAction.tsx";
import {
  ContextMenu,
  type ContextMenuEntry,
} from "../../src/shared/ui/ContextMenu.tsx";
import { InlineConfirm } from "../../src/shared/ui/InlineConfirm.tsx";
import { TrashIcon } from "../../src/shared/ui/icons.tsx";
import { ActionButton, Checkbox } from "../../src/shared/ui/controls.tsx";
import { useMenuController } from "../../src/shared/ui/useMenuController.ts";

const tones: Readonly<Record<CalloutTone, string>> = {
  neutral: "会话已归档",
  info: "工作流改动尚未保存",
  ok: "运行报告已生成",
  warn: "等待执行权限确认",
  danger: "读取发布记录失败",
};

const longLabel = "导出发布记录 workflow-release-manifest-2026-11-20-export";
const menuEntries: readonly ContextMenuEntry[] = [
  { id: "export", label: longLabel, onSelect: () => {} },
  { id: "retry", label: "重试连接", warning: true, onSelect: () => {} },
  { id: "case", label: "区分大小写", checked: true, onSelect: () => {} },
  {
    id: "preview",
    label: "预览模式",
    radio: true,
    selected: true,
    onSelect: () => {},
  },
  { type: "separator" },
  {
    id: "restore",
    label: "恢复删除的记录",
    disabled: true,
    onSelect: () => {},
  },
  { id: "delete", label: "删除归档记录", danger: true, onSelect: () => {} },
];

export function FeedbackFixture() {
  const { menu, open, dismiss } = useMenuController();
  const [confirm, setConfirm] = useState<"danger" | "neutral" | null>(null);
  const [confirmedScope, setConfirmedScope] = useState(false);
  const [inline, setInline] = useState(false);
  const [icon, setIcon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showError, setShowError] = useState(true);
  return (
    <section aria-label="提示与确认" className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          tone="secondary"
          size="compact"
          aria-haspopup="menu"
          aria-expanded={menu?.id === "operations" && !menu.closing}
          onClick={(event) =>
            open("operations", "项目操作", menuEntries, {
              trigger: event.currentTarget,
            })
          }
        >
          操作菜单
        </ActionButton>
        <ActionButton
          tone="secondary"
          size="compact"
          onClick={() => {
            setConfirmedScope(false);
            setConfirm("danger");
          }}
        >
          删除确认
        </ActionButton>
        <ActionButton
          tone="secondary"
          size="compact"
          onClick={() => setConfirm("neutral")}
        >
          退出确认
        </ActionButton>
        <ActionButton
          tone="secondary"
          size="compact"
          onClick={() => setInline(true)}
        >
          放弃草稿
        </ActionButton>
        <ConfirmIconAction
          label="移除记录"
          confirming={icon}
          setConfirming={setIcon}
          onConfirm={() => {}}
          icon={<TrashIcon className="ui-icon-16" />}
        />
      </div>
      <Checkbox label="模拟提交中" checked={busy} onChange={setBusy} />
      {inline && (
        <InlineConfirm
          label="确认放弃草稿"
          message="放弃后草稿无法恢复。"
          confirmLabel="放弃"
          busy={busy}
          onConfirm={() => setInline(false)}
          onCancel={() => setInline(false)}
        />
      )}
      {Object.entries(tones).map(([tone, title]) =>
        tone === "danger" && !showError ? null : (
          <Callout
            key={tone}
            role={tone === "danger" ? "alert" : "status"}
            tone={tone as CalloutTone}
            title={title}
            label={title}
            details={
              tone === "danger" ? "E_RELEASE_LOG_UNAVAILABLE" : undefined
            }
            onDismiss={
              tone === "danger" ? () => setShowError(false) : undefined
            }
          >
            请查看当前项目的归档和发布记录。
          </Callout>
        ),
      )}
      {menu && (
        <ContextMenu
          label={menu.label}
          entries={menu.entries}
          placement={menu.placement}
          trigger={menu.trigger}
          closing={menu.closing}
          onDismiss={dismiss}
        />
      )}
      {confirm && (
        <ConfirmationDialog
          label={confirm === "danger" ? "删除归档记录" : "退出应用"}
          title={confirm === "danger" ? "确认删除发布归档？" : "确认退出应用？"}
          role={confirm === "danger" ? "alertdialog" : "dialog"}
          confirmLabel={confirm === "danger" ? "删除" : "退出"}
          confirmDisabled={confirm === "danger" && !confirmedScope}
          tone={confirm}
          onConfirm={() => setConfirm(null)}
          onCancel={() => setConfirm(null)}
        >
          {confirm === "danger" ? (
            <Checkbox
              label="已核对清理范围"
              checked={confirmedScope}
              onChange={setConfirmedScope}
            />
          ) : (
            <p>退出后将释放当前窗口占用的资源。</p>
          )}
        </ConfirmationDialog>
      )}
    </section>
  );
}
