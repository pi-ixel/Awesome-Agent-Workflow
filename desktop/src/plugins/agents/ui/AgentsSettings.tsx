import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { PencilIcon } from "../../../shared/ui/icons.tsx";
import { settingsInputClass } from "../../../shared/ui/SettingsPageParts";
/**
 * 设置页「Agent」分片（多 agent 管理的一等入口，UI 层组装模块）：
 *
 * - 会话 Agent 列表卡：内置 / 本机发现 / 自定义三来源；点行切换当前
 *   agent（确认后停止旧任务）；每行带「协议自检」与该 agent 最近一次自检的
 *   摘要徽标；自定义项可删除；底部添加表单 + 本机扫描。
 * - 协议自检报告卡：最近一次自检的完整检查矩阵（握手 / 能力声明 / 会话
 *   能力 / 事件观测，每行状态徽标 + 依据 + 缺失时的功能影响），深度
 *   探查（两轮真实对话：轻量回复 + 多步任务）在此发起。
 *
 * Agents 服务执行自检并持有探查结果。界面通过 protocolChecks.ts 推导检查表。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentProbeResult } from "../probe/types.ts";
import { useStore } from "zustand";
import type { ProjectService } from "../../project/service.ts";
import {
  deriveProtocolChecks,
  probeSummary,
  type CheckStatus,
} from "./protocolChecks.ts";
import type { AgentsService } from "../service.ts";
import type { ConnectionTestResult } from "../types.ts";
import {
  Badge,
  btnSecondary,
  focusVisibleRing,
  RadioDot,
  Spinner,
} from "../../../shared/ui/controls";

/** 路径 / 命令类输入（与设置页共用视觉）。 */
const textInputClass = `${settingsInputClass} font-mono`;

// ------------------------------------------------------------- 探查发起

function probeAgent(
  service: AgentsService,
  agentId: string,
  depth: "safe" | "deep",
  cwd: string,
  toolPaths: object,
): void {
  void service.runProtocolCheck(agentId, { depth, cwd, toolPaths });
}

// ------------------------------------------------------------- 摘要徽标

/** 行尾自检摘要：ok/warn/danger 计数 + 耗时（无结果显示「未检测」）。 */
function ProbeSummaryBadge({ result }: { readonly result: AgentProbeResult }) {
  const summary = useMemo(
    () => probeSummary(deriveProtocolChecks(result)),
    [result],
  );
  const tone = !result.ok ? "danger" : summary.warn > 0 ? "warn" : "ok";
  return (
    <Badge tone={tone} title="该 agent 最近一次协议自检结论">
      {result.ok
        ? `${String(summary.ok)}✓ ${String(summary.warn)}✗ ${(result.elapsedMs / 1000).toFixed(1)}s`
        : "自检失败"}
    </Badge>
  );
}

// ------------------------------------------------------------- 列表卡

/** 列表行数据（三来源统一形状）。 */
interface AgentRow {
  readonly key: string;
  readonly name: string;
  readonly source: "内置" | "本机发现" | "自定义";
  readonly tone: "ok" | "info" | "neutral";
  readonly command: string;
  readonly removable: boolean;
}

/** 会话 Agent 列表卡：切换 + 自检 + 自定义管理 + 本机扫描。 */
interface AgentsSettingsProps {
  readonly agents: AgentsService;
  readonly workspace: ProjectService["projects"]["workspace"];
  readonly switchAgent: (agentId: string) => Promise<void>;
}

interface AgentSettingsViewProps extends Omit<
  AgentsSettingsProps,
  "workspace"
> {
  readonly workspacePath: string | null;
  readonly toolPaths: object;
}

