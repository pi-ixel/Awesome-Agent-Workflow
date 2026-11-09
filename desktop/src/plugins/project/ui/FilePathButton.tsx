import { panelError } from "../../../shared/panelError.ts";
import {
  useWorkbenchDocuments,
  useWorkbenchLayout,
  useWorkspaceValue,
  openPanelPath,
} from "../../workbench/viewBindings.ts";
import { useState } from "react";
import { resolveFileReference } from "../../../shared/panelPaths.ts";

export function FilePathButton({
  path,
  line,
}: {
  path: string;
  line?: number;
}) {
  const workbenchLayout = useWorkbenchLayout();
  const documents = useWorkbenchDocuments();
  const project = useWorkspaceValue((state) => state.activePath);
  const [error, setError] = useState<string | null>(null);
  const reference = project ? resolveFileReference(project, path) : null;
  return (
    <span className="min-w-0">
      <button
        disabled={!reference || !documents}
        title={path}
        className="max-w-full truncate text-left text-accent-ink underline decoration-dotted disabled:text-ink-faint"
        onClick={() => {
          if (reference && project && documents) {
            setError(null);
            void openPanelPath(
              workbenchLayout,
              documents,
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
