import { EditDiffView } from "./EditDiffView.tsx";

/** Render ACP tool content independently of any agent's rawOutput conventions. */
export function ToolContent({ content }: { readonly content: unknown }) {
  const entries: readonly unknown[] = Array.isArray(content) ? content : [content];
  return (
    <div className="space-y-3">
      {entries.map((entry, index) => {
        const block =
          entry !== null && typeof entry === "object"
            ? (entry as Record<string, unknown>)
            : null;
        if (
          block?.type === "diff" &&
          typeof block.path === "string" &&
          typeof block.newText === "string" &&
          (block.oldText === null || typeof block.oldText === "string")
        ) {
          return (
            <EditDiffView
              key={index}
              payload={
                block.oldText === null
                  ? { kind: "write", path: block.path, content: block.newText }
                  : {
                      kind: "edit",
                      path: block.path,
                      oldString: block.oldText,
                      newString: block.newText,
                    }
              }
            />
          );
        }
        const nested = block?.type === "content" ? block.content : entry;
        const text =
          nested !== null &&
          typeof nested === "object" &&
          (nested as Record<string, unknown>).type === "text"
            ? (nested as Record<string, unknown>).text
            : undefined;
        return (
          <pre
            key={index}
            className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs"
          >
            {typeof text === "string" ? text : JSON.stringify(entry, null, 2)}
          </pre>
        );
      })}
    </div>
  );
}
