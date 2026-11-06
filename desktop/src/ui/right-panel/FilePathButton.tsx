import { useState } from "react";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { resolveFileReference } from "../../core/panelPaths.ts";
import { panelError } from "../../core/panelService.ts";
import { openPanelPath } from "./openPanelPath.ts";

export function FilePathButton({
  path,
  line,
}: {
  path: string;
  line?: number;
}) {
  const project = useWorkspaceStore((state) => state.activePath);
  const [error, setError] = useState<string | null>(null);
  const reference = project ? resolveFileReference(project, path) : null;
  return (
    <span className="min-w-0">
      <button
        disabled={!reference}
        title={path}
        className="max-w-full truncate text-left text-accent-ink underline decoration-dotted disabled:text-ink-faint"
        onClick={() => {
          if (reference && project) {
            setError(null);
            void openPanelPath(
              project,
              reference.path,
              line ?? reference.line,
            ).catch((cause: unknown) => setError(panelError(cause)));
          }
        }}
      >
        {path}
        {line !== undefined ? `:${line}` : ""}
      </button>
      {error && (
        <span role="alert" className="block whitespace-normal text-danger-ink">
          {error}
        </span>
      )}
    </span>
  );
}
