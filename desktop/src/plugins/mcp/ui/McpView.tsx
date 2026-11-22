import { useEffect, useState } from "react";
import type {
  ManagedMcpEntry,
  ManagedMcpSnapshot,
  McpChange,
  McpProfile,
  NativeMcpEntry,
  NativeMcpSnapshot,
} from "../../../contracts/mcp/management.ts";
import {
  ActionButton,
  Listbox,
  ToggleSwitch,
} from "../../../shared/ui/controls.tsx";
import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import {
  CapabilityCard,
  capabilityGridClass,
} from "../../../shared/ui/CapabilityCard.tsx";
import { PageHeader } from "../../../shared/ui/PageHeader.tsx";
import { ContextMenu } from "../../../shared/ui/ContextMenu.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { useMenuController } from "../../../shared/ui/useMenuController.ts";
import { fieldSurfaceClass } from "../../../shared/ui/inputStyles.ts";
import {
  EllipsisIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "../../../shared/ui/icons.tsx";
import type { HostService } from "../../host/service.ts";
import { useBrowserAgentControl } from "../../browser/service.ts";
import {
  duplicateNameMessage,
  type McpManagement,
} from "../runtime/management.ts";
import { McpEditor } from "./McpEditor.tsx";

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
type Target = NativeTarget | ManagedTarget;
type Existing = NativeTarget | (ManagedTarget & { entry: ManagedMcpEntry });
type EntryAction =
  | { kind: "toggle"; name: string; enabled: boolean }
  | { kind: "remove"; name: string };

const browserName = "AAW 内置浏览器";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function useLoad<T>(load: () => Promise<T>, dependencies: readonly unknown[]) {
  const [result, setResult] = useState<
    | { keys: readonly unknown[]; data: T; error?: undefined }
    | { keys: readonly unknown[]; error: string; data?: undefined }
  >();
  useEffect(() => {
    let current = true;
    void load().then(
      (data) => {
        if (current) setResult({ keys: dependencies, data });
      },
      (error: unknown) => {
        if (current)
          setResult({ keys: dependencies, error: errorMessage(error) });
      },
    );
    return () => {
      current = false;
    };
    // 只有当前配置身份和刷新标识变化才重新读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  const matches = result?.keys.every(
    (key, index) =>
      index === dependencies.length - 1 || Object.is(key, dependencies[index]),
  );
  const current = matches && result?.keys.at(-1) === dependencies.at(-1);
  return {
    data: matches ? result?.data : undefined,
    error: current ? result?.error : undefined,
    isLoading: !current,
  };
}

function McpServiceCard({
  entry,
  duplicate,
  disabled,
  onEdit,
  onRemove,
  onToggle,
}: {
  entry: NativeMcpEntry | ManagedMcpEntry;
  duplicate: boolean;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onToggle: (value: boolean) => void;
}) {
  const { menu, open, dismiss } = useMenuController();
  return (
    <li className="min-w-0">
      <CapabilityCard
        name={entry.name}
        description={
          entry.transport === "http" ? "Streamable HTTP" : entry.transport
        }
        metadata={duplicate ? undefined : entry.enabled ? "已启用" : "已停用"}
        status={duplicate ? duplicateNameMessage : undefined}
        icon={<PlugIcon className="ui-icon-16" />}
        onDetail={onEdit}
        detailLabel={entry.name}
        detailDisabled={disabled}
        toggle={
          <ToggleSwitch
            appearance="neutral"
            label={entry.name + " 启用"}
            checked={entry.enabled}
            onChange={onToggle}
            disabled={disabled}
          />
        }
        actions={
          <>
            <IconButton
              iconSize="compact"
              aria-label={entry.name + " 删除"}
              data-hint="删除"
              disabled={disabled}
              onClick={onRemove}
            >
              <TrashIcon className="ui-icon-14" />
            </IconButton>
            <IconButton
              iconSize="compact"
              aria-label={entry.name + " 更多操作"}
              data-hint="更多操作"
              aria-haspopup="menu"
              aria-expanded={!!menu && !menu.closing}
              disabled={disabled}
              onClick={(event) => {
                if (menu && !menu.closing) {
                  dismiss();
                  return;
                }
                open(
                  "actions",
                  entry.name + " 的操作",
                  [{ id: "edit", label: "编辑", onSelect: onEdit }],
                  { trigger: event.currentTarget },
                );
              }}
            >
              <EllipsisIcon className="ui-icon-14" />
            </IconButton>
            {menu && (
              <ContextMenu
                entries={menu.entries}
                placement={menu.placement}
                trigger={menu.trigger}
                label={menu.label}
                closing={menu.closing}
                onDismiss={dismiss}
              />
            )}
          </>
        }
      />
    </li>
  );
}

export function McpView({
  service,
  agentId,
  activeProfile,
  browser,
  canManageNative,
  canManageInjected,
  canTest,
}: {
  service: McpManagement | null;
  agentId: string;
  activeProfile: string | null;
  browser: HostService["browser"];
  canManageNative: boolean;
  canManageInjected: boolean;
  canTest: boolean;
}) {
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<Target | null>(null);
  const [confirmation, setConfirmation] = useState<Existing | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const browserControl = useBrowserAgentControl(browser);
  const native = useLoad(
    () =>
      service && canManageNative
        ? service.readNative(agentId, activeProfile, refresh > 0)
        : Promise.resolve(null),
    [service, agentId, activeProfile, canManageNative, refresh],
  );
  const managed = useLoad(
    () =>
      service && canManageInjected
        ? service.host.managedRead(agentId)
        : Promise.resolve(null),
    [service, agentId, canManageInjected, refresh],
  );
  const targets: Existing[] = [];
  if (native?.data) {
    const { profile, snapshot } = native.data;
    targets.push(
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
    targets.push(
      ...snapshot.entries.map((entry) => ({
        source: "managed" as const,
        entry,
        snapshot,
      })),
    );
  }
  const names = new Map<string, number>();
  if (browserControl.available) names.set(browserName, 1);
  for (const {
    entry: { name },
  } of targets)
    names.set(name, (names.get(name) ?? 0) + 1);

  const term = search.trim().toLowerCase();
  function shows(name: string, enabled: boolean | null) {
    return (
      name.toLowerCase().includes(term) &&
      (filter === "all" ||
        (enabled !== null && enabled === (filter === "enabled")))
    );
  }
  const visible = targets
    .filter(({ entry }) => shows(entry.name, entry.enabled))
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name));
  const showBrowser =
    browserControl.available && shows(browserName, browserControl.enabled);
  const count = visible.length + Number(showBrowser);
  const isLoading =
    (canManageNative && native.isLoading) ||
    (canManageInjected && managed.isLoading);
  const hasReadFailure = !!(native.error || managed.error);

  async function mutate(target: Existing, operation: EntryAction) {
    if (!service) return;
    setBusy(true);
    setFailure(null);
    try {
      if (target.source === "native") {
        await service.nativeChange(
          agentId,
          target.profile,
          target.snapshot.revision,
          operation,
        );
      } else {
        await service.managedChange(
          agentId,
          activeProfile,
          target.snapshot.revision,
          operation,
        );
      }
      setRefresh((version) => version + 1);
    } catch (error) {
      setFailure(errorMessage(error));
      setRefresh((version) => version + 1);
    } finally {
      setBusy(false);
      setConfirmation(null);
    }
  }

  function checkName<T extends { name: string }>(
    change: Extract<McpChange<T>, { kind: "save" }>,
  ) {
    if (
      change.draft.name !== change.previousName &&
      change.draft.name === browserName
    )
      throw new Error(duplicateNameMessage);
  }

  async function reloadEditor(target: Target) {
    if (!service) return;
    if (target.source === "native") {
      const snapshot = await service.nativeRead(agentId, target.profile);
      const entry = snapshot.entries.find(
        ({ name }) => name === target.entry.name,
      );
      if (!entry) throw new Error("原服务已移除或改名，已保留表单输入。");
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

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <section
        aria-label="MCP 管理"
        className="mx-auto w-full max-w-[112rem] space-y-4 px-[clamp(1rem,3vw,3rem)] py-6"
      >
        <PageHeader
          title="MCP"
          count={count + " 项"}
          actions={
            canManageInjected && (
              <ActionButton
                tone="primary"
                size="compact"
                disabled={!managed?.data || busy}
                onClick={() => {
                  if (managed?.data)
                    setEditing({ source: "managed", snapshot: managed.data });
                }}
              >
                <PlusIcon className="ui-icon-14" /> 新增 MCP
              </ActionButton>
            )
          }
        />
        <div className="flex flex-wrap items-center gap-2 border-b border-line pb-4">
          <label className="relative flex items-center">
            <SearchIcon className="ui-icon-14 pointer-events-none absolute left-2.5 text-ink-mute" />
            <input
              type="search"
              aria-label="搜索 MCP"
              className={`${fieldSurfaceClass} min-h-9 w-44 max-w-full pl-8 pr-2 text-ui-xs`}
              placeholder="搜索 MCP…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Listbox
            label="筛选状态"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部状态" },
              { value: "enabled", label: "已启用" },
              { value: "disabled", label: "已停用" },
            ]}
          />
        </div>
        {hasReadFailure && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 text-ui-sm text-warn-ink"
          >
            <span>
              {native?.error
                ? "暂时无法读取 Agent 原生配置。"
                : "暂时无法读取 Desktop 配置。"}
            </span>
            <ActionButton
              tone="secondary"
              size="compact"
              onClick={() => setRefresh((version) => version + 1)}
            >
              重新读取
            </ActionButton>
          </div>
        )}
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
        {failure && (
          <p role="alert" className="text-ui-sm text-danger-ink">
            {failure}
          </p>
        )}
        {browserControl.error && (
          <p role="alert" className="text-ui-sm text-danger-ink">
            {browserControl.error}
          </p>
        )}
        <ul aria-label="MCP 服务" className={capabilityGridClass}>
          {showBrowser && (
            <li className="min-w-0">
              <CapabilityCard
                name={browserName}
                description="内置浏览器工具"
                metadata={
                  browserControl.enabled === null
                    ? undefined
                    : browserControl.enabled
                      ? "已启用"
                      : "已停用"
                }
                icon={<PlugIcon className="ui-icon-16" />}
                toggle={
                  <ToggleSwitch
                    appearance="neutral"
                    label={browserName + " 启用"}
                    checked={browserControl.enabled === true}
                    disabled={
                      browserControl.pending || browserControl.enabled === null
                    }
                    onChange={browserControl.change}
                  />
                }
              />
            </li>
          )}
          {visible.map((target, index) => {
            const { entry } = target;
            const key = JSON.stringify([target.source, entry.name, index]);
            return (
              <McpServiceCard
                key={key}
                entry={entry}
                duplicate={(names.get(entry.name) ?? 0) > 1}
                disabled={busy}
                onEdit={() => setEditing(target)}
                onRemove={() => setConfirmation(target)}
                onToggle={(enabled) =>
                  void mutate(target, {
                    kind: "toggle",
                    name: entry.name,
                    enabled,
                  })
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
        {!isLoading && count === 0 && (
          <p className="text-ui-sm text-ink-mute">
            {search || filter !== "all"
              ? "没有匹配的 MCP 服务"
              : "暂无 MCP 服务"}
          </p>
        )}
      </section>
      {service && editing && (
        <McpEditor
          close={() => setEditing(null)}
          reload={() => reloadEditor(editing)}
          editor={
            editing.source === "native"
              ? {
                  source: "native",
                  entry: editing.entry,
                  submit: async (draft) => {
                    const change = {
                      kind: "save" as const,
                      previousName: editing.entry.name,
                      draft,
                    };
                    checkName(change);
                    await service.nativeChange(
                      agentId,
                      editing.profile,
                      editing.snapshot.revision,
                      change,
                    );
                    setRefresh((version) => version + 1);
                  },
                  test: canTest
                    ? (draft) =>
                        service.test(agentId, {
                          source: "native",
                          profile: editing.profile,
                          previousName: editing.entry.name,
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
                  test: canTest
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
          confirmDisabled={busy}
          onCancel={() => {
            if (!busy) setConfirmation(null);
          }}
          onConfirm={() =>
            void mutate(confirmation, {
              kind: "remove",
              name: confirmation.entry.name,
            })
          }
        >
          {"确定删除「" + confirmation.entry.name + "」的配置？"}
        </ConfirmationDialog>
      )}
    </div>
  );
}
