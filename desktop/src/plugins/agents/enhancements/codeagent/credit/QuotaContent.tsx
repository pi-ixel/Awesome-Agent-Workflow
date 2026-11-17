import type { CodeAgentCreditResult, CodeAgentCreditRow } from "../../../../host/types.ts";
import { UiIcon } from "../../../../../shared/ui/UiIcon.tsx";

const quotaKinds = [
  ["CPM", "月度"],
  ["CPD_Peak", "每日（忙时）"],
  ["CPD_Valley", "每日（闲时）"],
] as const;
const count = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const time = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function CreditIcon({ className }: { className?: string }) {
  return (
    <UiIcon className={className} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="m12 7 5 5-5 5-5-5z" fill="currentColor" opacity=".5" />
    </UiIcon>
  );
}

function QuotaRow({ label, row, compact }: {
  label: string;
  row?: CodeAgentCreditRow;
  compact: boolean;
}) {
  if (!row) {
    return <div className="flex justify-between gap-3"><span>{label}</span><span className="text-ink-mute">不可用</span></div>;
  }
  const ratio = row.total > 0 ? row.used / row.total : 1;
  const remaining = Math.max(0, row.total - row.used);
  const remainingRatio = row.total > 0 ? remaining / row.total : 0;
  const tone = remaining === 0 ? "bg-danger-ink" : ratio >= 0.8 ? "bg-warn-ink" : "bg-ink";
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{label}</span>
        <span className="shrink-0 tabular-nums text-ink-mute">剩余 {count.format(remainingRatio * 100)}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-hover" aria-hidden="true">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      <div className="flex flex-wrap justify-between gap-x-2 text-ui-caption tabular-nums text-ink-mute">
        <span>已用 {count.format(row.used)} / {count.format(row.total)}</span>
        <span>剩余 {count.format(remaining)}</span>
      </div>
      {!compact && row.resetAt && <p className="text-ui-caption text-ink-mute">重置时间 {row.resetAt}（服务端时间）</p>}
      {!compact && row.message && <p className="break-words text-ui-caption text-ink-mute">{row.message}</p>}
    </div>
  );
}

export function QuotaContent({ result, loading, compact = false }: {
  result: CodeAgentCreditResult | null;
  loading: boolean;
  compact?: boolean;
}) {
  if (result?.status === "ready" || result?.status === "stale") {
    const { rows, fetchedAt } = result.snapshot;
    return (
      <div className="space-y-3 text-ui-sm">
        {quotaKinds.map(([kind, label]) => (
          <QuotaRow key={kind} label={label} row={rows.find((row) => row.kind === kind)} compact={compact} />
        ))}
        <p className="text-ui-caption text-ink-mute" role="status">
          {result.status === "stale" ? "刷新失败 · 上次更新 " : "更新于 "}{time.format(fetchedAt)}
        </p>
      </div>
    );
  }
  const message = loading ? "正在读取额度…" :
    result?.status === "signInRequired" ? "请先在 CodeAgent CLI 登录，再刷新。" :
    result?.status === "unsupported" ? "额度查询目前仅支持 Windows 桌面端。" :
    result?.status === "unavailable" ? "暂时无法获取额度。" : "正在读取额度…";
  return <p className="text-ui-sm text-ink-mute" role="status">{message}</p>;
}
