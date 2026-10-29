/**
 * 工作流状态面板（进度 + 当前工作单）：`aaw status / next --peek
 * --json` 的只读渲染，项目总览与会话内 AAW 面板共用的展示件。
 *
 * 它回答的是**人的**三个问题：现在在哪一步、这一步要产出什么、卡在哪。
 * 因此面板里看不到 agent 内部的执行细节——`done` 命令行、argv 预览这类
 * 东西一律收进可展开的「执行详情」，默认不露。
 *
 * 为什么默认不露 done：`aaw done` 是 skill 派给 agent 的动作
 * （skills/aaw-workflow/SKILL.md 里就写着让 agent 调它），工作单的
 * `prompt` / `skill` / `data_file` 已经把它要的一切都给了 agent。把
 * `python D:/…/aaw.py done --sr SR-123 1 --json` 这种绝对路径摊给用户，
 * 等于把自动的事情手动化，还顺手把引擎的实现细节贴到用户脸上。用户在这
 * 套流程里唯一真正需要决策的点是**放行**（pending_user_confirm）。
 *
 * 面板自身不下场写状态（不直接调 CLI）：唯一的交互是「刷新」与「自动
 * 刷新开关」。当调用方注入 onRunCommand 时（会话内 AAW 面板），放行给出
 * 一个「放行进入下一步」动作——把自然语言请求发给会话侧 agent，由 agent
 * 执行；未注入时（项目总览）保持纯展示。
 */
import { useState } from "react";
import { useAawStatusStore } from "../stores/aawStatusStore.ts";
import {
  Badge,
  btnSecondary,
  Listbox,
  ProgressBar,
  ToggleSwitch,
} from "./controls.tsx";
import {
  deriveStepPhases,
  formatArgvPreview,
  type AawStepPhase,
  type AawWorkOrder,
} from "../aaw/workflowModel.ts";

/** 步骤条相位的展示样式与中文标签（语义 token，双主题自适应）。 */
const PHASE_VIEWS: Readonly<
  Record<AawStepPhase, { label: string; chip: string }>
> = {
  completed: {
    label: "已完成",
    chip: "border-ok-line bg-ok-bg/40 text-ok-ink",
  },
  current: {
    label: "当前",
    chip: "border-sky-600 bg-info-bg/40 text-accent-ink",
  },
  pending: {
    label: "待办",
    chip: "border-line-strong bg-surface text-ink-faint",
  },
  failed: {
    label: "失败",
    chip: "border-danger-line bg-danger-bg/40 text-danger-ink",
  },
  blocked: {
    label: "受阻",
    chip: "border-warn-line bg-warn-bg/40 text-warn-ink",
  },
  superseded: {
    label: "已作废",
    chip: "border-line-strong bg-base text-ink-ghost",
  },
};

