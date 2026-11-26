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
import { fieldSurfaceClass } from "../../../shared/ui/inputStyles.ts";
import {
  ChevronDownIcon,
  FolderGlyph,
  GlobeIcon,
  PlusIcon,
  SettingsIcon,
  XIcon,
} from "../../../shared/ui/icons.tsx";
import { describeUnknownError } from "../../../shared/errors.ts";
import { parseRemoteProjectPath } from "../../../shared/panelPaths.ts";
import type {
  RemoteConnectionDTO,
  RemoteProjectRecord,
  RemoteProjectService,
} from "../service.ts";
import { RemoteHostFormModal } from "./RemoteHostFormModal.tsx";
import { RemoteDirectoryPickerModal } from "./RemoteDirectoryPickerModal.tsx";

function basenameOfPath(input: string): string {
  const normalized = input.replace(/[\\/]+$/, "");
  if (!normalized) return input;
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export interface AddRemoteProjectModalProps {
  readonly service: RemoteProjectService;
  readonly onClose: () => void;
  readonly onAdded: (record: RemoteProjectRecord) => void;
  readonly repairPath?: string;
  /** 可选：提供本地目录选择回调时，支持在「此电脑」与「远程主机」间切换。 */
  readonly onPickLocalDirectory?: () => Promise<string | null>;
  /** 可选：确认创建本地项目后的回调。 */
  readonly onLocalAdded?: (localPath: string) => void;
  /** 可选：跳转「设置 → 远程主机」管理页。 */
  readonly onOpenRemoteHostSettings?: () => void;
}

/**
 * 「创建项目」核心表单内容：可内嵌在「新建会话」弹窗的「新建项目」Tab 中，
 * 也可由 AddRemoteProjectModal 包一层 ModalShell 独立弹出。
 */
export function CreateProjectFormBody({
  service,
  onClose,
  onAdded,
  onPickLocalDirectory,
  onLocalAdded,
  onOpenRemoteHostSettings,
  repairPath,
  onSavingChange,
  embedded = false,
}: AddRemoteProjectModalProps & {
  readonly embedded?: boolean;
  readonly onSavingChange?: (saving: boolean) => void;
}) {
  const supportsLocal =
    !repairPath && Boolean(onPickLocalDirectory && onLocalAdded);

  const [projectName, setProjectName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [connections, setConnections] = useState<
    readonly RemoteConnectionDTO[]
  >([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);

  // "local" 表示此电脑；否则为远程主机 connectionId
  const [deviceId, setDeviceId] = useState<string | null>(
    supportsLocal ? "local" : null,
  );
  const [menuState, setMenuState] = useState<{
    readonly placement: MenuPlacement;
    readonly trigger?: HTMLElement;
  } | null>(null);

  // 已选中的源文件夹（根据 deviceId 区分本地路径或远端路径）
  const [selectedFolder, setSelectedFolder] = useState<string | null>(
    repairPath
      ? (parseRemoteProjectPath(repairPath)?.remotePath ?? null)
      : null,
  );
  const [localPickUnavailable, setLocalPickUnavailable] = useState(false);

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
          if (prev === "local") return "local";
          if (prev && list.some((c) => c.id === prev)) return prev;
          if (supportsLocal) return "local";
          if (repairPath) return null;
          return list[0]?.id ?? null;
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
  }, [service, supportsLocal, repairPath]);

  const switchDevice = (nextDeviceId: string | null) => {
    if (nextDeviceId !== deviceId) {
      setDeviceId(nextDeviceId);
      if (!repairPath) setSelectedFolder(null);
      setLocalPickUnavailable(false);
      setSaveError(null);
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

  const handlePickFolder = async () => {
    if (deviceId === "local") {
      if (!onPickLocalDirectory) return;
      setLocalPickUnavailable(false);
      const picked = await onPickLocalDirectory();
      if (!picked) {
        setLocalPickUnavailable(true);
        return;
      }
      setSelectedFolder(picked);
      setProjectName((prev) => (prev.trim() ? prev : basenameOfPath(picked)));
      return;
    }
    if (selectedConnection) {
      setRemotePickerOpen(true);
      return;
    }
    setAddHostOpen(true);
  };

  const handleConfirm = async () => {
    if (!selectedFolder || isSaving) return;
    if (deviceId === "local") {
      if (!onLocalAdded) return;
      onLocalAdded(selectedFolder);
      onClose();
      return;
    }
    if (!selectedConnection) return;
    setSaveError(null);
    setIsSaving(true);
    onSavingChange?.(true);
    try {
      const record = repairPath
        ? await service.repairProject(repairPath, selectedConnection.id)
        : await service.addProject(
            selectedConnection.id,
            selectedFolder,
            projectName.trim() || undefined,
          );
      onAdded(record);
      onClose();
    } catch (error) {
      setSaveError(describeUnknownError(error));
    } finally {
      setIsSaving(false);
      onSavingChange?.(false);
    }
  };

  const deviceLabel =
    deviceId === "local"
      ? "此电脑"
      : selectedConnection
        ? selectedConnection.name
        : "选择远程主机";

  return (
    <>
      <div
        className={
          embedded ? "flex flex-col gap-4" : "flex flex-col gap-4 px-5 pb-4"
        }
      >
        {/* 项目名称输入框 */}
        {!repairPath && (
          <div className="flex items-center overflow-hidden rounded-control border border-line-strong bg-surface focus-within:border-ink-faint">
            <span
              aria-hidden={true}
              className="flex min-h-10 w-10 shrink-0 items-center justify-center border-r border-line text-ink-mute"
            >
              <FolderGlyph className="ui-icon-16" />
            </span>
            <input
              type="text"
              aria-label="项目名称"
              disabled={isSaving}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="项目名称"
              className={`${fieldSurfaceClass} min-h-10 min-w-0 flex-1 rounded-flat border-0 bg-transparent px-3 py-1.5 text-ui-sm focus:ring-0`}
            />
          </div>
        )}

        {/* 源文件夹区域：统领句 + 设备切换胶囊放在区域左上角 */}
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-1.5 text-ui-sm text-ink-mute">
            <span>在</span>
            <ActionButton
              tone="secondary"
              type="button"
              aria-haspopup="menu"
              aria-expanded={Boolean(menuState)}
              aria-label={`切换设备，当前：${deviceLabel}`}
              onClick={handleToggleMenu}
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-ui-sm font-medium text-ink"
            >
              {deviceId === "local" ? (
                <FolderGlyph className="ui-icon-14 shrink-0 text-ink-mute" />
              ) : (
                <GlobeIcon className="ui-icon-14 shrink-0 text-ink-mute" />
              )}
              <span>{deviceLabel}</span>
              <ChevronDownIcon className="ui-icon-14 shrink-0 text-ink-mute" />
            </ActionButton>
            <span>{repairPath ? "连接原远端目录" : "上添加文件夹"}</span>
          </div>

          {selectedFolder ? (
            <div className="flex items-center justify-between gap-3 rounded-popover border border-line-strong bg-surface px-3.5 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex min-h-8 w-8 shrink-0 items-center justify-center rounded-control border border-line bg-raised/50 text-ink-mute">
                  {deviceId === "local" ? (
                    <FolderGlyph className="ui-icon-16" />
                  ) : (
                    <GlobeIcon className="ui-icon-16" />
                  )}
                </span>
                <div className="min-w-0">
                  <div className="truncate font-mono text-ui-xs font-medium text-ink">
                    {selectedFolder}
                  </div>
                  <div className="mt-0.5 truncate text-ui-caption text-ink-mute">
                    {deviceId === "local"
                      ? "此电脑"
                      : selectedConnection
                        ? `${selectedConnection.user}@${selectedConnection.host}:${selectedConnection.port || 22}`
                        : "远程主机"}
                  </div>
                </div>
              </div>
              {!repairPath && (
                <ActionButton
                  tone="secondary"
                  type="button"
                  disabled={isSaving}
                  onClick={() => void handlePickFolder()}
                  className="shrink-0 px-2.5 py-1 text-ui-xs"
                >
                  更改
                </ActionButton>
              )}
            </div>
          ) : (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-2.5 rounded-popover border border-dashed border-line-strong bg-raised/30 px-4 py-5">
              <ActionButton
                tone="secondary"
                type="button"
                onClick={() => void handlePickFolder()}
                className="inline-flex items-center gap-1.5 rounded-pill px-4 py-1.5 text-ui-sm"
              >
                <FolderGlyph className="ui-icon-14 shrink-0" />
                <span>添加</span>
              </ActionButton>

              {localPickUnavailable && (
                <p className="text-ui-xs text-warn-ink">
                  目录选择已取消或当前环境不可用，可点击重试。
                </p>
              )}
            </div>
          )}
        </div>

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
        {saveError && (
          <p role="alert" className="text-ui-sm text-danger-ink">
            {saveError}
          </p>
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
          disabled={isSaving}
          onClick={onClose}
          className="px-3.5 py-1.5 text-ui-sm"
        >
          取消
        </ActionButton>
        <ActionButton
          tone="primary"
          type="button"
          disabled={
            isSaving ||
            !selectedFolder ||
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
          initialPath={selectedFolder ?? undefined}
          onClose={() => setRemotePickerOpen(false)}
          onSelected={(remotePath) => {
            setRemotePickerOpen(false);
            setSelectedFolder(remotePath);
            setProjectName((prev) =>
              prev.trim() ? prev : basenameOfPath(remotePath),
            );
          }}
        />
      )}
    </>
  );
}

export function AddRemoteProjectModal(props: AddRemoteProjectModalProps) {
  const [isSaving, setIsSaving] = useState(false);
  const label = props.repairPath ? "修复远程项目连接" : "创建项目";
  const dismiss = () => {
    if (!isSaving) props.onClose();
  };
  return (
    <ModalShell onDismiss={dismiss} label={label} size="default">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <h2 className="text-ui-lg font-semibold text-ink">{label}</h2>
        <IconButton aria-label="关闭" disabled={isSaving} onClick={dismiss}>
          <XIcon className="ui-icon-16" />
        </IconButton>
      </div>
      <CreateProjectFormBody {...props} onSavingChange={setIsSaving} />
    </ModalShell>
  );
}