function AgentListCard({
  agents: service,
  switchAgent,
  workspacePath,
  toolPaths,
}: AgentSettingsViewProps) {
  const settings = useStore(service.configuration);
  const { activeAgentId, isScanningAgents } = settings;
  const builtins = service.listBuiltins();
  const [switchTarget, setSwitchTarget] = useState<AgentRow | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const switchRequest = useRef(0);
  const [removeAfterSwitch, setRemoveAfterSwitch] = useState<string | null>(
    null,
  );
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [commandDraft, setCommandDraft] = useState("");
  const [argsDraft, setArgsDraft] = useState("");
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [connectionResults, setConnectionResults] = useState<
    Record<string, ConnectionTestResult>
  >({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testStep, setTestStep] = useState("");

  const phase = useStore(service.probeState, (state) => state.phase);
  const step = useStore(service.probeState, (state) => state.step);
  const probingAgentId = useStore(
    service.probeState,
    (state) => state.probingAgentId,
  );
  const resultsByAgent = useStore(
    service.probeState,
    (state) => state.resultsByAgent,
  );

  useEffect(() => {
    void service.scan();
  }, [service]);

  const rows: readonly AgentRow[] = useMemo(
    () => [
      ...builtins.map((adapter) => ({
        key: adapter.id,
        name: adapter.displayName,
        source: "内置" as const,
        tone: "ok" as const,
        command: service.buildLaunch(adapter, toolPaths, null)
          .command.join(" "),
        removable: false,
      })),
      ...settings.discoveredAgents.map((item) => ({
        key: item.id,
        name: item.name,
        source: "本机发现" as const,
        tone: "info" as const,
        command:
          item.exePath === undefined
            ? `${item.name.toLowerCase()} acp · ${item.path}`
            : `${item.exePath} acp`,
        removable: false,
      })),
      ...settings.agents.map((item) => ({
        key: item.id,
        name: item.name,
        source: "自定义" as const,
        tone: "neutral" as const,
        command: item.command.join(" "),
        removable: true,
      })),
    ],
    [builtins, service, settings, toolPaths],
  );

  const submitAdd = (): void => {
    const program = commandDraft.trim().replace(/^"(.*)"$/, "$1");
    if (program.includes('"')) {
      setAddError("程序路径不能包含引号");
      return;
    }
    const base = (program.split(/[\\/]/).pop() ?? "")
      .replace(/\.(exe|cmd|bat)$/i, "")
      .toLowerCase();
    const args =
      argsDraft.trim() ||
      (builtins
        .find((adapter) => adapter.id === base)
        ?.buildLaunch({ workspacePath: null })
        .command.slice(1)
        .join(" ") ??
        (base === "opencode" ? "acp" : ""));
    const commandText = program ? `"${program}" ${args}` : "";
    const error =
      editingId === null
        ? service.addCustomAgent(nameDraft, commandText)
        : service.updateCustomAgent(editingId, nameDraft, commandText);
    setAddError(error);
    if (error === null) {
      if (editingId !== null) {
        setConnectionResults((previous) => {
          const next = { ...previous };
          delete next[editingId];
          return next;
        });
      }
      setNameDraft("");
      setCommandDraft("");
      setArgsDraft("");
      setEditingId(null);
    }
  };

  const testConnection = async (agentId: string): Promise<void> => {
    setTestingId(agentId);
    setConnectionResults((previous) => {
      const next = { ...previous };
      delete next[agentId];
      return next;
    });
    try {
      const result = await service.testConnection(
        agentId,
        toolPaths,
        setTestStep,
      );
      setConnectionResults((previous) => ({ ...previous, [agentId]: result }));
    } catch (error) {
      setConnectionResults((previous) => ({
        ...previous,
        [agentId]: { ok: false, message: String(error), stderr: "" },
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div
      aria-label="会话 Agent"
      className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface px-4"
    >
      <div className="border-b border-line px-0 py-3">
        <p className="text-ui-base font-medium text-ink">会话 Agent</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
          切换 Agent 将停止当前任务并暂停消息队列。测试连接只检查启动和 ACP
          握手，不发送对话。
        </p>
        {workspacePath === null ? (
          <p role="alert" className="mt-1 text-xs text-warn-ink">
            协议自检和深度探查需要先打开项目；测试连接无需项目。
          </p>
        ) : null}
      </div>
      {switchBusy ? (
        <p role="status" className="py-2 text-sm text-ink-soft">
          正在准备 Agent，可再次选择并确认切换。
        </p>
      ) : null}
      {switchError && !switchTarget ? (
        <p role="alert" className="py-2 text-sm text-danger-ink">
          {switchError}
        </p>
      ) : null}
      {switchTarget ? (
        <ModalShell
          label="切换 Agent 确认"
          onDismiss={() => {
            setSwitchTarget(null);
          }}
        >
          <div className="flex flex-col gap-4 p-5">
            <p>切换到 {switchTarget.name}？</p>
            <p className="text-sm text-ink-soft">
              当前任务将停止，消息队列将暂停。已保存的历史会话会保留，未完成消息不会自动重发。
            </p>
            {switchError ? (
              <p role="alert" className="text-sm text-danger-ink">
                {switchError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={btnSecondary}
                onClick={() => setSwitchTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className={btnSecondary}
                onClick={() => {
                  const request = ++switchRequest.current;
                  const removeId = removeAfterSwitch;
                  const target = switchTarget.key;
                  setSwitchBusy(true);
                  setSwitchError(null);
                  setSwitchTarget(null);
                  setRemoveAfterSwitch(null);
                  void switchAgent(target)
                    .then(() => {
                      if (request !== switchRequest.current) return;
                      if (removeId) service.removeCustomAgent(removeId);
                    })
                    .catch((error: unknown) => {
                      if (request === switchRequest.current)
                        setSwitchError(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );
                    })
                    .finally(() => {
                      if (request === switchRequest.current)
                        setSwitchBusy(false);
                    });
                }}
              >
                确认切换
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}
      {rows.map((row) => {
        const configuration = service.executableConfiguration(row.key);
        const isSelected = activeAgentId === row.key;
        const isProbingThis = phase === "probing" && probingAgentId === row.key;
        const probeResult = resultsByAgent[row.key];
        return (
          <div
            key={row.key}
            aria-label={`agent-${row.name}`}
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-line px-0 py-2.5"
          >
            <button
              type="button"
              aria-pressed={isSelected}
              onClick={() => {
                setRemoveAfterSwitch(null);
                setSwitchError(null);
                setSwitchTarget(row);
              }}
              className={`flex min-h-9 min-w-0 flex-1 basis-44 flex-wrap items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-raised/60 ${focusVisibleRing}`}
            >
              <RadioDot checked={isSelected} appearance="neutral" />
              <span className="min-w-0 break-all text-sm text-ink">
                {row.name}
              </span>
              <Badge tone={row.tone}>{row.source}</Badge>
              {isSelected ? <Badge tone="ok">当前使用</Badge> : null}
            </button>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {isProbingThis ? (
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-faint">
                  <Spinner className="h-3 w-3" />
                  {step ?? "进行中"}
                </span>
              ) : probeResult !== undefined ? (
                <ProbeSummaryBadge result={probeResult} />
              ) : (
                <span className="shrink-0 text-2xs text-ink-ghost">未自检</span>
              )}
              <button
                type="button"
                disabled={testingId !== null || phase === "probing"}
                onClick={() => {
                  void testConnection(row.key);
                }}
                className={`${btnSecondary} shrink-0 px-3 py-1.5 text-sm`}
              >
                {testingId === row.key ? `${testStep}…` : "测试连接"}
              </button>
              <button
                type="button"
                disabled={
                  phase === "probing" ||
                  testingId !== null ||
                  workspacePath === null
                }
                onClick={() => {
                  if (workspacePath !== null)
                    probeAgent(
                      service,
                      row.key,
                      "safe",
                      workspacePath,
                      toolPaths,
                    );
                }}
                className={`${btnSecondary} shrink-0 px-3 py-1.5 text-sm`}
              >
                协议自检
              </button>
              <button
                type="button"
                disabled={
                  phase === "probing" ||
                  testingId !== null ||
                  workspacePath === null
                }
                title="两轮真实对话（轮 1 轻量回复；轮 2 列目录 + 跑命令，触发思考/工具/计划/审批）——消耗两次模型调用"
                onClick={() => {
                  if (workspacePath !== null)
                    probeAgent(
                      service,
                      row.key,
                      "deep",
                      workspacePath,
                      toolPaths,
                    );
                }}
                className={`${btnSecondary} shrink-0 px-3 py-1.5 text-sm`}
              >
                深度探查
              </button>
              {!row.removable && (
                <button
                  type="button"
                  aria-label={`编辑 ${row.name}`}
                  title="编辑"
                  aria-expanded={expandedAgent === row.key}
                  className={`${btnSecondary} flex size-9 shrink-0 items-center justify-center`}
                  onClick={() =>
                    setExpandedAgent((current) =>
                      current === row.key ? null : row.key,
                    )
                  }
                >
                  <PencilIcon className="size-4" />
                </button>
              )}
              {row.removable ? (
                <>
                  <button
                    type="button"
                    aria-label={`编辑 ${row.name}`}
                    title="编辑"
                    disabled={testingId === row.key}
                    onClick={() => {
                      const entry = settings.agents.find((item) => item.id === row.key);
                      if (!entry) return;
                      setEditingId(entry.id);
                      setNameDraft(entry.name);
                      setCommandDraft(entry.command[0] ?? "");
                      setArgsDraft(
                        entry.command
                          .slice(1)
                          .map((part) => (/\s/.test(part) ? `"${part}"` : part))
                          .join(" "),
                      );
                      setAddError(null);
                    }}
                    className={`${btnSecondary} flex size-9 shrink-0 items-center justify-center`}
                  >
                    <PencilIcon className="size-4" />
                  </button>
                  <button
                    type="button"
                    disabled={testingId === row.key}
                    onClick={() => {
                      if (isSelected) {
                        setRemoveAfterSwitch(row.key);
                        setSwitchError(null);
                        setSwitchTarget(
                          rows.find(
                            (item) => item.key === builtins[0]?.id,
                          ) ?? null,
                        );
                      } else service.removeCustomAgent(row.key);
                    }}
                    className="shrink-0 rounded-md px-2 py-1.5 text-sm text-danger-ink transition-colors hover:bg-danger-bg/60"
                  >
                    删除
                  </button>
                </>
              ) : null}
            </div>
            {configuration ? (
              <div
                hidden={expandedAgent !== row.key}
                className="grid w-full grid-cols-1 items-center gap-2 rounded-lg bg-raised/40 p-3 @min-[560px]/settings:grid-cols-[auto_minmax(0,1fr)_auto]"
              >
                <label
                  htmlFor={`agent-path-${row.key}`}
                  className="shrink-0 text-xs text-ink-faint"
                >
                  {configuration.label}
                </label>
                <input
                  id={`agent-path-${row.key}`}
                  value={configuration.value}
                  disabled={testingId === row.key}
                  onChange={(event) => {
                    configuration.setValue(event.currentTarget.value);
                    setConnectionResults((previous) => {
                      const next = { ...previous };
                      delete next[row.key];
                      return next;
                    });
                  }}
                  placeholder={configuration.placeholder}
                  className={textInputClass}
                />
                <button
                  type="button"
                  disabled={configuration.probing || testingId === row.key}
                  onClick={() => {
                    setConnectionResults((previous) => {
                      const next = { ...previous };
                      delete next[row.key];
                      return next;
                    });
                    void configuration.probe();
                  }}
                  className={`${btnSecondary} shrink-0 px-3 py-1.5 text-sm`}
                >
                  {configuration.probing ? "检测中…" : "重新检测路径"}
                </button>
                {configuration.detectedPath ? (
                  <div className="flex min-w-0 items-center gap-2 @min-[560px]/settings:col-span-3">
                    <p
                      role="status"
                      title={configuration.detectedPath}
                      className="min-w-0 flex-1 truncate text-ui-caption text-ink-mute"
                    >
                      检测到：{configuration.detectedPath}
                    </p>
                    {configuration.detectedPath !== configuration.value ? (
                      <button
                        type="button"
                        disabled={
                          testingId === row.key || configuration.probing
                        }
                        className={`${btnSecondary} shrink-0 px-3 py-1.5 text-sm`}
                        onClick={() => {
                          configuration.setValue(configuration.detectedPath!);
                          setConnectionResults((previous) => {
                            const next = { ...previous };
                            delete next[row.key];
                            return next;
                          });
                        }}
                      >
                        使用检测路径
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {configuration.error ? (
                  <p
                    role="alert"
                    className="text-ui-caption text-danger-ink @min-[560px]/settings:col-span-3"
                  >
                    {configuration.error}
                  </p>
                ) : null}
                {isSelected ? (
                  <button
                    type="button"
                    className={`${btnSecondary} px-3 py-1.5 text-sm`}
                    onClick={() => {
                      setRemoveAfterSwitch(null);
                      setSwitchError(null);
                      setSwitchTarget(row);
                    }}
                  >
                    应用到当前连接
                  </button>
                ) : null}
              </div>
            ) : null}
            {!row.removable && !configuration && expandedAgent === row.key ? (
              <div className="w-full space-y-2 rounded-lg bg-raised/40 p-3">
                <label className="block text-xs text-ink-mute">
                  启动命令
                  <input
                    aria-label={`${row.name} 启动命令`}
                    readOnly
                    value={row.command}
                    className={`${textInputClass} mt-2 w-full`}
                  />
                </label>
                <p className="text-xs text-ink-mute">
                  本机发现的路径由扫描维护；如需修改，请添加自定义 Agent。
                </p>
              </div>
            ) : null}
            {connectionResults[row.key] ? (
              <div role="status" className="w-full pl-7 text-xs">
                <p
                  className={
                    connectionResults[row.key]?.ok
                      ? "text-ok-ink"
                      : "text-danger-ink"
                  }
                >
                  {connectionResults[row.key]?.message}
                </p>
                {connectionResults[row.key]?.stderr ? (
                  <details
                    open={!connectionResults[row.key]?.ok}
                    className="mt-1 text-ink-mute"
                  >
                    <summary className="cursor-pointer">进程输出</summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">
                      {connectionResults[row.key]?.stderr}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="grid grid-cols-1 items-center gap-2 border-t border-line py-3 @min-[560px]/settings:grid-cols-[minmax(0,144px)_minmax(0,1fr)_auto_auto]">
        <input
          type="text"
          aria-label="自定义 Agent 名称"
          placeholder="名称（如 内网 Agent）"
          value={nameDraft}
          onChange={(event) => {
            setNameDraft(event.currentTarget.value);
          }}
          className={settingsInputClass}
        />
        <input
          type="text"
          aria-label="自定义 Agent 程序或路径"
          placeholder="程序或路径（如 opencode）"
          value={commandDraft}
          onChange={(event) => {
            setCommandDraft(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitAdd();
          }}
          className={`${textInputClass} h-8 flex-1`}
        />
        <button
          type="button"
          onClick={submitAdd}
          className={`${btnSecondary} min-h-8 justify-self-start px-2.5 py-1 text-sm`}
        >
          {editingId === null ? "添加" : "保存修改"}
        </button>
        {editingId !== null ? (
          <button
            type="button"
            onClick={() => {
              setEditingId(null);
              setNameDraft("");
              setCommandDraft("");
              setArgsDraft("");
              setAddError(null);
            }}
            className={`${btnSecondary} min-h-8 justify-self-start px-2.5 py-1 text-sm`}
          >
            取消
          </button>
        ) : null}
      </div>
      <details
        key={addError ?? editingId ?? "new"}
        open={addError !== null || editingId !== null}
        className="border-t border-line py-3"
      >
        <summary className="cursor-pointer text-sm text-ink-mute">
          高级配置
        </summary>
        <label className="mt-3 grid gap-2 text-sm text-ink-mute">
          启动参数
          <input
            type="text"
            aria-label="自定义 Agent 启动参数"
            placeholder="启动参数（如 acp）"
            value={argsDraft}
            onChange={(event) => setArgsDraft(event.currentTarget.value)}
            className={`${textInputClass} h-8 flex-1`}
          />
        </label>
      </details>
      {addError !== null ? (
        <p role="alert" className="px-0 pb-3 text-xs text-danger-ink">
          {addError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-0 py-2.5">
        <p className="text-xs text-ink-faint">
          {isScanningAgents
            ? "正在扫描本机原生 ACP CLI…"
            : settings.discoveredAgents.length > 0
              ? `本机发现 ${String(settings.discoveredAgents.length)} 个原生 ACP CLI（OpenCode 等）`
              : "未发现其他原生 ACP CLI（仅扫描内置候选清单）"}
        </p>
        <button
          type="button"
          disabled={isScanningAgents}
          onClick={() => {
            void service.scan();
          }}
          className={`${btnSecondary} shrink-0 px-3 py-1.5 text-sm`}
        >
          重新扫描
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- 报告卡

/** 检查状态 → 徽标 tone。 */
const toneOf = (status: CheckStatus) =>
  status === "ok"
    ? "ok"
    : status === "warn"
      ? "warn"
      : status === "danger"
        ? "danger"
        : status === "info"
          ? "info"
          : "neutral";

/** 协议自检报告卡：最近一次自检的完整矩阵 + 深度探查。 */
function ProtocolReportCard({
  agents: service,
  workspacePath,
  toolPaths,
}: Omit<AgentSettingsViewProps, "switchAgent">) {
  const result = useStore(service.probeState, (state) => state.result);
  const phase = useStore(service.probeState, (state) => state.phase);
  const step = useStore(service.probeState, (state) => state.step);
  const probingAgentId = useStore(
    service.probeState,
    (state) => state.probingAgentId,
  );

  const groups = useMemo(
    () => (result === null ? [] : deriveProtocolChecks(result)),
    [result],
  );
  const summary = useMemo(() => probeSummary(groups), [groups]);

  return (
    <div
      aria-label="协议自检报告"
      className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface px-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-0 py-3">
        <p className="text-ui-base font-medium text-ink">协议自检报告</p>
        {result !== null ? (
          <>
            <span className="text-sm text-ink">
              {result.agentLabel}
              {result.agentVersion === null ? "" : ` ${result.agentVersion}`}
            </span>
            <Badge tone={result.depth === "deep" ? "info" : "neutral"}>
              {result.depth === "deep" ? "深度探查" : "安全探查"}
            </Badge>
            <span className="text-xs text-ink-faint">
              {String(summary.ok)} 项能力满足 · {String(summary.warn)}{" "}
              项缺失/待接入
              {summary.danger > 0 ? ` · ${String(summary.danger)} 项失败` : ""}
              {" · 耗时 "}
              {(result.elapsedMs / 1000).toFixed(1)}s
            </span>
          </>
        ) : null}
        {result !== null ? (
          <button
            type="button"
            disabled={phase === "probing" || workspacePath === null}
            onClick={() => {
              if (workspacePath !== null)
                probeAgent(
                  service,
                  result.agentId,
                  "deep",
                  workspacePath,
                  toolPaths,
                );
            }}
            className={`${btnSecondary} ml-auto shrink-0 min-h-8 px-2.5 py-1 text-sm`}
            title="对刚自检的 agent 发两轮真实对话（轮 1 轻量回复；轮 2 列目录 + 跑命令，触发思考/工具/计划/审批）——消耗两次模型调用"
          >
            {phase === "probing" && probingAgentId === result.agentId
              ? (step ?? "深度探查中") + "…"
              : "深度探查（消耗两次模型调用）"}
          </button>
        ) : null}
      </div>
      {/* 图例：先回答「我要不要管」——只有缺失/失败需要看，其余明示无需处理 */}
      <p className="border-b border-line px-0 py-2 text-xs leading-relaxed text-ink-ghost">
        按「能力」核验，与 agent 底座无关。读法：只看
        <span className="text-warn-ink">缺失 / 已提供未接入</span>
        的行（影响写在行内）；<span className="text-ok-ink">支持</span> 与
        <span className="text-ink-mute">待验证</span>{" "}
        无需处理（待验证＝安全探查不触发对话，属正常）；想把待验证的行坐实，
        点右上「深度探查」跑两轮真实对话（轻量回复 + 多步任务）。
      </p>
      {result === null ? (
        <p className="px-0 py-4 text-sm text-ink-faint">
          尚未自检。对上方某个 agent 点「协议自检」，即可得到它对我们全部
          接口依赖的支持矩阵——不同底座各跑一次，逐行对比差异与影响。
        </p>
      ) : (
        groups.map((group) => (
          <section
            key={group.key}
            aria-label={group.title}
            className="border-t border-line first:border-t-0"
          >
            <h3 className="px-0 pt-3 pb-1.5 text-sm font-medium text-ink">
              {group.title}
            </h3>
            {group.rows.map((row) => (
              <div key={row.key} className="px-0 py-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={toneOf(row.status)}>{row.badge}</Badge>
                  <span className="text-sm text-ink">{row.label}</span>
                </div>
                {row.detail.length > 0 || row.impact.length > 0 ? (
                  <div className="mt-1 space-y-0.5 pl-1">
                    {row.detail.length > 0 ? (
                      <p className="text-xs text-ink-mute">{row.detail}</p>
                    ) : null}
                    {row.impact.length > 0 ? (
                      <p className="text-xs text-warn-ink">
                        影响：{row.impact}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}

/** 设置页「Agent」分片：列表卡 + 报告卡。 */
export function AgentsSettingsSection({
  workspace,
  ...props
}: AgentsSettingsProps) {
  const workspacePath = useStore(
    workspace,
    (state) =>
      state.selectedPath ??
      state.activePath ??
      state.recentWorkspaces[0]?.path ??
      null,
  );
  const toolPaths = useStore(workspace, (state) => state.toolPaths);
  return (
    <div className="flex flex-col gap-5">
      <AgentListCard
        {...props}
        workspacePath={workspacePath}
        toolPaths={toolPaths}
      />
      <ProtocolReportCard
        agents={props.agents}
        workspacePath={workspacePath}
        toolPaths={toolPaths}
      />
    </div>
  );
}
