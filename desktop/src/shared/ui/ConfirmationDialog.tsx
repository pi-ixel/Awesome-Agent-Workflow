import { useId, type ReactNode } from "react";
import { ActionButton } from "./controls.tsx";
import { ModalShell } from "./ModalShell.tsx";

export function ConfirmationDialog({
  label,
  role,
  title,
  cancelLabel = "取消",
  confirmLabel,
  tone = "danger",
  confirmDisabled,
  onCancel,
  onConfirm,
  children,
}: {
  readonly label: string;
  readonly role?: "dialog" | "alertdialog";
  readonly title: string;
  readonly cancelLabel?: string;
  readonly confirmLabel: string;
  readonly tone?: "danger" | "neutral";
  readonly confirmDisabled?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly children: ReactNode;
}) {
  const descriptionId = useId();
  return (
    <ModalShell
      label={label}
      role={role}
      descriptionId={descriptionId}
      onDismiss={onCancel}
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-ui-lg font-semibold text-ink">{title}</h2>
        <div
          id={descriptionId}
          className="space-y-3 text-sm leading-relaxed text-ink-soft"
        >
          {children}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <ActionButton
            tone="secondary"
            type="button"
            autoFocus
            onClick={onCancel}
            className="px-3 py-1.5 text-sm whitespace-nowrap"
          >
            {cancelLabel}
          </ActionButton>
          <ActionButton
            tone={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={confirmDisabled}
            className="px-3 py-1.5 text-sm whitespace-nowrap"
          >
            {confirmLabel}
          </ActionButton>
        </div>
      </div>
    </ModalShell>
  );
}
