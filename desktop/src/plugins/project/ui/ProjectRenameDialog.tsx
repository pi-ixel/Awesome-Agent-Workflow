import { useState } from "react";
import { describeUnknownError } from "../../../shared/errors.ts";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { settingsInputClass } from "../../../shared/ui/inputStyles.ts";

export function ProjectRenameDialog({
  name,
  defaultName,
  onSave,
  onClose,
}: {
  readonly name: string;
  readonly defaultName: string;
  readonly onSave: (name: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState(name);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();
  const title = "重命名项目";

  async function save() {
    if (isSaving) return;
    setIsSaving(true);
    setError(undefined);
    try {
      await onSave(value);
      onClose();
    } catch (reason) {
      setError(describeUnknownError(reason));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ModalShell label={title} onDismiss={() => !isSaving && onClose()}>
      <form
        className="space-y-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className="text-ui-lg font-semibold text-ink">{title}</h2>
        <input
          className={settingsInputClass}
          type="text"
          aria-label="项目名称"
          placeholder={defaultName}
          value={value}
          readOnly={isSaving}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
        />
        {error && (
          <p role="alert" className="text-ui-sm text-danger-ink">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <ActionButton
            tone="secondary"
            size="compact"
            disabled={isSaving}
            onClick={onClose}
          >
            取消
          </ActionButton>
          <ActionButton
            tone="primary"
            size="compact"
            type="submit"
            disabled={isSaving}
          >
            {isSaving ? "正在保存…" : "保存"}
          </ActionButton>
        </div>
      </form>
    </ModalShell>
  );
}
