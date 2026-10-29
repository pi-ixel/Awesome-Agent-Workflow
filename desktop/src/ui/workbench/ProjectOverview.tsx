/**
 * 项目总览（内容区的项目视图）：回答两个问题——这个项目现在能不能干活
 * （连接态 + 健康检查），以及干到哪了（AAW 工作流状态）。
 *
 * 结构（自上而下，先诊断后动作）：
 * - 项目状态行：健康检查摘要 chip（✓n/n / ⚠ / ✕，点击展开明细）+
 *   「重新检查」｜右侧连接态与主行动按钮。摘要在行动之前，检查没过时先
 *   看到「哪一项没过」并给出「去设置工具路径」，而不是让用户点完再读
 *   一句报错；
 * - 健康检查明细：默认只在检查中 / 有警告失败时展开，全通过时收起；
 * - 工作流状态：`aaw status / next --peek --json` 的只读视图（当前 SR、
 *   阶段步骤、就绪工作单）。该项目没有 `.sdd/`（体检结论为警告）时整块
 *   收成一行说明，不占正文：没有工作流可看时，页面主体应当是「开始
 *   对话」而不是一块空面板。真的要在无 .sdd/ 的目录里起步时，会话内
 *   AAW 面板的「启动」分段能直接拉起入口向导。
 *
 * 主行动按钮不叫「连接 iCode」：用户的心智是「在这个项目里开始一条
 * 会话」，不是「建立 ACP 长连接」；agent 是谁、连没连上由行尾连接徽标与
 * 设置页承载，界面文案不点名具体 agent（后续要接更多 agent）。
 * 唯一主动作是「新建会话」（startNewSession，forceNew 跳过历史恢复），
 * 已连接也一样——连接是它的内部步骤，不做「只连接不进入」的中间态按钮。
 * **会话的入口不在总览**：会话挂在树上（项目 → 会话），进哪条对话由
 * 树上的会话行承担；总览这一级是「管理 + 发起」，不放「进入会话」——
 * 会话是工作流那一层的概念（一个工作流甚至可能横跨多条会话），项目级
 * 的「进入会话」说不清要进哪条。
 *
 * 工具路径（iCode / uv / aaw 脚本）的配置在设置页，不在这里：这里只说
 * 「哪一项没过」，改路径是设置页的事。
 *
 * 未选择项目时显示带行动入口的引导空态（添加项目主按钮）。项目名 /
 * 路径 / 「关闭项目」按钮在内容区顶部的上下文条（ContextBar 的
 * OverviewBar）。
 */
import { useState } from "react";

import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { btnGhost, btnPrimary, Spinner } from "../controls.tsx";
import { ChevronDownIcon, ChevronUpIcon } from "../icons.tsx";
import AawStatusPanel from "../AawStatusPanel.tsx";
import WorkspaceHealthPanel from "../workspaces/WorkspaceHealthPanel.tsx";
import { settingsPathsOverride } from "../workspaces/settingsLinks.ts";
import { addProjectViaDialog } from "./addProjectFlow.ts";
import { startNewSession } from "./sessionStart.ts";

/**
 * 健康检查摘要（状态行 chip 的文案与配色）。
 * **没查过就没有 chip**（返回 null）：「未检查」不是一个需要陈述的结论，
 * 行上那颗「重新检查」按钮就是全部——空态不占版面、不自我解释。
 * 检查中（无论有没有旧报告）给中性的「检查中…」。
 */
interface HealthSummary {
  readonly label: string;
  readonly className: string;
  readonly hasIssue: boolean;
}

function describeHealth(
  items: readonly { readonly label: string; readonly status: string }[] | null,
  isChecking: boolean,
): HealthSummary | null {
  if (isChecking) {
    return {
      label: "检查中…",
      className: "border-line-strong bg-base text-ink-mute",
      hasIssue: false,
    };
  }
  if (items === null) {
    return null;
  }
  const failed = items.filter((item) => item.status === "fail");
  const warned = items.filter((item) => item.status === "warn");
  if (failed.length > 0) {
    return {
      label: `✕ ${failed.map((item) => item.label).join("、")} 未通过`,
      className: "border-danger-line bg-danger-bg/50 text-danger-ink",
      hasIssue: true,
    };
  }
  if (warned.length > 0) {
    return {
      label: `⚠ ${warned.map((item) => item.label).join("、")} 需留意`,
      className: "border-warn-line bg-warn-bg/50 text-warn-ink",
      hasIssue: true,
    };
  }
  return {
    label: `✓ ${String(items.length)}/${String(items.length)} 项检查通过`,
    className: "border-ok-line bg-ok-bg/50 text-ok-ink",
    hasIssue: false,
  };
}

