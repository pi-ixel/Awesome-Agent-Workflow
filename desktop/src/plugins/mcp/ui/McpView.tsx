import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import type {
  ManagedMcpEntry,
  ManagedMcpSnapshot,
  McpChange,
  McpInspection,
  McpProfile,
  NativeMcpEntry,
  NativeMcpDraft,
  NativeMcpSnapshot,
} from "../../../contracts/mcp/management.ts";
import type { RuntimeSnapshot } from "../../acpRuntime/types.ts";
import { ActionButton, ToggleSwitch } from "../../../shared/ui/controls.tsx";
import { EdgeDrawer } from "../../../shared/ui/controls/EdgeDrawer.tsx";
import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { PageHeader } from "../../../shared/ui/PageHeader.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import {
  PageFilterListbox,
  PageFilterSearch,
} from "../../../shared/ui/PageFilterControls.tsx";
import { PlugIcon, PlusIcon, TrashIcon } from "../../../shared/ui/icons.tsx";
import type { BuiltinMcp } from "../service.ts";
import type { SessionMcpTargets } from "../../project/service.ts";
import {
  builtinInspection,
  builtinSessionSources,
  matchesBuiltin,
} from "../runtime/builtinInspection.ts";
import { useBuiltinControls } from "./builtinControls.ts";
import {
  duplicateNameMessage,
  type McpManagement,
} from "../runtime/management.ts";
import { useFeedback } from "../../../shared/ui/feedback.ts";
import { McpEditor } from "./McpEditor.tsx";
import { McpServiceDetails } from "./McpServiceDetails.tsx";

type NativeTarget = {
  source: "native";
  entry: NativeMcpEntry;
  snapshot: NativeMcpSnapshot;
  profile: McpProfile;
};
type ManagedTarget = {
  source: "managed";
  entry?: ManagedMcpEntry;
  snapshot: ManagedMcpSnapshot;
};
type Target =
  (Omit<NativeTarget, "entry"> & { entry?: NativeMcpEntry }) | ManagedTarget;
type Existing = NativeTarget | (ManagedTarget & { entry: ManagedMcpEntry });
type ManagedExisting = Extract<Existing, { source: "managed" }>;
type EntryAction =
  | { kind: "toggle"; name: string; enabled: boolean }
  | { kind: "remove"; name: string };

const noBuiltins: readonly BuiltinMcp[] = [];

