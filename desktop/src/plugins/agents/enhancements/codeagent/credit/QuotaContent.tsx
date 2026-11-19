import type {
  CodeAgentCreditResult,
  CodeAgentCreditRow,
  CodeAgentTokenResult,
  CodeAgentTokenRow,
} from "../../../../host/types.ts";
import { UiIcon } from "../../../../../shared/ui/UiIcon.tsx";
import { UsageMeter } from "../../../../../shared/ui/controls/UsageMeter.tsx";
import { formatTokenCount } from "../../../../../shared/formatTokenCount.ts";

const creditKinds = [
  ["CPM", "月度"],
  ["CPD_Peak", "每日忙时"],
  ["CPD_Valley", "每日闲时"],
] as const;
const tokenKinds = [
  ["TPM", "每分钟"],
  ["TPH", "每小时"],
  ["TPD", "每天"],
] as const;
const creditCount = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
});

export function CreditIcon({
  className,
  ratio = null,
}: {
  readonly className?: string;
  readonly ratio?: number | null;
}) {
  const fill = ratio === null ? null : Math.max(0, Math.min(1, ratio));
  return (
    <UiIcon className={className} viewBox="0 0 24 24" fill="none">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="1.8"
        opacity=".2"
      />
      {fill !== null && fill > 0 && (
        <circle
          data-credit-ring=""
          cx="12"
          cy="12"
          r="10"
          pathLength="100"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeDasharray={`${fill * 100} 100`}
          transform="rotate(-90 12 12)"
        />
      )}
      <path d="m12 7 5 5-5 5-5-5z" fill="currentColor" opacity=".5" />
    </UiIcon>
  );
}

function QuotaRow({
  label,
  row,
  unit,
}: {
  readonly label: string;
  readonly row?: CodeAgentCreditRow | CodeAgentTokenRow;
  readonly unit: "credit" | "tok";
}) {
  if (!row)
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-ink-soft">{label}</span>
        <span className="text-ui-caption text-ink-mute">未提供限额</span>
      </div>
    );
  const ratio = row.total > 0 ? row.used / row.total : null;
  const tone =
    ratio !== null && ratio >= 1
      ? "danger"
      : ratio !== null && ratio >= 0.8
        ? "warn"
        : "info";
  const formatCount =
    unit === "tok"
      ? formatTokenCount
      : (value: number) => creditCount.format(value);
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="shrink-0 font-medium text-ink-soft">{label}</span>
        <span className="ml-auto whitespace-nowrap text-right tabular-nums">
          <strong className="font-semibold">
            {formatCount(row.used)}/{formatCount(row.total)}
          </strong>{" "}
          <span className="text-ui-sm text-ink-mute">{unit}</span>
        </span>
      </div>
      {ratio !== null && (
        <UsageMeter
          label={`${label}已用${unit === "tok" ? " Token" : " Credit"}`}
          percent={ratio * 100}
          tone={tone}
        />
      )}
    </div>
  );
}

function QuotaStatus({
  result,
  isLoading,
}: {
  readonly result: CodeAgentCreditResult | CodeAgentTokenResult | null;
  readonly isLoading: boolean;
}) {
  const message = isLoading
    ? "正在读取额度…"
    : result?.status === "signInRequired"
      ? "请先在 CodeAgent CLI 登录，再刷新。"
      : result?.status === "unsupported"
        ? "额度查询目前仅支持 Windows 桌面端。"
        : result?.status === "unavailable"
          ? "暂时无法获取额度，请稍后重试。"
          : "正在读取额度…";
  return (
    <p className="py-3 text-ui-sm text-ink-mute" role="status">
      {message}
    </p>
  );
}

export function QuotaContent({
  result,
  isLoading,
}: {
  readonly result: CodeAgentCreditResult | null;
  readonly isLoading: boolean;
}) {
  if (result?.status !== "ready" && result?.status !== "stale")
    return <QuotaStatus result={result} isLoading={isLoading} />;
  return (
    <div className="space-y-5 text-ui-sm">
      {creditKinds.map(([kind, label]) => (
        <QuotaRow
          key={kind}
          label={label}
          row={result.snapshot.rows.find((row) => row.kind === kind)}
          unit="credit"
        />
      ))}
      {result.status === "stale" && (
        <p role="status" className="text-ui-caption text-ink-mute">
          暂时无法刷新
        </p>
      )}
    </div>
  );
}

export function TokenContent({
  result,
  isLoading,
}: {
  readonly result: CodeAgentTokenResult | null;
  readonly isLoading: boolean;
}) {
  if (result?.status !== "ready" && result?.status !== "stale")
    return (
      <p role="status" className="py-3 text-ui-sm text-ink-mute">
        {isLoading ? "正在读取额度…" : "暂无用量数据"}
      </p>
    );
  if (!result.snapshot.models.length)
    return (
      <p role="status" className="py-3 text-ui-sm text-ink-mute">
        暂无可用模型，请先在 CodeAgent CLI 加载模型列表。
      </p>
    );
  return (
    <div className="space-y-5 text-ui-sm">
      {tokenKinds.map(([kind, label]) => (
        <QuotaRow
          key={kind}
          label={label}
          row={result.snapshot.rows.find((row) => row.kind === kind)}
          unit="tok"
        />
      ))}
    </div>
  );
}
