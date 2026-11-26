import {
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import {
  ContextMenu,
  type ContextMenuEntry,
  type MenuPlacement,
} from "../../../shared/ui/ContextMenu.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import {
  normalizePath,
  parseRemoteProjectPath,
  pathKey,
} from "../../../shared/panelPaths.ts";
import { basenameOf } from "../../../shared/workspaceText.ts";
import { ProjectFolderFields } from "./ProjectFolderFields.tsx";
import {
  ChevronDownIcon,
  FolderGlyph,
  GlobeIcon,
  MonitorIcon,
  PlusIcon,
  SettingsIcon,
  XIcon,
} from "../../../shared/ui/icons.tsx";
import { describeUnknownError } from "../../../shared/errors.ts";
import type { RemoteConnectionDTO, RemoteProjectService } from "../service.ts";
import { RemoteHostFormModal } from "./RemoteHostFormModal.tsx";
import { RemoteDirectoryPickerModal } from "./RemoteDirectoryPickerModal.tsx";

export interface AddRemoteProjectModalProps {
  readonly service: RemoteProjectService;
  readonly onClose: () => void;
  readonly repairPath?: string;
  readonly onSave: (
    deviceId: string,
    name: string,
    primary: string,
    related: readonly string[],
  ) => boolean | Promise<boolean>;
  readonly onPickLocalDirectory?: () => Promise<string | null>;
  readonly onOpenRemoteHostSettings?: () => void;
  readonly edit?: {
    readonly deviceId: string;
    readonly deviceLabel?: string;
    readonly name: string;
    readonly folders: readonly string[];
  };
}

/**
 * 「创建项目」核心表单内容：可内嵌在「新建会话」弹窗的「新建项目」Tab 中，
 * 也可由 AddRemoteProjectModal 包一层 ModalShell 独立弹出。
 */
