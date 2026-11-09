import { useState } from "react";
import {
  listLegacyAgentData,
  migrateLegacyAgentData,
} from "../legacyAgentData.ts";
import {
  useWorkbenchAgentConfiguration,
  useWorkspaceValue,
  useWorkspaceService,
} from "../../workbench/viewBindings.ts";

export function LegacyAgentDataSection() {
  const { agents } = useWorkbenchAgentConfiguration();
  const workspace = useWorkspaceService();
  const paths = useWorkspaceValue((state) => state.toolPaths);
  const [records, setRecords] = useState(listLegacyAgentData);
  const [targetSessionId, setTargetSessionId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const adapter = agents?.resolve();
  const agentKey = adapter ? agents?.selectionKey(paths) : undefined;
  return (
    <section
      aria-label="旧版会话数据恢复"
      className="space-y-3 rounded border border-line p-4"
    >
      <h3>旧版会话数据恢复</h3>
      <p className="text-sm text-ink-mute">
        旧记录没有 Agent 归属。请逐条确认后恢复到{" "}
        {adapter?.displayName ?? "所选 Agent"}
        ；保留原记录，不覆盖已有数据。恢复后重新打开会话；归档列表需重启应用刷新。
      </p>
      <button type="button" onClick={() => setRecords(listLegacyAgentData())}>
        刷新旧记录
      </button>
      {message && <p role="status">{message}</p>}
      {records.length === 0 && <p>没有待归属的旧记录</p>}
      <ul className="max-h-96 space-y-2 overflow-auto">
        {records.map((record) => (
          <li key={record.key} className="break-all border-t border-line py-2">
            <span>
              {record.kind} · {record.label}
            </span>
            {record.kind === "消息快照" && !record.label.includes("#") && (
              <label>
                目标会话 ID
                <input
                  aria-label="旧快照目标会话 ID"
                  value={targetSessionId}
                  onChange={(event) => setTargetSessionId(event.target.value)}
                />
              </label>
            )}
            <details>
              <summary>查看原数据</summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap">
                {record.value}
              </pre>
            </details>
            <button
              type="button"
              disabled={!agentKey}
              onClick={() => {
                try {
                  migrateLegacyAgentData(
                    record,
                    agentKey!,
                    localStorage,
                    targetSessionId,
                  );
                  if (record.kind === "置顶")
                    workspace?.getState().hydrateFromStorage();
                  setRecords(listLegacyAgentData());
                  setMessage(`已恢复到 ${adapter!.displayName}，原记录保留`);
                } catch (error) {
                  setMessage(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }}
            >
              将此记录恢复到 {adapter?.displayName ?? "所选 Agent"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
