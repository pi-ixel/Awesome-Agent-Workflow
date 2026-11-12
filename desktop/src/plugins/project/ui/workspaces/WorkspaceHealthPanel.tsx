/**
 * 健康检查明细：对所选目录展示 iCode / uv / aaw CLI / .sdd 的
 * 通过/警告/失败 与中文修复指引。摘要 chip 与「重新检查」按钮在项目
 * 状态行（ProjectOverview），本组件只渲染明细行——工具路径的修改入口
 * 在设置页，这里不再提供编辑区（诊断结论与配置入口不再互相打架）。
 *
 * 异步检查由项目总览（ProjectOverview）在所示项目变化时触发，本面板
 * 只负责渲染 store 状态。
 */
import { useWorkspaceValue } from "../bindings/workspaceView.ts";
import type {
  HealthCheckItem,
  HealthCheckStatus,
} from "../../workspace/types.ts";

/** 状态 → 展示文案与配色（语义 token，双主题自适应）。 */
const STATUS_PRESENTATION: Readonly<
  Record<
    HealthCheckStatus,
    {
      readonly label: string;
      readonly glyph: string;
      readonly className: string;
    }
  >
> = {
  pass: { label: "通过", glyph: "✓", className: "text-ok-ink" },
  warn: { label: "警告", glyph: "⚠", className: "text-warn-ink" },
  fail: { label: "失败", glyph: "✕", className: "text-danger-ink" },
};

function HealthCheckItemRow({ item }: { readonly item: HealthCheckItem }) {
  const presentation = STATUS_PRESENTATION[item.status];
  return (
    <li className="rounded-md border border-line bg-base px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span
          className={`shrink-0 font-mono text-sm ${presentation.className}`}
        >
          {presentation.glyph}
        </span>
        <span className="shrink-0 text-sm font-medium text-ink">
          {item.label}
        </span>
        <span className={`shrink-0 text-xs ${presentation.className}`}>
          {presentation.label}
        </span>
        <span
          className="ml-auto truncate pl-2 font-mono text-2xs text-ink-faint"
          data-hint={item.summary}
        >
          {item.summary}
        </span>
      </div>
      {item.fixHint !== "" && (
        <p className="mt-1.5 border-l-2 border-line-strong pl-2.5 text-xs leading-relaxed text-ink-mute">
          {item.fixHint}
        </p>
      )}
    </li>
  );
}

function WorkspaceHealthPanel() {
  const health = useWorkspaceValue((state) => state.health);
  const isCheckingHealth = useWorkspaceValue((state) => state.isCheckingHealth);

  if (isCheckingHealth && health === null) {
    return (
      <p className="rounded-md border border-line bg-base px-3 py-2.5 text-sm text-ink-faint">
        正在逐项探测 iCode / uv / aaw CLI 与 .sdd/ 目录…
        <span className="mt-1 block text-xs text-ink-ghost">
          aaw CLI 首次运行需要下载依赖，该项目可能需要 1–2 分钟，请稍候。
        </span>
      </p>
    );
  }

  // 无报告时不再渲染解释文案：「未检查」不是需要陈述的结论，总览状态行
  // 的「重新检查」按钮就是全部入口（空态安静原则）。
  if (health === null) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="健康检查项" className="space-y-1.5">
        {health.items.map((item) => (
          <HealthCheckItemRow key={item.id} item={item} />
        ))}
      </ul>
      <p className="text-xs text-ink-ghost">
        检查时间 {health.checkedAt.slice(11, 19)}
      </p>
    </div>
  );
}

export default WorkspaceHealthPanel;
