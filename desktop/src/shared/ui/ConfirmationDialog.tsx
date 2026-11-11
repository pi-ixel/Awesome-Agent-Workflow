import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { btnDanger, btnNeutralPrimary, btnSecondary } from "./controls.tsx";
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
  return createPortal(
    <ModalShell
      label={label}
      role={role}
      descriptionId={descriptionId}
      onDismiss={onCancel}
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <div
          id={descriptionId}
          className="space-y-3 text-sm leading-relaxed text-ink-soft"
        >
          {children}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className={`${btnSecondary} px-3 py-1.5 text-sm whitespace-nowrap`}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={`${tone === "danger" ? btnDanger : btnNeutralPrimary} px-3 py-1.5 text-sm whitespace-nowrap`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>,
    document.body,
  );
}
