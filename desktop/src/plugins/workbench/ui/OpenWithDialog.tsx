import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import type { WorkbenchContributions } from "../types.ts";

type Opener = WorkbenchContributions["pathResolvers"];

export function OpenWithDialog({
  choices,
  choose,
}: {
  readonly choices: readonly Opener[];
  readonly choose: (choice?: Opener) => void;
}) {
  return (
    <ModalShell label="打开方式" onDismiss={() => choose()}>
      <div className="flex flex-col gap-2 p-5">
        <h2 className="text-ui-lg font-semibold">打开方式</h2>
        {choices.map((choice) => (
          <NavigationRow key={choice.id} onClick={() => choose(choice)}>
            {choice.label}
          </NavigationRow>
        ))}
        <ActionButton
          tone="secondary"
          className="self-end px-3 py-1"
          onClick={() => choose()}
        >
          取消
        </ActionButton>
      </div>
    </ModalShell>
  );
}
