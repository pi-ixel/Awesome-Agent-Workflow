import type { SubagentToolPresentation } from "../../../acpRuntime/types.ts";
import type { SubagentCompaction } from "../../../acpRuntime/types.ts";

export function SubagentProgressView({
  agent,
  active,
}: {
  readonly agent: SubagentToolPresentation;
  readonly active: boolean;
}) {
  const progress = agent.progress;
  const counters = progress && !active && agent.stats ? agent.stats : progress;
  const compactions = agent.compactions ?? [];
  const number = new Intl.NumberFormat("zh-CN");
  const parts = [
    ...(counters?.toolCalls !== undefined
      ? [`已完成工具调用：${number.format(counters.toolCalls)} 次`]
      : []),
    ...(counters?.contextTokens !== undefined
      ? [`上下文：${number.format(counters.contextTokens)} tokens`]
      : []),
    ...(counters?.totalTokens !== undefined
      ? [`累计消耗：${number.format(counters.totalTokens)} tokens`]
      : []),
  ];
  function compactionLabel(record: SubagentCompaction) {
    switch (record.state) {
      case "committed":
        return "已应用";
      case "awaiting_commit":
        return active && agent.phase !== "aborted"
          ? "计算结束，等待应用确认"
          : "计算结束，未收到应用确认";
      case "failed":
        return "压缩失败";
      case "finished":
        return `压缩结束（${record.outcome || "结果未知"}）`;
      case "running":
        return !active || agent.phase === "aborted"
          ? "未收到结束通知"
          : agent.phase === "paused"
            ? "压缩暂停"
            : "压缩中";
    }
  }
  if (!parts.length && !progress?.unreportedAttempts && !compactions.length)
    return null;
  return (
    <div
      className="mt-2 space-y-1 text-xs text-ink-mute"
      aria-label="子代理进度"
    >
      {!!parts.length && <div>{parts.join(" · ")}</div>}
      {!!progress?.unreportedAttempts && (
        <div>
          有 {number.format(progress.unreportedAttempts)}{" "}
          次调用未报告用量，累计消耗可能不完整
        </div>
      )}
      {!!compactions.length && (
        <details className="rounded-lg border border-line p-2" open={active}>
          <summary className="cursor-pointer">
            上下文压缩（已应用{" "}
            {
              compactions.filter((record) => record.state === "committed")
                .length
            }{" "}
            次）
          </summary>
          <ol className="mt-2 space-y-2">
            {compactions.map((record, index) => (
              <li key={record.id}>
                <div>
                  第 {index + 1} 次：{compactionLabel(record)}
                  {record.stage ? ` · ${record.stage}` : ""}
                  {record.durationMs !== undefined
                    ? ` · ${record.durationMs} ms`
                    : ""}
                </div>
                {record.failureReason && (
                  <div className="whitespace-pre-wrap break-words">
                    失败原因：{record.failureReason}
                  </div>
                )}
                {record.warning && (
                  <div className="whitespace-pre-wrap break-words">
                    格式提示：{record.warning}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
