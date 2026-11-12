/** Legacy diagnostic view: application logs, performance and runtime snapshots. */
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { DesktopDiagnostics, DiagnosticsTab } from "../lifecycle/diagnostics.ts";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import LogView from "./LogView";
import { PerfHud } from "./PerfHud.tsx";
import type { ProjectRuntimeDebugEntry } from "../../project/types.ts";

type ReadRuntime = () => readonly ProjectRuntimeDebugEntry[];
type DiagnosticsView = Pick<DesktopDiagnostics, "view" | "logs" | "memory" | "selectTab" | "setLogLevel" | "clearLogs">;
const emptyRuntime: ReadRuntime = () => [];

function DiagnosticsPage({
  diagnostics,
  readRuntime = emptyRuntime,
}: { readonly diagnostics: DiagnosticsView; readonly readRuntime?: ReadRuntime }) {
  const tab = useStore(diagnostics.view);
  const logCount = useStore(diagnostics.logs, (state) => state.entries.length);

  // 「性能」不带计数徽标：内存 / 存储是读数不是条目数（日志页签
  // 的计数是「有多少条可查看」，性能页没有对应语义）
  const tabs: ReadonlyArray<{
    id: DiagnosticsTab;
    label: string;
    count: number | null;
  }> = [
    { id: "logs", label: "运行日志", count: logCount },
    { id: "perf", label: "性能", count: null },
    { id: "runtime", label: "运行时", count: null },
  ];

  return (
    <section aria-label="诊断" className="space-y-4">
      <header>
        <h2 className="text-lg font-medium text-ink">诊断</h2>
        <p className="mt-1 text-sm text-ink-faint">
          运行日志的环形缓冲快照（2000 条，写满覆盖最旧）。
        </p>
      </header>
      <SegmentedControl
        tabs
        groupLabel="诊断视图"
        value={tab}
        onChange={(next) => diagnostics.selectTab(next)}
        options={tabs.map(({ id, label, count }) => ({
          value: id,
          label: count === null ? label : `${label}（${count}）`,
        }))}
      />
      {tab === "logs" ? (
        <LogView
          logs={diagnostics.logs}
          setLogLevel={diagnostics.setLogLevel}
          clearLogs={diagnostics.clearLogs}
        />
      ) : tab === "runtime" ? (
        <RuntimeView readRuntime={readRuntime} />
      ) : (
        <PerfHud memory={diagnostics.memory} />
      )}
    </section>
  );
}

/** 运行时快照：每个 runtime 的忙判定与依据（归档守卫同源）。打开页签即
 *  2s 轮询刷新——快照是纯读函数，无累积无副作用。 */
function RuntimeView({ readRuntime }: { readonly readRuntime: ReadRuntime }) {
  const [snapshot, setSnapshot] = useState(readRuntime);
  useEffect(() => {
    const refresh = () => {
      setSnapshot(readRuntime());
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [readRuntime]);
  if (snapshot.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-ink-faint">
        当前没有打开的会话（没有存活的 runtime）。
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed text-ink-faint">
        忙 = 归档被禁的原因（与侧栏会话行的归档守卫同源）；空闲即「可归档」。 每
        2 秒自动刷新。
      </p>
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-ink-faint">
            <th className="py-1.5 pr-3 font-medium">会话</th>
            <th className="py-1.5 pr-3 font-medium">项目</th>
            <th className="py-1.5 pr-3 font-medium">角色</th>
            <th className="py-1.5 pr-3 font-medium">归档判定</th>
            <th className="py-1.5 font-medium">明细</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.map((entry, index) => (
            <tr
              key={`${entry.sessionId}-${index}`}
              className="border-b border-line/60"
            >
              <td className="py-1.5 pr-3 font-mono text-xs text-ink">
                {entry.sessionId ?? "（未绑定）"}
              </td>
              <td className="py-1.5 pr-3 text-xs text-ink-soft">
                {entry.workspacePath}
              </td>
              <td className="py-1.5 pr-3 text-xs text-ink-soft">
                {entry.isActive ? "当前" : entry.listOnly ? "预热" : "后台"}
              </td>
              <td className="py-1.5 pr-3 text-xs">
                {entry.agentCrashed ? (
                  <span className="text-danger-ink">
                    已崩溃：{entry.agentCrashed}
                  </span>
                ) : entry.busyReason ? (
                  <span className="text-warn-ink">{entry.busyReason}</span>
                ) : (
                  <span className="text-ok-ink">空闲（可归档）</span>
                )}
              </td>
              <td className="py-1.5 text-xs text-ink-mute">
                运行中 {entry.isAgentRunning ? "是" : "否"} · 轮次{" "}
                {entry.turnState} · 排队 {entry.queuedPrompts} · 待审批{" "}
                {entry.pendingApprovals}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default DiagnosticsPage;