/** 项目状态行：健康摘要（点击开合明细）+ 连接态与连接动作。 */
function ProjectStatusRow({
  path,
  isHealthExpanded,
  onToggleHealth,
  summary,
}: {
  readonly path: string;
  readonly isHealthExpanded: boolean;
  readonly onToggleHealth: () => void;
  readonly summary: HealthSummary | null;
}) {
  const activePath = useWorkspaceStore((state) => state.activePath);
  const isConnecting = useSessionStore((state) => state.isConnecting);
  const runHealthChecks = useWorkspaceStore((state) => state.runHealthChecks);
  const isChecking = useWorkspaceStore((state) => state.isCheckingHealth);
  const toggleOverlay = useWorkbenchUiStore((state) => state.toggleOverlay);

  const isConnectingThis = isConnecting && activePath === path;

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {summary !== null && (
        <button
          type="button"
          onClick={onToggleHealth}
          aria-expanded={isHealthExpanded}
          title={isHealthExpanded ? "收起检查明细" : "展开检查明细"}
          className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${summary.className}`}
        >
          <span className="max-w-80 truncate">{summary.label}</span>
          {isHealthExpanded ? (
            <ChevronUpIcon className="h-3 w-3" />
          ) : (
            <ChevronDownIcon className="h-3 w-3" />
          )}
        </button>
      )}
      <button
        type="button"
        disabled={isChecking}
        onClick={() => void runHealthChecks(undefined, settingsPathsOverride())}
        className={`${btnGhost} shrink-0 px-2 py-1 text-xs`}
      >
        重新检查
      </button>

      <span aria-hidden={true} className="flex-1" />

      {isConnectingThis ? (
        <span className="flex items-center gap-2 rounded bg-info-bg px-2 py-1 text-xs text-info-ink">
          <Spinner className="h-3 w-3" />
          正在连接 agent 并恢复会话…
        </span>
      ) : (
        <>
          {/* 检查没过时给「先修再开始」的出口：失败原因就在上面那条摘要里 */}
          {summary !== null && summary.hasIssue && (
            <button
              type="button"
              onClick={() => {
                toggleOverlay("settings");
              }}
              className="shrink-0 text-xs text-warn-ink underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
            >
              去设置工具路径
            </button>
          )}
          {/* 唯一主动作：新建会话（连接是它的内部步骤，不单独成按钮——
              让用户去判断「连接」和「进入会话」先点哪个是界面在推卸责任）。
              已连接同样只留它：会话入口在树上，总览只管发起 */}
          <button
            type="button"
            onClick={() => {
              void startNewSession(path);
            }}
            disabled={isConnecting}
            className={`${btnPrimary} shrink-0 px-3 py-1.5 text-sm`}
          >
            新建会话
          </button>
        </>
      )}
    </div>
  );
}

/** 未选择项目时的空态引导：主行动入口（添加项目）+ 一行价值说明。 */
function EmptyState() {
  // 目录对话框不可用 / 取消时的重试提示
  const [isDialogUnavailable, setIsDialogUnavailable] = useState(false);

  const handleAddProject = (): void => {
    void addProjectViaDialog().then((path) => {
      if (path === null) {
        setIsDialogUnavailable(true);
      }
    });
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <button
        type="button"
        onClick={handleAddProject}
        className={`${btnPrimary} px-4 py-2 text-sm`}
      >
        添加项目
      </button>
      <p className="text-sm text-ink-mute">
        从左侧选择或新建一个项目目录，开始与 agent 对话。
      </p>
      <p className="text-xs text-ink-ghost">
        添加后自动健康检查，并读取项目已有的 AAW 工作流进度。
      </p>
      {isDialogUnavailable ? (
        <p role="alert" className="text-xs text-warn-ink">
          目录选择不可用或已取消，可重试，或从左侧列表选择已有项目。
        </p>
      ) : null}
    </div>
  );
}

/** 项目总览：path 为 null 时呈引导空态。 */
function ProjectOverview({ path }: { readonly path: string | null }) {
  // 明细开合：用户手动切换过即以手动值为准，否则检查中 / 有问题时自动展开
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(
    null,
  );
  const health = useWorkspaceStore((state) => state.health);
  const isCheckingHealth = useWorkspaceStore((state) => state.isCheckingHealth);
  // 无 .sdd/ 时把工作流面板收成一行（null = 跟随体检结论，用户可手动展开）
  const [aawExpanded, setAawExpanded] = useState<boolean | null>(null);

  if (path === null) {
    return <EmptyState />;
  }

  const items = health !== null && health.path === path ? health.items : null;
  const summary = describeHealth(items, isCheckingHealth);
  // 自动展开的时机：检查进行中（用户点了「重新检查」，进度应当可见）或
  // 结论里有问题。没查过保持收起（也没什么可展开的）；全通过保持收起，
  // 重新检查不把已收起的明细又顶开。
  const autoExpand = isCheckingHealth || (summary?.hasIssue ?? false);
  const isHealthExpanded = expandedOverride ?? autoExpand;
  // 体检结论里 .sdd/ 那项通过才算「这个项目有工作流可看」；结论未出时按
  // 有工作流处理（宁可先显示，也不在检查期间把内容藏起来闪一下）。
  const sddItem = items?.find((item) => item.id === "sdd-dir") ?? null;
  const hasAawWorkflow = sddItem === null || sddItem.status === "pass";
  const showAaw = aawExpanded ?? hasAawWorkflow;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <section
        aria-label="项目状态"
        className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
      >
        <ProjectStatusRow
          path={path}
          summary={summary}
          isHealthExpanded={isHealthExpanded}
          onToggleHealth={() => {
            setExpandedOverride(!isHealthExpanded);
          }}
        />
        {isHealthExpanded && <WorkspaceHealthPanel />}
      </section>
      {showAaw ? (
        <AawStatusPanel />
      ) : (
        <section
          aria-label="工作流提示"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line px-3.5 py-3 text-xs text-ink-faint"
        >
          <span>
            该项目还没有 AAW 工作流（缺 <code className="font-mono">.sdd/</code>
            ）。
          </span>
          <button
            type="button"
            onClick={() => {
              setAawExpanded(true);
            }}
            className="rounded px-1.5 py-0.5 underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
          >
            仍然查看
          </button>
        </section>
      )}
    </div>
  );
}

export default ProjectOverview;
