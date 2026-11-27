import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import { ActionButton, Badge, Spinner } from "../../../shared/ui/controls.tsx";
import {
  settingsLabelClass,
  settingsDescriptionClass,
} from "../../../shared/ui/settingsTypography.ts";
import { SettingCard } from "../../../shared/ui/SettingsPageParts.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import {
  MonitorIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from "../../../shared/ui/icons.tsx";
import { describeUnknownError } from "../../../shared/errors.ts";
import type {
  RemoteConnectionDTO,
  RemoteProjectRecord,
  RemoteProjectService,
} from "../service.ts";
import { RemoteHostFormModal } from "./RemoteHostFormModal.tsx";

const AUTH_LABELS: Record<string, string> = {
  password: "密码",
  key: "私钥",
  agent: "SSH Agent",
};

export interface RemoteHostsSettingsProps {
  readonly service: RemoteProjectService;
}

export function RemoteHostsSettings({ service }: RemoteHostsSettingsProps) {
  useStore(service.projects);
  const [connections, setConnections] = useState<
    readonly RemoteConnectionDTO[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalTarget, setModalTarget] = useState<
    | { readonly kind: "create" }
    | { readonly kind: "edit"; readonly connection: RemoteConnectionDTO }
    | null
  >(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testFeedback, setTestFeedback] = useState<
    Record<string, { readonly ok: boolean; readonly message: string }>
  >({});
  const [deleteBlocked, setDeleteBlocked] = useState<{
    readonly connectionId: string;
    readonly projects: readonly RemoteProjectRecord[];
  } | null>(null);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await service.listConnections();
      setConnections(list);
    } catch (err) {
      setError(describeUnknownError(err));
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    let cancelled = false;
    void service
      .listConnections()
      .then((list) => {
        if (cancelled) return;
        setConnections(list);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(describeUnknownError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service]);

  const handleTest = async (conn: RemoteConnectionDTO) => {
    setTestingId(conn.id);
    setTestFeedback((prev) => {
      const next = { ...prev };
      delete next[conn.id];
      return next;
    });
    try {
      const result = await service.testConnection({ connectionId: conn.id });
      setTestFeedback((prev) => ({
        ...prev,
        [conn.id]:
          result.status === "ok"
            ? {
                ok: true,
                message: `连接成功，远端家目录：${result.homeDir || "/"}`,
              }
            : {
                ok: false,
                message: "连接失败",
              },
      }));
    } catch (err) {
      setTestFeedback((prev) => ({
        ...prev,
        [conn.id]: { ok: false, message: describeUnknownError(err) },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (conn: RemoteConnectionDTO) => {
    setDeleteBlocked(null);
    const refs = service.listProjectsForConnection(conn.id);
    if (refs.length > 0) {
      setDeleteBlocked({ connectionId: conn.id, projects: refs });
      return;
    }
    try {
      await service.deleteConnection(conn.id);
      await loadConnections();
    } catch (err) {
      setError(describeUnknownError(err));
    }
  };

  return (
    <div className="space-y-5">
      <SettingCard label="远程主机（SSH）">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
          <div className="space-y-0.5">
            <div className={settingsDescriptionClass}>
              集中管理 SSH 远程开发主机，共 {connections.length} 台已保存主机。
            </div>
          </div>
          <div className="flex items-center gap-2">
            <IconButton
              aria-label="刷新远程主机列表"
              onClick={() => void loadConnections()}
              disabled={loading}
            >
              <RefreshIcon className="ui-icon-14" />
            </IconButton>
            <ActionButton
              tone="primary"
              size="compact"
              type="button"
              onClick={() => setModalTarget({ kind: "create" })}
              leadingIcon={<PlusIcon className="ui-icon-14 shrink-0" />}
            >
              添加远程主机
            </ActionButton>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-3 rounded-control border border-danger-ink/30 bg-danger-soft px-3 py-2 text-ui-caption text-danger-ink"
          >
            {error}
          </div>
        )}

        {deleteBlocked && (
          <div
            role="alert"
            className="mb-3 rounded-control border border-warn-ink/30 bg-warn-soft px-3 py-2.5 text-ui-caption text-warn-ink"
          >
            <div className="font-medium">
              无法删除：以下远程项目仍在使用该主机，请先关闭这些项目：
            </div>
            <ul className="mt-1 list-disc pl-4 font-mono">
              {deleteBlocked.projects.map((p) => (
                <li key={p.projectId}>
                  {p.name} ({p.remoteRoot})
                </li>
              ))}
            </ul>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-ui-base text-ink-mute">
            <Spinner className="ui-icon-14" />
            <span>正在加载远程主机…</span>
          </div>
        ) : connections.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-popover border border-dashed border-line-strong bg-raised/30 px-6 py-10 text-center">
            <MonitorIcon className="ui-icon-20 text-ink-ghost" />
            <div className={`mt-2.5 ${settingsLabelClass}`}>
              暂未配置远程主机
            </div>
            <p className="mt-1 max-w-md text-ui-caption text-ink-mute">
              添加 SSH
              主机后，即可在「添加项目」时直接选择远程设备并浏览远端目录，无需在服务器安装任何额外组件。
            </p>
            <ActionButton
              tone="secondary"
              size="compact"
              type="button"
              onClick={() => setModalTarget({ kind: "create" })}
              className="mt-4"
              leadingIcon={<PlusIcon className="ui-icon-14 shrink-0" />}
            >
              添加第一台远程主机
            </ActionButton>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-popover border border-line bg-surface">
            {connections.map((conn) => {
              const refs = service.listProjectsForConnection(conn.id);
              const feedback = testFeedback[conn.id];
              const isTesting = testingId === conn.id;
              return (
                <li key={conn.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`truncate ${settingsLabelClass}`}>
                          {conn.name}
                        </span>
                        <Badge tone="neutral">
                          {AUTH_LABELS[conn.authType ?? "password"] ?? "密码"}
                        </Badge>
                        {conn.bastion?.host && (
                          <Badge tone="neutral">跳板机</Badge>
                        )}
                        {refs.length > 0 && (
                          <Badge tone="info">{refs.length} 个项目</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-ui-caption text-ink-mute">
                        {conn.user}@{conn.host}:{conn.port || 22}
                        {conn.bastion?.host
                          ? ` via ${conn.bastion.user}@${conn.bastion.host}:${conn.bastion.port || 22}`
                          : ""}
                      </div>
                      {feedback && (
                        <div
                          className={`mt-1 text-ui-caption ${
                            feedback.ok ? "text-ok-ink" : "text-danger-ink"
                          }`}
                        >
                          {feedback.message}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <ActionButton
                        tone="secondary"
                        size="compact"
                        type="button"
                        disabled={isTesting}
                        onClick={() => void handleTest(conn)}
                        aria-busy={isTesting}
                        leadingIcon={isTesting ? <Spinner className="ui-icon-12" /> : undefined}
                      >
                        测试
                      </ActionButton>
                      <IconButton
                        aria-label={`编辑 ${conn.name}`}
                        onClick={() =>
                          setModalTarget({ kind: "edit", connection: conn })
                        }
                      >
                        <PencilIcon className="ui-icon-14" />
                      </IconButton>
                      <IconButton
                        type="button"
                        className="flex shrink-0 items-center justify-center rounded-control bg-danger-bg text-danger-ink transition-colors enabled:hover:bg-danger-bg/70"
                        aria-label={`删除 ${conn.name}`}
                        onClick={() => void handleDelete(conn)}
                      >
                        <TrashIcon className="ui-icon-14" />
                      </IconButton>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SettingCard>

      {modalTarget && (
        <RemoteHostFormModal
          service={service}
          connection={
            modalTarget.kind === "edit" ? modalTarget.connection : null
          }
          onClose={() => setModalTarget(null)}
          onSaved={() => {
            setModalTarget(null);
            void loadConnections();
          }}
        />
      )}
    </div>
  );
}
