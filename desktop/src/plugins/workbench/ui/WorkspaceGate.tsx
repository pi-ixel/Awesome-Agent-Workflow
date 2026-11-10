import type { ReactNode } from "react";
import { useWorkbenchEntries } from "./bindings/react.ts";
import { WindowControls } from "./WindowControls.tsx";

function BlockingScreen({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <section
      className="fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-base text-ink"
      aria-label={label}
    >
      <div
        className="flex h-10 shrink-0 items-center"
        data-tauri-drag-region=""
      >
        <WindowControls />
      </div>
      {children}
    </section>
  );
}

export function WorkspaceGate({ children }: { readonly children: ReactNode }) {
  const Gate = useWorkbenchEntries("accessGates")[0]?.View;
  return Gate ? <Gate BlockingScreen={BlockingScreen}>{children}</Gate> : null;
}