export function CreateProjectFormBody({
  service,
  onClose,
  repairPath,
  onSavingChange,
  onSave,
  onPickLocalDirectory,
  edit,
  onOpenRemoteHostSettings,
  embedded = false,
}: AddRemoteProjectModalProps & {
  readonly embedded?: boolean;
  readonly onSavingChange?: (isSaving: boolean) => void;
}) {
  const supportsLocal = !repairPath && Boolean(onPickLocalDirectory);
  const repairRoot = repairPath
    ? parseRemoteProjectPath(repairPath)?.remotePath
    : undefined;

  const [projectName, setProjectName] = useState(edit?.name);
  const [connections, setConnections] = useState<
    readonly RemoteConnectionDTO[]
  >([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);

  // "local" 表示此电脑；否则为远程主机 connectionId
  const [deviceId, setDeviceId] = useState<string | null>(
    edit?.deviceId ?? (supportsLocal ? "local" : null),
  );
  const [menuState, setMenuState] = useState<{
    readonly placement: MenuPlacement;
    readonly trigger?: HTMLElement;
  } | null>(null);

  const [folders, setFolders] = useState<readonly string[]>(
    edit?.folders ?? (repairRoot ? [repairRoot] : []),
  );
  const [isPicking, setIsPicking] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();
  const busy = isPicking || isSaving;
  // 热更新可能替换表单组件，仍在运行的插件注册会保留旧回调。
  const hasSaveHandler = typeof onSave === "function";
  const primary = folders[0];
  const name = projectName ?? (primary ? basenameOf(primary) : "");

  // 二级弹窗：添加远程主机 / 远端文件夹选择器
  const [addHostOpen, setAddHostOpen] = useState(false);
  const [remotePickerOpen, setRemotePickerOpen] = useState(false);

  const selectedConnection = useMemo(
    () =>
      deviceId && deviceId !== "local"
        ? (connections.find((c) => c.id === deviceId) ?? null)
        : null,
    [connections, deviceId],
  );

  useEffect(() => {
    let cancelled = false;
    void service
      .listConnections()
      .then((list) => {
        if (cancelled) return;
        setConnections(list);
        setConnectionsError(null);
        setDeviceId((prev) => {
          if (edit || prev === "local") return prev;
          if (prev && list.some((c) => c.id === prev)) return prev;
          if (supportsLocal) return "local";
          return repairPath ? null : (list[0]?.id ?? null);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setConnectionsError(describeUnknownError(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingConnections(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service, supportsLocal, edit, repairPath]);

  const switchDevice = (nextDeviceId: string | null) => {
    if (nextDeviceId !== deviceId) {
      setDeviceId(nextDeviceId);
      if (!repairPath) setFolders([]);
      setError(undefined);
    }
  };

  const handleToggleMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (menuState) {
      setMenuState(null);
      return;
    }
    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();
    setMenuState({
      placement: {
        x: rect.left,
        y: rect.bottom + 6,
        side: "bottom",
        align: "start",
      },
      trigger,
    });
  };

  const buildMenuEntries = (): readonly ContextMenuEntry[] => {
    const items: ContextMenuEntry[] = [];
    if (supportsLocal) {
      items.push({
        id: "device:local",
        label: "此电脑",
        icon: <FolderGlyph className="ui-icon-16" />,
        radio: true,
        selected: deviceId === "local",
        onSelect: () => {
          switchDevice("local");
          setMenuState(null);
        },
      });
      items.push({ type: "separator" });
    }

    if (loadingConnections) {
      items.push({
        id: "remote:loading",
        label: "正在加载远程主机…",
        disabled: true,
        onSelect: () => {},
      });
    } else if (connectionsError) {
      items.push({
        id: "remote:error",
        label: connectionsError,
        disabled: true,
        onSelect: () => {},
      });
    } else if (connections.length === 0) {
      items.push({
        id: "remote:empty",
        label: "未连接任何远程主机",
        disabled: true,
        onSelect: () => {},
      });
    } else {
      for (const conn of connections) {
        items.push({
          id: `device:${conn.id}`,
          label: conn.name,
          description: `${conn.user}@${conn.host}`,
          icon: <GlobeIcon className="ui-icon-16" />,
          radio: true,
          selected: deviceId === conn.id,
          onSelect: () => {
            switchDevice(conn.id);
            setMenuState(null);
          },
        });
      }
    }

    items.push({ type: "separator" });
    items.push({
      id: "action:add-host",
      label: "添加远程主机",
      icon: <PlusIcon className="ui-icon-16" />,
      onSelect: () => {
        setMenuState(null);
        setAddHostOpen(true);
      },
    });
    if (onOpenRemoteHostSettings) {
      items.push({
        id: "action:manage-hosts",
        label: "管理远程主机…",
        icon: <SettingsIcon className="ui-icon-16" />,
        onSelect: () => {
          setMenuState(null);
          onClose();
          onOpenRemoteHostSettings();
        },
      });
    }
    return items;
  };

  const addFolder = (path: string) => {
    const key = deviceId === "local" ? pathKey : normalizePath;
    setFolders((items) =>
      items.some((item) => key(item) === key(path)) ? items : [...items, path],
    );
  };

  const handlePickFolder = async () => {
    if (busy) return;
    setError(undefined);
    if (deviceId === "local") {
      if (!onPickLocalDirectory) return;
      setIsPicking(true);
      try {
        const picked = await onPickLocalDirectory();
        if (picked) addFolder(picked);
        else if (folders.length === 0)
          setError("目录选择已取消或当前环境不可用，可点击重试。");
      } catch (error) {
        setError(describeUnknownError(error));
      } finally {
        setIsPicking(false);
      }
    } else if (selectedConnection) {
      setRemotePickerOpen(true);
    } else if (!edit) {
      setAddHostOpen(true);
    } else {
      setError("远程主机不可用，无法添加文件夹");
    }
  };

  const handleConfirm = async () => {
    if (
      !hasSaveHandler ||
      busy ||
      !primary ||
      !deviceId ||
      (deviceId !== "local" && !selectedConnection)
    )
      return;
    setIsSaving(true);
    onSavingChange?.(true);
    setError(undefined);
    try {
      if (
        await onSave(
          deviceId,
          name.trim() || basenameOf(primary),
          primary,
          folders.slice(1),
        )
      )
        onClose();
    } catch (error) {
      setError(describeUnknownError(error));
    } finally {
      setIsSaving(false);
      onSavingChange?.(false);
    }
  };

  const deviceLabel =
    deviceId === "local"
      ? "此电脑"
      : (selectedConnection?.name ?? edit?.deviceLabel ?? "选择远程主机");
  const deviceIcon =
    deviceId === "local" ? (
      <MonitorIcon className="ui-icon-14 shrink-0 text-ink-mute" />
    ) : (
      <GlobeIcon className="ui-icon-14 shrink-0 text-ink-mute" />
    );

  return (
    <>
      <div
        className={
          embedded ? "flex flex-col gap-4" : "flex flex-col gap-4 px-5 pb-4"
        }
      >
        <ProjectFolderFields
          name={name}
          folders={folders}
          device={
            edit ? (
              <span className="inline-flex items-center gap-1.5">
                {deviceIcon}
                {deviceLabel}
              </span>
            ) : (
              <ActionButton
                tone="secondary"
                type="button"
                disabled={busy}
                aria-haspopup="menu"
                aria-expanded={Boolean(menuState)}
                aria-label={`切换设备，当前：${deviceLabel}`}
                onClick={handleToggleMenu}
                className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-ui-sm font-medium text-ink"
              >
                {deviceIcon}
                {deviceLabel}
                <ChevronDownIcon className="ui-icon-14 shrink-0 text-ink-mute" />
              </ActionButton>
            )
          }
          isEditing={Boolean(edit || repairPath)}
          hideName={Boolean(repairPath)}
          disabled={busy}
          onNameChange={setProjectName}
          onFoldersChange={setFolders}
          onPick={repairPath ? undefined : () => void handlePickFolder()}
        />
        {!hasSaveHandler && (
          <div
            role="alert"
            className="flex items-center gap-2 text-ui-sm text-ink-mute"
          >
            <span>项目表单已更新，重新加载窗口后可以保存。</span>
            <ActionButton
              type="button"
              tone="secondary"
              size="compact"
              onClick={() => window.location.reload()}
            >
              重新加载
            </ActionButton>
          </div>
        )}
        {error && (
          <p role="alert" className="text-ui-sm text-danger-ink">
            {error}
          </p>
        )}
        {menuState && (
          <ContextMenu
            entries={buildMenuEntries()}
            placement={menuState.placement}
            label="选择目标设备"
            closing={false}
            onDismiss={() => setMenuState(null)}
            trigger={menuState.trigger}
            variant="selection"
          />
        )}
      </div>

      {/* 底部按钮栏 */}
      <div
        className={
          embedded
            ? "flex items-center justify-end gap-2 pt-1"
            : "flex items-center justify-end gap-2 px-5 py-3.5"
        }
      >
        <ActionButton
          tone="ghost"
          type="button"
          onClick={onClose}
          disabled={isSaving}
          className="px-3.5 py-1.5 text-ui-sm"
        >
          取消
        </ActionButton>
        <ActionButton
          tone="primary"
          type="button"
          disabled={
            !hasSaveHandler ||
            busy ||
            !primary ||
            (deviceId !== "local" && !selectedConnection)
          }
          onClick={() => void handleConfirm()}
          className="px-4 py-1.5 text-ui-sm"
        >
          {isSaving
            ? repairPath
              ? "正在验证并保存…"
              : "正在保存…"
            : repairPath
              ? "修复连接"
              : edit
                ? "保存"
                : "创建项目"}
        </ActionButton>
      </div>

      {addHostOpen && (
        <RemoteHostFormModal
          service={service}
          onClose={() => setAddHostOpen(false)}
          onSaved={(saved) => {
            setAddHostOpen(false);
            setConnections((prev) => {
              const exists = prev.some((c) => c.id === saved.id);
              return exists
                ? prev.map((c) => (c.id === saved.id ? saved : c))
                : [...prev, saved];
            });
            switchDevice(saved.id);
          }}
        />
      )}

      {remotePickerOpen && selectedConnection && (
        <RemoteDirectoryPickerModal
          service={service}
          connection={selectedConnection}
          initialPath={primary}
          onClose={() => setRemotePickerOpen(false)}
          onSelected={(remotePath) => {
            setRemotePickerOpen(false);
            addFolder(remotePath);
          }}
        />
      )}
    </>
  );
}

export function AddRemoteProjectModal(props: AddRemoteProjectModalProps) {
  const [isSaving, setIsSaving] = useState(false);
  const title = props.repairPath
    ? "修复远程项目连接"
    : props.edit
      ? "编辑项目"
      : "创建项目";
  const dismiss = () => {
    if (!isSaving) props.onClose();
  };
  return (
    <ModalShell onDismiss={dismiss} label={title} size="default">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <h2 className="text-ui-lg font-semibold text-ink">{title}</h2>
        <IconButton aria-label="关闭" disabled={isSaving} onClick={dismiss}>
          <XIcon className="ui-icon-16" />
        </IconButton>
      </div>
      <CreateProjectFormBody {...props} onSavingChange={setIsSaving} />
    </ModalShell>
  );
}