function builtinKey(entry: BuiltinMcp) {
  return `${entry.id}:1`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function useLoad<T>(load: () => Promise<T>, dependencies: readonly unknown[]) {
  const [result, setResult] = useState<{
    keys: readonly unknown[];
    data?: T;
    error?: string;
  }>();
  function matchesScope(keys: readonly unknown[]) {
    return (
      keys.length === dependencies.length &&
      keys.every(
        (key, index) =>
          index === dependencies.length - 1 ||
          Object.is(key, dependencies[index]),
      )
    );
  }
  useEffect(() => {
    let current = true;
    void load().then(
      (data) => {
        if (current) setResult({ keys: dependencies, data });
      },
      (error: unknown) => {
        if (current)
          setResult((previous) => ({
            keys: dependencies,
            data:
              previous && matchesScope(previous.keys)
                ? previous.data
                : undefined,
            error: errorMessage(error),
          }));
      },
    );
    return () => {
      current = false;
    };
    // 只有当前配置身份和刷新标识变化才重新读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  const matches = result && matchesScope(result.keys);
  const current = matches && result?.keys.at(-1) === dependencies.at(-1);
  return {
    data: matches ? result?.data : undefined,
    error: current ? result?.error : undefined,
    isLoading: !current,
    patch: (update: (data: T) => T) => {
      setResult((previous) =>
        previous && matchesScope(previous.keys) && previous.data !== undefined
          ? { ...previous, data: update(previous.data) }
          : previous,
      );
    },
  };
}

function McpServiceRow({
  name,
  detail,
  transport,
  status,
  selected,
  detailsId,
  toggle,
  actions,
  onSelect,
}: {
  name: string;
  detail: string;
  transport: string;
  status: string;
  selected: boolean;
  detailsId: string;
  toggle: ReactNode;
  actions?: ReactNode;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <li className="min-w-0">
      <article
        aria-label={name}
        className={`flex min-w-0 items-center gap-2 rounded-popover border bg-surface pr-3 ${selected ? "border-ink-faint" : "border-line"}`}
      >
        <NavigationRow
          layout="compound"
          aria-expanded={selected}
          aria-controls={detailsId}
          data-mcp-detail-trigger=""
          className="items-center gap-3 px-3 py-2.5"
          aria-label={name}
          onClick={onSelect}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-control bg-skill-reference-lilac/10 text-skill-reference-lilac">
            <PlugIcon className="ui-icon-16" />
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2">
              <span className="truncate text-ui-base font-semibold">
                {name}
              </span>
              <span className="text-ui-caption text-ink-mute">{transport}</span>
            </span>
            {detail && (
              <span
                data-hint={detail}
                className="block overflow-hidden text-ellipsis whitespace-nowrap text-ui-caption text-ink-mute"
              >
                {detail}
              </span>
            )}
          </span>
        </NavigationRow>
        <span
          className={`hidden shrink-0 text-ui-caption @min-[60rem]:inline ${status === "连接异常" ? "text-danger-ink" : status === "已连接" || status === "检测成功" ? "text-ok-ink" : "text-ink-mute"}`}
        >
          {status}
        </span>
        {toggle}
        {actions}
      </article>
    </li>
  );
}

function transportLabel(transport: string) {
  if (transport === "http") return "Streamable HTTP";
  if (transport === "stdio") return "本地 stdio";
  if (transport === "sse") return "远程 SSE";
  return transport;
}

function targetKey(target: Existing) {
  return JSON.stringify([
    target.source,
    target.source === "native"
      ? (target.entry.id ?? target.entry.name)
      : target.entry.name,
  ]);
}

function toolKey(serviceKey: string, name: string) {
  return JSON.stringify([serviceKey, name]);
}

function updateToolPolicy(
  disabled: readonly string[],
  tools: readonly string[],
  enabled: boolean,
) {
  return enabled
    ? disabled.filter((name) => !tools.includes(name))
    : [...new Set([...disabled, ...tools])].sort();
}

function applyEntryAction<T extends { name: string; enabled: boolean }>(
  entries: readonly T[],
  operation: EntryAction,
): T[] {
  if (operation.kind === "remove")
    return entries.filter(({ name }) => name !== operation.name);
  return entries.map((entry) =>
    entry.name === operation.name
      ? { ...entry, enabled: operation.enabled }
      : entry,
  );
}

function reportedTools(runtime: RuntimeSnapshot | undefined, name: string) {
  const tools = runtime?.mcpToolsByServer;
  return tools && Object.hasOwn(tools, name) ? tools[name] : undefined;
}

function healthKey(agentId: string, profile: string | null, target: Existing) {
  const version =
    target.source === "native"
      ? (target.entry.connectionRevision ?? target.snapshot.revision)
      : (target.entry.connectionRevision ??
        JSON.stringify([
          target.entry.transport,
          target.entry.url,
          target.entry.headers,
        ]));
  return JSON.stringify([agentId, profile, targetKey(target), version]);
}

export function McpView({
  service,
  agentId,
  activeProfile,
  builtins = noBuiltins,
  canManageNative,
  nativeTransports = [],
  canManageInjected,
  canTest,
  nativeWorkspace,
  hasScopedNative = false,
  hasHostInspection = false,
  sessionId,
  sessionMcpTargets,
  runtime,
}: {
  service: McpManagement | null;
  agentId: string;
  activeProfile: string | null;
  builtins?: readonly BuiltinMcp[];
  canManageNative: boolean;
  nativeTransports?: readonly NativeMcpDraft["transport"][];
  canManageInjected: boolean;
  canTest: boolean;
  nativeWorkspace?: string;
  hasScopedNative?: boolean;
  hasHostInspection?: boolean;
  sessionId?: string;
  sessionMcpTargets?: SessionMcpTargets;
  runtime?: RuntimeSnapshot;
}) {
  const feedback = useFeedback();
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [transportFilter, setTransportFilter] = useState("all");
  const [selection, setSelection] = useState("");
  const [isDetailClosing, setIsDetailClosing] = useState(false);
  const detailsId = useId();
  const detailDrawer = useRef<HTMLElement>(null);
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const finishDetailClose = useCallback(() => {
    setIsDetailClosing(false);
    setSelection("");
  }, []);
  useEffect(() => {
    if (!isDetailClosing) return;
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    const timer = window.setTimeout(finishDetailClose, 260);
    reducedMotion?.addEventListener("change", finishDetailClose);
    return () => {
      window.clearTimeout(timer);
      reducedMotion?.removeEventListener("change", finishDetailClose);
    };
  }, [isDetailClosing, finishDetailClose]);
  const [initialEditorTab, setInitialEditorTab] = useState<"form" | "json">(
    "form",
  );
  const [health, setHealth] = useState<Readonly<Record<string, McpInspection>>>(
    {},
  );
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const inflight = useRef(new Set<string>());
  const seen = useRef(new Set<string>());
  const [editing, setEditing] = useState<Target | null>(null);
  const [confirmation, setConfirmation] = useState<Existing | null>(null);
  const [pendingWrites, setPendingWrites] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const writes = useRef(new Set<string>());
  const writeTail = useRef(Promise.resolve());
  const revisions = useRef(
    new Map<string, { head: string; observed: Set<string> }>(),
  );
  const [failure, setFailure] = useState<string | null>(null);
  const { states: builtinControls, change: changeBuiltin } =
    useBuiltinControls(builtins);
  const inspector = service?.host.inspection;
  const native = useLoad(
    () =>
      service && canManageNative
        ? service.readNative(
            agentId,
            activeProfile,
            refresh > 0,
            nativeWorkspace,
          )
        : Promise.resolve(null),
    [
      service,
      agentId,
      activeProfile,
      canManageNative,
      refresh,
      nativeWorkspace,
    ],
  );
  const managed = useLoad(
    () =>
      service && canManageInjected
        ? service.host.managedRead(agentId)
        : Promise.resolve(null),
    [service, agentId, canManageInjected, refresh],
  );
  const builtinTools = useLoad(
    async () =>
      new Map(
        await Promise.all(
          builtins.map(
            async (entry) =>
              [
                entry,
                await Promise.resolve()
                  .then(() => entry.tools?.read())
                  .catch(() => undefined),
              ] as const,
          ),
        ),
      ),
    [builtins, refresh],
  );
  const builtinRegistrations = useLoad(
    async () =>
      new Map(
        await Promise.all(
          builtins.map(
            async (entry) =>
              [
                entry,
                sessionId &&
                (!entry.enabled || builtinControls.get(entry)?.enabled === true)
                  ? await Promise.resolve()
                      .then(() => entry.registration?.(sessionId))
                      .catch(() => null)
                  : undefined,
              ] as const,
          ),
        ),
      ),
    [builtins, builtinControls, sessionId, runtime, refresh],
  );
  const targets = useMemo(() => {
    const list: Existing[] = [];
    if (native?.data) {
      const { profile, snapshot } = native.data;
      list.push(
        ...snapshot.entries.map((entry) => ({
          source: "native" as const,
          entry,
          profile,
          snapshot,
        })),
      );
    }
    if (managed?.data) {
      const snapshot = managed.data;
      list.push(
        ...snapshot.entries.map((entry) => ({
          source: "managed" as const,
          entry,
          snapshot,
        })),
      );
    }
    return list;
  }, [native.data, managed.data]);
  const inspectionProfile =
    (hasScopedNative ? nativeWorkspace : undefined) ??
    native.data?.profile.id ??
    native.data?.profile.name ??
    activeProfile;

  const sessionSources = useMemo(
    () => builtinSessionSources(builtins),
    [builtins],
  );
  const sourceTargets = useSyncExternalStore(
    sessionSources.subscribe,
    sessionSources.read,
  );

  const builtinJobs = useMemo(() => {
    return new Map(
      builtins.flatMap((entry) => {
        if (!inspector) return [];
        const target = builtinInspection(
          entry,
          sessionMcpTargets,
          (server) => inspector.probeBuiltin(server),
          sourceTargets.get(entry),
        );
        if (!target) return [];
        const isSessionTarget = target.generation !== undefined;
        return [
          [
            entry,
            {
              key: isSessionTarget
                ? `${builtinKey(entry)}:session:${target.generation}`
                : builtinKey(entry),
              enabled:
                !entry.enabled || builtinControls.get(entry)?.enabled === true,
              manualOnly: isSessionTarget || !entry.enabled,
              isSessionTarget,
              run: target.run,
            },
          ] as const,
        ];
      }),
    );
  }, [builtins, builtinControls, inspector, sessionMcpTargets, sourceTargets]);

  const jobs = useMemo(() => {
    if (!service || !inspector) return [];
    const available = targets.flatMap((target) => {
      const { entry } = target;
      const transport = entry.transport;
      const manualOnly = target.source === "native" && hasHostInspection;
      if (transport !== "http" && !(manualOnly && transport === "stdio"))
        return [];
      if (target.source === "native" && !canTest && !manualOnly) return [];
      if (transport !== "http" && transport !== "stdio") return [];
      return [
        {
          key: healthKey(agentId, inspectionProfile, target),
          enabled: entry.enabled,
          manualOnly,
          isSessionTarget: false,
          run: async (): Promise<McpInspection> => {
            if (target.source === "managed")
              return inspector.probe(target.entry);
            const result = await service.test(agentId, {
              source: "native",
              profile: target.profile,
              previousName: entry.name,
              entryId: target.entry.id,
              entryRevision: target.entry.connectionRevision,
              workspace: nativeWorkspace,
              revision: target.snapshot.revision,
              draft: { name: entry.name, transport, secretChanges: {} },
            });
            return { ...result, checkedAt: Date.now() };
          },
        },
      ];
    });
    return [...available, ...builtinJobs.values()];
  }, [
    service,
    inspector,
    targets,
    canTest,
    hasHostInspection,
    nativeWorkspace,
    agentId,
    inspectionProfile,
    builtinJobs,
  ]);

  const runCheck = useCallback(
    async (job: (typeof jobs)[number], fresh = false) => {
      if (!service || !inspector || inflight.current.has(job.key)) return;
      seen.current.add(job.key);
      inflight.current.add(job.key);
      setPending((current) => new Set([...current, job.key]));
      const started = Date.now();
      try {
        const inspect = (): Promise<McpInspection> =>
          job.run().catch(() => ({
            ok: false,
            message: "无法完成 MCP 检测",
            checkedAt: Date.now(),
            durationMs: Date.now() - started,
          }));
        const result = job.isSessionTarget
          ? await inspect()
          : await service.inspectCached(job.key, fresh, inspect);
        setHealth((previous) => ({
          ...previous,
          [job.key]:
            !result.ok && result.tools === undefined
              ? { ...result, tools: previous[job.key]?.tools }
              : result,
        }));
      } catch {
        setFailure("暂时无法读取 MCP 检测记录，可手动检测。");
      } finally {
        inflight.current.delete(job.key);
        setPending((current) => {
          const next = new Set(current);
          next.delete(job.key);
          return next;
        });
      }
    },
    [inspector, service],
  );

  useEffect(() => {
    if (!inspector || !jobs.length || (canManageNative && native.isLoading))
      return;
    let isCurrent = true;
    const missing = jobs.filter(
      (job) => !job.isSessionTarget && !seen.current.has(job.key),
    );
    if (!missing.length) return;
    void inspector
      .read(missing.map(({ key }) => key))
      .then(async (cached) => {
        if (!isCurrent) return;
        setHealth((latest) => ({ ...cached, ...latest }));
        for (const job of missing) {
          if (!isCurrent) return;
          if (seen.current.has(job.key)) continue;
          if (cached[job.key]) seen.current.add(job.key);
          else if (job.enabled && !job.manualOnly) await runCheck(job);
        }
      })
      .catch(() => {
        if (isCurrent) setFailure("暂时无法读取 MCP 检测记录，可手动检测。");
      });
    return () => {
      isCurrent = false;
    };
  }, [inspector, jobs, runCheck, canManageNative, native.isLoading]);
  const names = new Map<string, number>();
  for (const entry of builtins)
    names.set(entry.name, (names.get(entry.name) ?? 0) + 1);
  for (const {
    entry: { name },
  } of targets)
    names.set(name, (names.get(name) ?? 0) + 1);

  const term = search.trim().toLowerCase();
  const failures = new Set(runtime?.mcpFailures.map(({ name }) => name));
  const runtimeServers = new Set(runtime?.mcpServers.map(({ name }) => name));
  function summary(
    name: string,
    key: string,
    enabled: boolean | null,
    connected: boolean,
  ) {
    if (enabled === false) return "已停用";
    if (enabled === null) return "正在读取";
    if (failures.has(name)) return "连接异常";
    if (connected) return "已连接";
    if (pending.has(key)) return "检测中";
    if (health[key]) return health[key].ok ? "检测成功" : "连接异常";
    return "未检测";
  }
  function builtinStatus(entry: BuiltinMcp) {
    const registration = builtinRegistrations.data?.get(entry);
    const enabled = entry.enabled
      ? (builtinControls.get(entry)?.enabled ?? null)
      : true;
    const failed = Array.from(failures).find((name) =>
      entry.registration
        ? name === registration?.name
        : matchesBuiltin(entry, name),
    );
    const status = summary(
      failed ?? "",
      builtinJobs.get(entry)?.key ?? builtinKey(entry),
      enabled,
      entry.registration
        ? registration?.connected === true
        : Array.from(runtimeServers).some((name) =>
            matchesBuiltin(entry, name),
          ),
    );
    return status === "未检测" ? "未确认" : status;
  }

  function builtinToolList(entry: BuiltinMcp) {
    const tools = builtinTools.data?.get(entry)?.tools;
    if (tools) return tools;
    const reported = Object.entries(runtime?.mcpToolsByServer ?? {}).filter(
      ([name]) => matchesBuiltin(entry, name),
    );
    if (reported.length === 0) {
      const job = builtinJobs.get(entry);
      return job && health[job.key]?.tools;
    }
    return [
      ...new Set(
        reported.flatMap(([name, items]) =>
          items.map((item) => {
            const prefix = `mcp__${name}__`;
            return item.startsWith(prefix) ? item.slice(prefix.length) : item;
          }),
        ),
      ),
    ].map((name) => ({ name }));
  }
  function statusOf(target: Existing) {
    const name = target.entry.name;
    const usesNative =
      target.source === "managed" &&
      (hasScopedNative
        ? targets.some(
            (item) =>
              item.source === "native" &&
              item.entry.effective &&
              item.entry.name === name,
          )
        : (names.get(name) ?? 0) > 1);
    if (usesNative && hasScopedNative && target.entry.enabled)
      return "新会话优先使用同名原生配置";
    return summary(
      usesNative ? "" : name,
      healthKey(agentId, inspectionProfile, target),
      target.entry.enabled,
      !usesNative && runtimeServers.has(name),
    );
  }
  function shows(
    haystack: string,
    enabled: boolean | null,
    transport: string,
    status: string,
  ) {
    return (
      haystack.toLowerCase().includes(term) &&
      (transportFilter === "all" || transportFilter === transport) &&
      (filter === "all" ||
        (filter === "error"
          ? status === "连接异常"
          : enabled !== null && enabled === (filter === "enabled")))
    );
  }
  const visible = targets
    .filter((target) => {
      const { entry } = target;
      const key = healthKey(agentId, inspectionProfile, target);
      return shows(
        [
          entry.name,
          entry.description,
          entry.url,
          target.source === "native" ? target.entry.command : null,
          ...(health[key]?.tools?.map(({ name }) => name) ?? []),
          ...(reportedTools(runtime, entry.name) ?? []),
        ].join(" "),
        entry.enabled,
        entry.transport,
        statusOf(target),
      );
    })
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name));
  const visibleBuiltins = builtins.filter((entry) =>
    shows(
      [
        entry.id,
        entry.name,
        entry.description,
        entry.scope,
        ...(builtinToolList(entry)?.map(({ name }) => name) ?? []),
      ].join(" "),
      builtinControls.get(entry)?.enabled ?? null,
      "builtin",
      builtinStatus(entry),
    ),
  );
  const count = targets.length + builtins.length;
  const enabledCount =
    targets.filter(({ entry }) => entry.enabled).length +
    builtins.filter((entry) => builtinControls.get(entry)?.enabled === true)
      .length;
  const errorCount =
    targets.filter((target) => statusOf(target) === "连接异常").length +
    builtins.filter((entry) => builtinStatus(entry) === "连接异常").length;
  const activeToolCount = runtime?.mcpToolsByServer
    ? Object.entries(runtime.mcpToolsByServer).reduce((sum, [name, tools]) => {
        if (failures.has(name)) return sum;
        const builtIn = builtins.find(
          (entry) =>
            matchesBuiltin(entry, name) ||
            builtinRegistrations.data?.get(entry)?.name === name,
        );
        const managedEntry = targets.find(
          (target) => target.source === "managed" && target.entry.name === name,
        );
        const hasNative = targets.some(
          (target) => target.source === "native" && target.entry.name === name,
        );
        if (
          (builtIn && builtinControls.get(builtIn)?.enabled === false) ||
          (!builtIn && !hasNative && managedEntry?.entry.enabled === false)
        )
          return sum;
        const disabled = builtIn
          ? builtinTools.data?.get(builtIn)?.disabledTools
          : !hasNative && managedEntry?.source === "managed"
            ? managedEntry.entry.disabledTools
            : undefined;
        const prefix = `mcp__${name}__`;
        return (
          sum +
          new Set(
            tools
              .map((tool) =>
                tool.startsWith(prefix) ? tool.slice(prefix.length) : tool,
              )
              .filter((tool) => !disabled?.includes(tool)),
          ).size
        );
      }, 0)
    : undefined;
  const current = selection
    ? targets.find((target) => targetKey(target) === selection)
    : undefined;
  const currentBuiltin = builtins.find(
    (entry) => builtinKey(entry) === selection,
  );
  const builtinError = builtins
    .map((entry) => builtinControls.get(entry)?.error)
    .find(Boolean);
  const isDetailVisible = Boolean(currentBuiltin || current);
  const isDetailOpen = isDetailVisible && !isDetailClosing;
  function closeDetail(restoreFocus = true) {
    if (restoreFocus) detailTrigger.current?.focus({ preventScroll: true });
    if (window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches)
      setIsDetailClosing(true);
    else finishDetailClose();
  }
  function selectDetail(key: string, trigger: HTMLButtonElement) {
    if (isDetailOpen && selection === key) {
      closeDetail();
      return;
    }
    detailTrigger.current = trigger;
    setIsDetailClosing(false);
    setSelection(key);
  }
  const isLoading =
    (canManageNative && native.isLoading && native.data === undefined) ||
    (canManageInjected && managed.isLoading && managed.data === undefined);
  const hasReadFailure = !!(native.error || managed.error);

  function toggleService(target: Existing, enabled: boolean) {
    mutate(target, { kind: "toggle", name: target.entry.name, enabled });
  }

  function builtinToggle(entry: BuiltinMcp) {
    if (!entry.enabled) return undefined;
    const control = builtinControls.get(entry);
    return (
      <ToggleSwitch
        label={entry.name + " 启用"}
        checked={control?.enabled === true}
        pending={control?.pending}
        disabled={typeof control?.enabled !== "boolean"}
        onChange={(enabled) => changeBuiltin(entry, enabled)}
      />
    );
  }

  function testButton(key: string, isBuiltin = false) {
    const job = jobs.find((candidate) => candidate.key === key);
    return (
      (job || isBuiltin) && (
        <ActionButton
          tone="secondary"
          size="compact"
          disabled={!job || (isBuiltin && !job.enabled) || pending.has(key)}
          onClick={() => {
            if (job) void runCheck(job, true);
          }}
        >
          测试连接
        </ActionButton>
      )
    );
  }

  const currentBuiltinJob = currentBuiltin && builtinJobs.get(currentBuiltin);
  const currentBuiltinHealth =
    currentBuiltinJob && health[currentBuiltinJob.key];
  function builtinInspectionNote(entry: BuiltinMcp) {
    if (!inspector) return "当前桌面环境无法检测此服务。";
    if (entry.enabled && builtinControls.get(entry)?.enabled !== true)
      return "启用服务后可测试连接。";
    if (entry.probe?.scope === "session" && !currentBuiltinJob)
      return `请打开对应会话后再检测（${entry.scope}）。`;
    return currentBuiltinHealth?.ok && builtinStatus(entry) === "已连接"
      ? currentBuiltinHealth.message
      : undefined;
  }

  function queueWrite(keys: readonly string[], action: () => Promise<void>) {
    if (keys.some((key) => writes.current.has(key))) return;
    for (const key of keys) writes.current.add(key);
    setPendingWrites(new Set(writes.current));
    setFailure(null);
    writeTail.current = writeTail.current.then(async () => {
      try {
        await action();
      } catch (error) {
        setFailure(errorMessage(error));
      } finally {
        for (const key of keys) writes.current.delete(key);
        setPendingWrites(new Set(writes.current));
      }
    });
  }

  // 队列只沿用本页面已经提交的版本，外部更改仍由原生版本校验拦截。
  function revisionFor(target: Existing) {
    const scope =
      target.source === "native"
        ? JSON.stringify([
            target.source,
            target.profile.id,
            target.profile.name,
          ])
        : target.source;
    const observed = target.snapshot.revision;
    const previous = revisions.current.get(scope);
    const known = previous?.observed.has(observed) ? previous : undefined;
    const expected = known?.head ?? observed;
    return {
      expected,
      accept: (head: string) => {
        const observed = known?.observed ?? new Set<string>();
        observed.add(expected);
        observed.add(head);
        revisions.current.set(scope, { head, observed });
        return head;
      },
    };
  }

  function setBuiltinTools(
    entry: BuiltinMcp,
    names: readonly string[],
    enabled: boolean,
  ) {
    const policy = entry.tools;
    if (!policy) return;
    const key = builtinKey(entry);
    queueWrite(
      names.map((name) => toolKey(key, name)),
      async () => {
        const disabledTools = await policy.setEnabled(names, enabled);
        builtinTools.patch((data) => {
          const current = data.get(entry);
          return current
            ? new Map(data).set(entry, { ...current, disabledTools })
            : data;
        });
      },
    );
  }

  function setTools(
    target: ManagedExisting,
    tools: readonly string[],
    enabled: boolean,
  ) {
    if (!inspector) return;
    const key = targetKey(target);
    queueWrite(
      tools.map((name) => toolKey(key, name)),
      async () => {
        const { expected, accept } = revisionFor(target);
        const revision = accept(
          await inspector.setManagedTools(
            agentId,
            target.entry.name,
            expected,
            tools,
            enabled,
          ),
        );
        managed.patch((snapshot) =>
          snapshot?.revision === expected
            ? {
                ...snapshot,
                revision,
                entries: snapshot.entries.map((entry) =>
                  entry.name === target.entry.name
                    ? {
                        ...entry,
                        disabledTools: updateToolPolicy(
                          entry.disabledTools ?? [],
                          tools,
                          enabled,
                        ),
                      }
                    : entry,
                ),
              }
            : snapshot,
        );
      },
    );
  }

  function mutate(target: Existing, operation: EntryAction) {
    if (!service) return;
    queueWrite([targetKey(target)], async () => {
      const { expected, accept } = revisionFor(target);
      if (target.source === "native") {
        const revision = accept(
          await service.nativeChange(
            agentId,
            target.profile,
            expected,
            operation,
          ),
        );
        if (hasScopedNative) {
          if (revision !== expected)
            feedback?.({
              message: "原生 MCP 配置已保存，将在新会话中生效",
              variant: "ok",
            });
          setRefresh((value) => value + 1);
        } else
          native.patch((data) =>
            data?.snapshot.revision === expected
              ? {
                  ...data,
                  snapshot: {
                    ...data.snapshot,
                    revision,
                    entries: applyEntryAction(
                      data.snapshot.entries,
                      operation,
                    ).map((entry) =>
                      operation.kind === "toggle" &&
                      entry.name === operation.name &&
                      entry.redactedConfig
                        ? {
                            ...entry,
                            redactedConfig: {
                              ...entry.redactedConfig,
                              enabled: operation.enabled,
                            },
                          }
                        : entry,
                    ),
                  },
                }
              : data,
          );
      } else {
        const revision = accept(
          await service.managedChange(
            agentId,
            activeProfile,
            expected,
            operation,
          ),
        );
        managed.patch((snapshot) =>
          snapshot?.revision === expected
            ? {
                ...snapshot,
                revision,
                entries: applyEntryAction(snapshot.entries, operation),
              }
            : snapshot,
        );
      }
      if (operation.kind === "remove") {
        setConfirmation(null);
        setSelection((selection) =>
          selection === targetKey(target) ? "" : selection,
        );
      }
    });
  }

  function checkName<T extends { name: string }>(
    change: Extract<McpChange<T>, { kind: "save" }>,
  ) {
    if (
      change.draft.name !== change.previousName &&
      builtins.some((entry) => entry.name === change.draft.name)
    )
      throw new Error(duplicateNameMessage);
  }

  async function reloadEditor(target: Target) {
    if (!service) return;
    if (target.source === "native") {
      const snapshot = await service.nativeRead(
        agentId,
        target.profile,
        nativeWorkspace,
      );
      const entry = snapshot.entries.find(
        (entry) =>
          target.entry &&
          (entry.id ?? entry.name) === (target.entry.id ?? target.entry.name),
      );
      if (target.entry && !entry)
        throw new Error("原服务已移除或改名，已保留表单输入。");
      setEditing({ ...target, snapshot, entry });
    } else {
      const snapshot = await service.host.managedRead(agentId);
      const entry = snapshot.entries.find(
        ({ name }) => name === target.entry?.name,
      );
      if (target.entry && !entry)
        throw new Error("原服务已移除或改名，已保留表单输入。");
      setEditing({ ...target, snapshot, entry });
    }
    setRefresh((version) => version + 1);
  }

  const currentHealth =
    current && health[healthKey(agentId, inspectionProfile, current)];
  const currentKey = current && healthKey(agentId, inspectionProfile, current);
  const currentTools =
    current?.source === "native"
      ? (currentHealth?.tools ??
        reportedTools(runtime, current.entry.name)?.map((name) => ({
          name,
        })))
      : currentHealth?.tools;
  const availableTransports = [
    ...new Set(targets.map(({ entry }) => entry.transport)),
  ];
  const startEditor = (tab: "form" | "json") => {
    if (!managed.data) return;
    setInitialEditorTab(tab);
    setEditing({ source: "managed", snapshot: managed.data });
  };
  const isRemoving =
    !!confirmation && pendingWrites.has(targetKey(confirmation));
  const hasWriteConflict = failure?.startsWith("配置已变化");
  const canEditCurrent =
    current?.source === "managed" ||
    (current?.source === "native" &&
      !current.entry.readOnly &&
      nativeTransports.some(
        (transport) => transport === current.entry.transport,
      ));
  function retryRead() {
    revisions.current.clear();
    setFailure(null);
    setRefresh((version) => version + 1);
  }
  return (
    <div
      className="@container flex h-full min-h-0 flex-col bg-base"
      onClickCapture={(event) => {
        const target = event.target;
        if (
          !isDetailOpen ||
          !(target instanceof Element) ||
          !event.currentTarget.contains(target) ||
          detailDrawer.current?.contains(target) ||
          target.closest("[data-mcp-detail-trigger]")
        )
          return;
        closeDetail(
          detailDrawer.current?.contains(document.activeElement) ?? false,
        );
      }}
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          !isDetailOpen ||
          editing ||
          confirmation
        )
          return;
        event.stopPropagation();
        closeDetail();
      }}
    >
      <section
        aria-label="MCP 管理"
        className="flex min-h-0 w-full flex-1 flex-col"
      >
        <PageHeader
          bordered
          title="MCP"
          count={`${count} 服务 · ${enabledCount} 已启用 · ${activeToolCount === undefined ? "会话工具未知" : `${activeToolCount} 个会话工具`}${errorCount ? ` · ${errorCount} 个异常` : ""}`}
          actions={
            <>
              {jobs.some((job) => job.enabled && !job.manualOnly) && (
                <ActionButton
                  tone="secondary"
                  size="compact"
                  disabled={pending.size > 0}
                  onClick={() => {
                    void (async () => {
                      for (const job of jobs)
                        if (job.enabled && !job.manualOnly)
                          await runCheck(job, true);
                    })();
                  }}
                >
                  全部检测
                </ActionButton>
              )}
              {canManageInjected && (
                <ActionButton
                  tone="secondary"
                  size="compact"
                  disabled={!managed.data}
                  onClick={() => startEditor("json")}
                >
                  导入 JSON
                </ActionButton>
              )}
              {hasScopedNative && (
                <ActionButton
                  tone="secondary"
                  size="compact"
                  disabled={!native.data}
                  onClick={() => {
                    if (!native.data) return;
                    setInitialEditorTab("form");
                    setEditing({ source: "native", ...native.data });
                  }}
                >
                  新增原生 MCP
                </ActionButton>
              )}
              {canManageInjected && (
                <ActionButton
                  tone="primary"
                  size="compact"
                  disabled={!managed.data}
                  onClick={() => startEditor("form")}
                >
                  <PlusIcon className="ui-icon-14" /> 新增 MCP
                </ActionButton>
              )}
            </>
          }
        />
        <div
          className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden [--mcp-drawer-width:min(46%,40rem)] motion-safe:transition-[padding-right] motion-safe:duration-200 motion-safe:ease-out ${isDetailOpen ? "@min-[48rem]:pr-(--mcp-drawer-width)" : ""}`}
        >
          <div className="mx-auto w-full min-w-0 max-w-[608px] space-y-4 overflow-auto px-6 py-4">
            <div className="flex flex-wrap items-center gap-2 border-b border-line pb-4">
              <PageFilterSearch
                label="搜索 MCP"
                className="basis-40 flex-1"
                placeholder="搜索服务名、地址、命令或工具…"
                value={search}
                onChange={setSearch}
              />
              <PageFilterListbox
                label="筛选状态"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "全部状态" },
                  { value: "enabled", label: "已启用" },
                  { value: "disabled", label: "已停用" },
                  { value: "error", label: "连接异常" },
                ]}
              />
              <PageFilterListbox
                label="筛选传输方式"
                value={transportFilter}
                onChange={setTransportFilter}
                options={[
                  { value: "all", label: "全部方式" },
                  ...(builtins.length
                    ? [{ value: "builtin", label: "内置工具" }]
                    : []),
                  ...availableTransports.map((value) => ({
                    value,
                    label: transportLabel(value),
                  })),
                ]}
              />
            </div>
            {hasReadFailure && (
              <div
                role="status"
                className="flex flex-wrap items-center gap-2 text-ui-sm text-warn-ink"
              >
                <span>
                  {native.error
                    ? "暂时无法读取 Agent 原生配置。"
                    : "暂时无法读取 Desktop 配置。"}
                </span>
                <ActionButton
                  tone="secondary"
                  size="compact"
                  onClick={retryRead}
                >
                  重新读取
                </ActionButton>
              </div>
            )}
            {native.data?.snapshot.warnings?.map((warning) => (
              <p
                key={warning}
                role="status"
                className="text-ui-sm text-warn-ink"
              >
                {warning}
              </p>
            ))}
            {!service && (
              <p className="text-ui-sm text-ink-mute">
                MCP 管理需要在 Desktop 桌面应用中使用。
              </p>
            )}
            {service && !canManageNative && !canManageInjected && (
              <p className="text-ui-sm text-ink-mute">
                当前 Agent 的 MCP 配置管理暂未接入。
              </p>
            )}
            {visibleBuiltins.length > 0 && (
              <h2 className="text-ui-caption text-ink-mute">
                AAW 内置 ({visibleBuiltins.length})
              </h2>
            )}
            <ul aria-label="MCP 服务" className="space-y-2">
              {visibleBuiltins.map((entry) => (
                <McpServiceRow
                  key={builtinKey(entry)}
                  name={entry.name}
                  detail={entry.scope}
                  transport="AAW 内置"
                  status={builtinStatus(entry)}
                  selected={isDetailOpen && currentBuiltin === entry}
                  detailsId={detailsId}
                  onSelect={(event) =>
                    selectDetail(builtinKey(entry), event.currentTarget)
                  }
                  toggle={builtinToggle(entry)}
                />
              ))}
              {visible.length > 0 && (
                <li className={visibleBuiltins.length > 0 ? "pt-3" : undefined}>
                  <h2 className="text-ui-caption text-ink-mute">
                    外部与自定义服务 ({visible.length})
                  </h2>
                </li>
              )}
              {visible.map((target) => {
                const { entry } = target;
                const key = targetKey(target);
                return (
                  <McpServiceRow
                    key={key}
                    name={entry.name}
                    transport={transportLabel(entry.transport)}
                    detail={
                      target.source === "native" && target.entry.source
                        ? target.entry.source +
                          (target.entry.readOnly ? " · 只读" : "")
                        : !hasScopedNative && (names.get(entry.name) ?? 0) > 1
                          ? duplicateNameMessage
                          : (entry.description ?? "")
                    }
                    status={statusOf(target)}
                    selected={isDetailOpen && current === target}
                    detailsId={detailsId}
                    onSelect={(event) => selectDetail(key, event.currentTarget)}
                    toggle={
                      (target.source !== "native" ||
                        !target.entry.readOnly) && (
                        <ToggleSwitch
                          label={entry.name + " 启用"}
                          checked={entry.enabled}
                          pending={pendingWrites.has(key)}
                          onChange={(enabled) => toggleService(target, enabled)}
                        />
                      )
                    }
                    actions={
                      (target.source !== "native" ||
                        !target.entry.readOnly) && (
                        <IconButton
                          iconSize="compact"
                          aria-label={entry.name + " 删除"}
                          data-hint="删除"
                          disabled={pendingWrites.has(key)}
                          onClick={() => setConfirmation(target)}
                        >
                          <TrashIcon className="ui-icon-14" />
                        </IconButton>
                      )
                    }
                  />
                );
              })}
            </ul>
            {isLoading && (
              <p role="status" className="text-ui-sm text-ink-mute">
                正在读取本地 MCP 配置…
              </p>
            )}
            {!isLoading && !visible.length && !visibleBuiltins.length && (
              <p className="text-ui-sm text-ink-mute">
                {search || filter !== "all" || transportFilter !== "all"
                  ? "没有匹配的 MCP 服务"
                  : "暂无 MCP 服务"}
              </p>
            )}
          </div>
          <EdgeDrawer
            side="right"
            id={detailsId}
            open={isDetailOpen}
            visible={isDetailVisible}
            sliding
            drawerRef={detailDrawer}
            aria-label={
              currentBuiltin
                ? currentBuiltin.name + " 详情"
                : current && current.entry.name + " 详情"
            }
            className="z-10 w-[min(100%,28rem)] min-w-0 flex-col overflow-auto border-l border-line bg-base @min-[48rem]:w-(--mcp-drawer-width)"
          >
            {currentBuiltin ? (
              <McpServiceDetails
                key={builtinKey(currentBuiltin)}
                name={currentBuiltin.name}
                transport="AAW 内置"
                description={currentBuiltin.description}
                summary={builtinStatus(currentBuiltin)}
                connection={[
                  ["适用场景", currentBuiltin.scope],
                  ["当前状态", builtinStatus(currentBuiltin)],
                ]}
                health={currentBuiltinHealth}
                inspectionNote={
                  currentBuiltin.probe && builtinInspectionNote(currentBuiltin)
                }
                config={{
                  id: currentBuiltin.id,
                  name: currentBuiltin.name,
                  enabled: builtinControls.get(currentBuiltin)?.enabled,
                  transport: "builtin",
                  disabledTools:
                    builtinTools.data?.get(currentBuiltin)?.disabledTools,
                }}
                tools={builtinToolList(currentBuiltin)}
                disabledTools={
                  builtinTools.data?.get(currentBuiltin)?.disabledTools ?? []
                }
                toggle={builtinToggle(currentBuiltin)}
                actions={
                  currentBuiltin.probe &&
                  testButton(
                    currentBuiltinJob?.key ?? builtinKey(currentBuiltin),
                    true,
                  )
                }
                onToggleTools={
                  currentBuiltin.tools
                    ? (tools, enabled) => {
                        setBuiltinTools(currentBuiltin, tools, enabled);
                      }
                    : undefined
                }
                onClose={closeDetail}
                isToolPending={(name) =>
                  pendingWrites.has(toolKey(builtinKey(currentBuiltin), name))
                }
              />
            ) : (
              current && (
                <McpServiceDetails
                  key={targetKey(current)}
                  name={current.entry.name}
                  transport={transportLabel(current.entry.transport)}
                  description={current.entry.description ?? ""}
                  summary={statusOf(current)}
                  connection={
                    current.source === "native"
                      ? [
                          [
                            "所属配置",
                            current.entry.source ?? current.profile.name,
                          ],
                          ...(current.entry.transport === "stdio"
                            ? ([
                                ["启动命令", current.entry.command ?? "—"],
                                [
                                  "工作目录",
                                  current.entry.cwd ?? "会话工作目录",
                                ],
                              ] as const)
                            : ([
                                ["服务地址", current.entry.url ?? "已隐藏"],
                              ] as const)),
                          [
                            "凭据字段",
                            current.entry.secretKeys.join("、") || "—",
                          ],
                        ]
                      : [
                          ["服务地址", current.entry.url],
                          [
                            "请求头凭据引用",
                            current.entry.headers
                              .map(
                                ({ name, reference }) =>
                                  `${name} → ${reference}`,
                              )
                              .join("、") || "—",
                          ],
                        ]
                  }
                  health={currentHealth}
                  tools={currentTools}
                  disabledTools={
                    current.source === "managed"
                      ? (current.entry.disabledTools ?? [])
                      : []
                  }
                  config={
                    current.source === "managed"
                      ? {
                          name: current.entry.name,
                          transport: current.entry.transport,
                          enabled: current.entry.enabled,
                          description: current.entry.description,
                          url: current.entry.url,
                          headers: current.entry.headers,
                          disabledTools: current.entry.disabledTools,
                        }
                      : (current.entry.redactedConfig ?? {
                          name: current.entry.name,
                          enabled: current.entry.enabled,
                          transport: current.entry.transport,
                        })
                  }
                  toggle={
                    (current.source !== "native" ||
                      !current.entry.readOnly) && (
                      <ToggleSwitch
                        label={current.entry.name + " 启用"}
                        checked={current.entry.enabled}
                        pending={pendingWrites.has(targetKey(current))}
                        onChange={(enabled) => toggleService(current, enabled)}
                      />
                    )
                  }
                  actions={
                    <>
                      {currentKey && testButton(currentKey)}
                      {canEditCurrent && (
                        <ActionButton
                          tone="secondary"
                          size="compact"
                          disabled={pendingWrites.has(targetKey(current))}
                          onClick={() => {
                            setInitialEditorTab("form");
                            setEditing(current);
                          }}
                        >
                          编辑配置
                        </ActionButton>
                      )}
                    </>
                  }
                  onToggleTools={
                    current.source === "managed" && inspector
                      ? (tools, enabled) => {
                          void setTools(current, tools, enabled);
                        }
                      : undefined
                  }
                  onClose={closeDetail}
                  isToolPending={(name) =>
                    pendingWrites.has(toolKey(targetKey(current), name))
                  }
                />
              )
            )}
          </EdgeDrawer>
        </div>
        {((failure && !confirmation) || builtinError) && (
          <div
            role="alert"
            className="flex items-center gap-2 px-6 pb-4 text-ui-sm text-danger-ink"
          >
            <span>{failure ?? builtinError}</span>
            {hasWriteConflict && (
              <ActionButton tone="secondary" size="compact" onClick={retryRead}>
                重新读取配置
              </ActionButton>
            )}
          </div>
        )}
      </section>
      {service && editing && (
        <McpEditor
          close={() => setEditing(null)}
          initialTab={initialEditorTab}
          importer={
            editing.source === "managed" && !editing.entry
              ? {
                  preview: (definitions) =>
                    service.previewInstall(agentId, activeProfile, definitions),
                  commit: async (plan) => {
                    await service.commitInstall(plan, activeProfile);
                    setRefresh((version) => version + 1);
                  },
                }
              : undefined
          }
          reload={() => reloadEditor(editing)}
          editor={
            editing.source === "native"
              ? {
                  source: "native",
                  entry: editing.entry,
                  transports: nativeTransports,
                  scoped: hasScopedNative,
                  testStdio: hasHostInspection,
                  submit: async (draft) => {
                    const change = {
                      kind: "save" as const,
                      previousName: editing.entry?.name ?? null,
                      draft,
                    };
                    checkName(change);
                    const revision = await service.nativeChange(
                      agentId,
                      editing.profile,
                      editing.snapshot.revision,
                      change,
                    );
                    if (
                      hasScopedNative &&
                      revision !== editing.snapshot.revision
                    )
                      feedback?.({
                        message: "原生 MCP 配置已保存，将在新会话中生效",
                        variant: "ok",
                      });
                    setRefresh((version) => version + 1);
                  },
                  test:
                    canTest || hasHostInspection
                      ? (draft) =>
                          service.test(agentId, {
                            source: "native",
                            profile: editing.profile,
                            previousName: editing.entry?.name ?? null,
                            entryId: editing.entry?.id,
                            entryRevision: editing.entry?.connectionRevision,
                            workspace: nativeWorkspace,
                            revision: editing.snapshot.revision,
                            draft,
                          })
                      : undefined,
                }
              : {
                  source: "managed",
                  entry: editing.entry,
                  submit: async (draft) => {
                    const change = {
                      kind: "save" as const,
                      previousName: editing.entry?.name ?? null,
                      draft,
                    };
                    checkName(change);
                    await service.managedChange(
                      agentId,
                      activeProfile,
                      editing.snapshot.revision,
                      change,
                    );
                    setRefresh((version) => version + 1);
                  },
                  test:
                    inspector || canTest
                      ? (draft) =>
                          service.test(agentId, { source: "managed", draft })
                      : undefined,
                }
          }
        />
      )}
      {confirmation && (
        <ConfirmationDialog
          label="删除 MCP"
          title="删除 MCP"
          tone="danger"
          confirmLabel="删除"
          confirmDisabled={isRemoving}
          onCancel={() => {
            if (!isRemoving) setConfirmation(null);
          }}
          onConfirm={() =>
            void mutate(confirmation, {
              kind: "remove",
              name: confirmation.entry.name,
            })
          }
        >
          {"确定删除「" + confirmation.entry.name + "」的配置？"}
          {failure && (
            <p role="alert" className="mt-2 text-danger-ink">
              {failure}
            </p>
          )}
        </ConfirmationDialog>
      )}
    </div>
  );
}
