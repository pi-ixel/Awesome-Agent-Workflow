import { describeUnknownError } from "../../../shared/errors.ts";
import { useWorkspaceValue } from "./bindings/workspaceView.ts";
import { ConversationDocumentContext } from "../conversation/ui/documentView.ts";
import { useContext, useState } from "react";
import { resolveFileReference } from "../../../shared/panelPaths.ts";

export function FilePathButton({
  path,
  line,
}: {
  path: string;
  line?: number;
}) {
  const openPath = useContext(ConversationDocumentContext)?.openPath;
  const project = useWorkspaceValue((state) => state.activePath);
  const [error, setError] = useState<string | null>(null);
  const reference = project ? resolveFileReference(project, path) : null;
  return (
    <span className="min-w-0">
      <button
        disabled={!reference || !openPath}
        data-hint={path}
        className="max-w-full truncate text-left text-accent-ink underline decoration-dotted disabled:text-ink-faint"
        onClick={() => {
          if (reference && project && openPath) {
            setError(null);
            void openPath(
              project,
              reference.path,
              line ?? reference.line,
            ).catch((cause: unknown) => setError(describeUnknownError(cause)));
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