/** 可展开的「执行详情」：agent 侧命令的原文，默认收起。 */
function ExecutionDetails({
  label,
  argv,
}: {
  readonly label: string;
  readonly argv: readonly string[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        className="text-2xs text-ink-faint underline decoration-dotted underline-offset-2 transition-colors hover:text-ink-mute"
      >
        {isOpen ? "收起执行详情" : "执行详情"}
      </button>
      {isOpen ? (
        <p
          className="mt-1 rounded bg-surface px-2 py-1.5 font-mono text-2xs leading-relaxed break-all whitespace-pre-wrap text-ink-mute"
          title={formatArgvPreview(argv)}
        >
          <span className="text-ink-ghost">{label} </span>
          {formatArgvPreview(argv)}
        </p>
      ) : null}
    </div>
  );
}

function WorkOrderCard({ order }: { readonly order: AawWorkOrder }) {
  return (
    <li className="rounded-md border border-line bg-base p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-ui-xs text-ink-faint">#{order.id}</span>
        <span className="text-ui-base font-medium text-ink">{order.name}</span>
        {order.isGate ? <Badge tone="warn">门禁</Badge> : null}
        {order.taskDevPhase !== null ? (
          <Badge tone="neutral">阶段：{order.taskDevPhase}</Badge>
        ) : null}
      </div>

      {order.skill.length > 0 ? (
        <p className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-2xs text-ink-faint">点名 skill</span>
          {order.skill.map((name) => (
            <Badge key={name} tone="info">
              <span className="font-mono">{name}</span>
            </Badge>
          ))}
        </p>
      ) : null}

      {order.inputs?.blocked ? (
        <p className="mt-2 rounded border border-danger-line bg-danger-bg/60 px-2 py-1 text-xs text-danger-ink">
          必需输入缺失，工作单不可执行：
          {order.inputs.missingRequired.join("、")}
        </p>
      ) : null}

      <dl className="mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-faint">需提交数据</dt>
        <dd className="text-ink-soft">{order.dataRequired ? "是" : "否"}</dd>
        <dt className="text-ink-faint">强制交付件</dt>
        <dd className="text-ink-soft">
          {order.deliverablesReady === null
            ? "—"
            : order.deliverablesReady
              ? "已齐全"
              : "未齐全（完成前须补齐）"}
        </dd>
      </dl>

      {/* done 由 agent 在完成本步时自己执行（skill 已把命令给了它）；
          这里只在用户主动展开时露出原文，不作为待办动作呈现 */}
      {order.doneArgv !== null ? (
        <ExecutionDetails label="完成命令" argv={order.doneArgv} />
      ) : null}
    </li>
  );
}

export interface AawStatusPanelProps {
  /**
   * 「放行」动作的出口：把一条自然语言请求交给会话侧执行（注入时出现
   * 「放行进入下一步」按钮）。不注入（项目总览）则保持纯只读展示——总览
   * 不是执行现场，真正的执行要在会话里。
   */
  readonly onRunCommand?: (command: string) => void;
}

function AawStatusPanel({ onRunCommand }: AawStatusPanelProps = {}) {
  const loader = useAawStatusStore((state) => state.loader);
  const srs = useAawStatusStore((state) => state.srs);
  const currentSr = useAawStatusStore((state) => state.currentSr);
  const status = useAawStatusStore((state) => state.status);
  const next = useAawStatusStore((state) => state.next);
  const isLoading = useAawStatusStore((state) => state.isLoading);
  const lastError = useAawStatusStore((state) => state.lastError);
  const lastRefreshedAt = useAawStatusStore((state) => state.lastRefreshedAt);
  const autoRefresh = useAawStatusStore((state) => state.autoRefresh);
  const selectSr = useAawStatusStore((state) => state.selectSr);
  const refresh = useAawStatusStore((state) => state.refresh);
  const setAutoRefresh = useAawStatusStore((state) => state.setAutoRefresh);

  const phases = status === null ? [] : deriveStepPhases(status.steps);
  const doneCount =
    status === null ? 0 : status.steps.filter((step) => step.finished).length;

  return (
    <section
      aria-label="工作流状态"
      className="rounded-lg border border-line bg-surface p-4"
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-ui-base font-medium text-ink">工作流状态</h3>
          <p className="mt-0.5 text-xs text-ink-faint">
            只读进度；推进与放行回到会话里执行。
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-ink-mute">
            <ToggleSwitch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              label="会话事件自动刷新"
            />
            会话事件自动刷新
          </label>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={isLoading || loader === null}
            className={`${btnSecondary} px-2.5 py-1 text-xs`}
          >
            {isLoading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>

      {/* 未绑定数据源且尚无任何数据时显示空态；一旦有数据——来自真实
          loader 的刷新——即按同一视图渲染。 */}
      {loader === null &&
      srs.length === 0 &&
      status === null &&
      next === null ? (
        <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-ink-faint">
          尚未连接工作流数据源，请选择项目并检查工具路径设置。
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="flex items-center gap-1.5 text-ink-mute">
              当前 SR
              <Listbox
                label="当前 SR"
                value={currentSr}
                options={srs.map((sr) => ({ value: sr, label: sr }))}
                onChange={selectSr}
                disabled={srs.length === 0}
                className="py-1 text-xs"
              />
            </span>
            {status !== null ? (
              <Badge tone="neutral">
                入口 {status.entry} · {status.status}
              </Badge>
            ) : null}
            {status !== null ? (
              <span
                className="flex items-center gap-1.5 text-ink-faint"
                aria-label={`进度 ${doneCount}/${status.steps.length}`}
              >
                进度
                <ProgressBar
                  value={doneCount}
                  max={status.steps.length}
                  className="h-1 w-20"
                />
                <span className="font-mono tabular-nums">
                  {doneCount}/{status.steps.length}
                </span>
              </span>
            ) : null}
            {lastRefreshedAt !== null ? (
              <span className="text-ink-ghost">
                刷新于 {lastRefreshedAt.slice(11, 19)}
              </span>
            ) : null}
          </div>

          {lastError !== null ? (
            <p
              role="alert"
              className="rounded border border-danger-line bg-danger-bg/60 px-3 py-2 text-xs whitespace-pre-wrap break-words text-danger-ink"
            >
              {lastError}
              {lastRefreshedAt !== null
                ? "（刷新失败，显示上次读取结果）"
                : null}
            </p>
          ) : null}

          {isLoading && lastRefreshedAt === null ? (
            <p
              role="status"
              className="px-3 py-6 text-center text-sm text-ink-faint"
            >
              正在读取工作流…
            </p>
          ) : null}

          {!isLoading &&
          lastError === null &&
          lastRefreshedAt !== null &&
          srs.length === 0 &&
          status === null ? (
            <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-ink-faint">
              当前项目暂无 AAW 工作流（.sdd/ 下没有 workflow.yaml）。
            </p>
          ) : null}

          {status?.definitionDrift !== null &&
          status?.definitionDrift !== undefined ? (
            <p className="rounded border border-warn-line bg-warn-bg/40 px-3 py-2 text-xs text-warn-ink">
              定义版本漂移：{status.definitionDrift.message}
            </p>
          ) : null}

          {status !== null && status.steps.length > 0 ? (
            <div>
              <h4 className="mb-2 text-xs font-medium text-ink-mute">
                阶段步骤
              </h4>
              {/* 自适应换行网格：窄栏下步骤 chip 换行而不是溢出裁切，
                  保证「当前」这一关键状态任何宽度下都完整可读。 */}
              <ol
                aria-label="阶段步骤"
                className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1.5"
              >
                {status.steps.map((step, index) => {
                  const phase = phases[index] ?? "pending";
                  const view = PHASE_VIEWS[phase];
                  return (
                    <li
                      key={step.id}
                      className={`flex min-w-0 flex-col gap-1 rounded-md border px-2.5 py-2 ${view.chip}`}
                      title={`${step.type} · ${step.execution}`}
                    >
                      <span className="flex items-center gap-1 text-2xs opacity-80">
                        {view.label}
                        {step.isGate ? (
                          <span className="rounded bg-warn-bg/80 px-1 text-2xs text-warn-ink">
                            门禁
                          </span>
                        ) : null}
                      </span>
                      <span className="text-ui-base leading-snug">
                        <span className="font-mono opacity-60">{step.id} </span>
                        {step.name}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          {next !== null ? (
            <div>
              <h4 className="mb-2 text-xs font-medium text-ink-mute">
                当前工作单
              </h4>
              {next.done ? (
                <p className="rounded-md border border-ok-line bg-ok-bg/40 px-3 py-3 text-sm text-ok-ink">
                  🎉 工作流已完成（全部 step 已结束）。
                </p>
              ) : next.awaitingUserConfirm ? (
                <div className="rounded-md border border-info-line bg-info-bg/40 p-3 text-xs text-info-ink">
                  <p>
                    {next.message ??
                      "当前步骤已完成，等待用户确认是否放行进入下一步。"}
                  </p>
                  {next.pendingUserConfirm !== null ? (
                    <p className="mt-1.5 text-info-ink/80">
                      来源：#{next.pendingUserConfirm.fromStep}{" "}
                      {next.pendingUserConfirm.fromName} → 待放行：
                      {next.pendingUserConfirm.plannedNext
                        .map((item) => `#${item.id ?? "?"} ${item.name ?? ""}`)
                        .join("、")}
                    </p>
                  ) : null}
                  {/* 全流程里唯一真正需要人拍板的一步：给一个动作，且按人话
                      说（「放行到下一步」），命令行留在执行详情里 */}
                  {onRunCommand !== undefined ? (
                    <button
                      type="button"
                      onClick={() => {
                        onRunCommand(
                          "本步已完成，请放行到下一步并继续推进工作流；完成后回显当前进度。",
                        );
                      }}
                      className={`${btnSecondary} mt-2 px-2.5 py-1 text-xs`}
                    >
                      放行进入下一步
                    </button>
                  ) : (
                    <p className="mt-2 text-info-ink/60">
                      放行在会话里执行（项目总览只读）。
                    </p>
                  )}
                  {next.userConfirmArgv !== null ? (
                    <ExecutionDetails
                      label="放行命令"
                      argv={next.userConfirmArgv}
                    />
                  ) : null}
                </div>
              ) : next.ready.length === 0 ? (
                <p className="rounded-md border border-dashed border-line px-3 py-3 text-xs text-ink-faint">
                  暂无就绪工作单（可能存在前置未满足的步骤）。
                </p>
              ) : (
                <ul aria-label="就绪工作单" className="space-y-2">
                  {next.ready.map((order) => (
                    <WorkOrderCard key={order.id} order={order} />
                  ))}
                </ul>
              )}
              {next.definitionDrift !== null ? (
                <p className="mt-2 rounded border border-warn-line bg-warn-bg/40 px-3 py-2 text-xs text-warn-ink">
                  定义版本漂移：{next.definitionDrift.message}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default AawStatusPanel;
