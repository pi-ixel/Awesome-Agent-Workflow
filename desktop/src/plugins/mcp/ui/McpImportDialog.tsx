import { useState } from "react";
import type {
  ManagedMcpDefinition,
  McpImportPlan,
} from "../../../contracts/mcp/management.ts";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { settingsTextareaClass } from "../../../shared/ui/inputStyles.ts";
import { parseMcpImport } from "../runtime/importConfig.ts";

export interface McpImporter {
  preview: (
    definitions: readonly ManagedMcpDefinition[],
  ) => Promise<McpImportPlan>;
  commit: (plan: McpImportPlan) => Promise<void>;
}

const importExample = JSON.stringify(
  {
    mcpServers: {
      docs: { type: "http", url: "https://example.com/mcp" },
    },
  },
  null,
  2,
);

export function McpImportDialog({
  close,
  importer,
  isActive,
  isBusy,
  onBusy,
}: {
  close: () => void;
  importer: McpImporter;
  isActive: boolean;
  isBusy: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{
    plan?: McpImportPlan;
    skipped: McpImportPlan["skipped"];
  }>();
  const [error, setError] = useState<string>();

  function changeInput(value: string) {
    setInput(value);
    setResult(undefined);
    setError(undefined);
  }

  async function run() {
    onBusy(true);
    setError(undefined);
    try {
      if (result?.plan?.accepted.length) {
        await importer.commit(result.plan);
        close();
        return;
      }
      const parsed = parseMcpImport(input);
      const plan = parsed.definitions.length
        ? await importer.preview(parsed.definitions)
        : undefined;
      setResult({
        plan,
        skipped: [...parsed.skipped, ...(plan?.skipped ?? [])],
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setResult(undefined);
    } finally {
      onBusy(false);
    }
  }

  return (
    <div
      role="tabpanel"
      aria-label="JSON 导入"
      hidden={!isActive}
      className={isActive ? "flex min-h-0 flex-col" : "hidden"}
    >
      <section className="min-h-0 space-y-3 overflow-auto px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="mcp-import-json" className="text-ui-sm">
            粘贴标准 mcpServers JSON 配置
          </label>
          <ActionButton
            tone="ghost"
            size="compact"
            disabled={isBusy}
            onClick={() => changeInput(importExample)}
          >
            填入示例
          </ActionButton>
        </div>
        <textarea
          id="mcp-import-json"
          className={`${settingsTextareaClass} min-h-40 font-mono`}
          value={input}
          disabled={isBusy}
          onChange={(event) => changeInput(event.target.value)}
          placeholder={importExample}
          spellCheck={false}
          autoComplete="off"
        />
        {error && (
          <p role="alert" className="text-ui-sm text-danger-ink">
            {error}
          </p>
        )}
        {result && (
          <div role="status" className="space-y-1 text-ui-sm">
            <p>
              {result.plan?.accepted.length ?? 0} 项可导入，
              {result.skipped.length} 项跳过
            </p>
            {result.plan?.accepted.map((name) => (
              <p key={name} className="break-all text-ok-ink">
                {name}
              </p>
            ))}
            {result.skipped.map(({ name, reason }, index) => (
              <p key={index} className="break-all text-warn-ink">
                {name} · {reason}
              </p>
            ))}
          </div>
        )}
      </section>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
        <ActionButton
          tone="secondary"
          size="compact"
          disabled={isBusy}
          onClick={close}
        >
          取消
        </ActionButton>
        <ActionButton
          tone="primary"
          size="compact"
          disabled={isBusy || !input.trim()}
          onClick={() => void run()}
        >
          {result?.plan?.accepted.length ? "确认导入" : "预览导入"}
        </ActionButton>
      </footer>
    </div>
  );
}
