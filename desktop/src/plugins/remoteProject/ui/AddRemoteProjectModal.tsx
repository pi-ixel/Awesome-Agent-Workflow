import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { ActionButton, Badge, Spinner } from "../../../shared/ui/controls.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { fieldSurfaceClass } from "../../../shared/ui/inputStyles.ts";
import { FolderGlyph, SearchIcon, XIcon } from "../../../shared/ui/icons.tsx";
import { describeUnknownError } from "../../../shared/errors.ts";
import type {
  RemoteConnectionDTO,
  RemoteConnectionInput,
  RemoteConnectionTestResult,
  RemoteFSEntry,
  RemoteProjectRecord,
  RemoteProjectService,
} from "../service.ts";

interface ConnectionFormState {
  readonly mode: "create" | "edit";
  readonly editingId: string | null;
  readonly name: string;
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly hostKey: string;
  readonly useBastion: boolean;
  readonly bastionHost: string;
  readonly bastionPort: string;
  readonly bastionUser: string;
  readonly bastionPassword: string;
  readonly bastionHostKey: string;
}

function emptyForm(): ConnectionFormState {
  return {
    mode: "create",
    editingId: null,
    name: "",
    host: "",
    port: "22",
    user: "",
    password: "",
    hostKey: "",
    useBastion: false,
    bastionHost: "",
    bastionPort: "22",
    bastionUser: "",
    bastionPassword: "",
    bastionHostKey: "",
  };
}

function formFromConnection(conn: RemoteConnectionDTO): ConnectionFormState {
  return {
    mode: "edit",
    editingId: conn.id,
    name: conn.name,
    host: conn.host,
    port: String(conn.port || 22),
    user: conn.user,
    password: "",
    hostKey: conn.hostKey ?? "",
    useBastion: Boolean(conn.bastion?.host),
    bastionHost: conn.bastion?.host ?? "",
    bastionPort: String(conn.bastion?.port || 22),
    bastionUser: conn.bastion?.user ?? "",
    bastionPassword: "",
    bastionHostKey: conn.bastion?.hostKey ?? "",
  };
}

function formToInput(form: ConnectionFormState): RemoteConnectionInput {
  const port = Number.parseInt(form.port, 10) || 22;
  const bastionPort = Number.parseInt(form.bastionPort, 10) || 22;
  return {
    name: form.name.trim(),
    host: form.host.trim(),
    port,
    user: form.user.trim(),
    ...(form.password ? { password: form.password } : {}),
    ...(form.hostKey.trim() ? { hostKey: form.hostKey.trim() } : {}),
    bastion:
      form.useBastion && form.bastionHost.trim()
        ? {
            host: form.bastionHost.trim(),
            port: bastionPort,
            user: form.bastionUser.trim(),
            ...(form.bastionPassword ? { password: form.bastionPassword } : {}),
            ...(form.bastionHostKey.trim()
              ? { hostKey: form.bastionHostKey.trim() }
              : {}),
          }
        : null,
  };
}

function splitBreadcrumbs(remotePath: string): readonly { label: string; path: string }[] {
  const clean = remotePath.trim() || "/";
  if (clean === "/") return [{ label: "/", path: "/" }];
  const segments = clean.split("/").filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const seg of segments) {
    acc += `/${seg}`;
    crumbs.push({ label: seg, path: acc });
  }
  return crumbs;
}

export interface AddRemoteProjectModalProps {
  readonly service: RemoteProjectService;
  readonly onClose: () => void;
  readonly onAdded: (record: RemoteProjectRecord) => void;
}

export function AddRemoteProjectModal({
  service,
  onClose,
  onAdded,
}: AddRemoteProjectModalProps) {
  const storeSnapshot = useStore(service.projects);
  const [connections, setConnections] = useState<readonly RemoteConnectionDTO[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

  // 连接表单态（新建或编辑）
  const [form, setForm] = useState<ConnectionFormState | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formStatus, setFormStatus] = useState<string | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<
    Extract<RemoteConnectionTestResult, { status: "host_key_untrusted" | "host_key_mismatch" }> | null
  >(null);
  const [deleteBlockedRefs, setDeleteBlockedRefs] = useState<{
    readonly connectionId: string;
    readonly projects: readonly RemoteProjectRecord[];
  } | null>(null);

  // 右侧远端目录浏览态
  const [currentDir, setCurrentDir] = useState<string>("");
  const [pathInput, setPathInput] = useState<string>("");
  const [parentDir, setParentDir] = useState<string>("/");
  const [entries, setEntries] = useState<readonly RemoteFSEntry[]>([]);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [dirReady, setDirReady] = useState(false);
  // 请求序号：切换连接或目录时丢弃上一条连接的迟到响应，避免目录串台。
  const browseSeqRef = useRef(0);

  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === selectedConnectionId) ?? null,
    [connections, selectedConnectionId],
  );

  const filteredConnections = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.host.toLowerCase().includes(q) ||
        c.user.toLowerCase().includes(q),
    );
  }, [connections, searchQuery]);

  const recentDirs = selectedConnectionId
    ? storeSnapshot.recentDirsByConnection[selectedConnectionId] ?? []
    : [];

  const reloadConnections = useCallback(
    async (preferId?: string | null) => {
      setLoadingConnections(true);
      setConnectionsError(null);
      try {
        const list = await service.listConnections();
        setConnections(list);
        setSelectedConnectionId((current) => {
          if (preferId && list.some((c) => c.id === preferId)) return preferId;
          if (current && list.some((c) => c.id === current)) return current;
          return list[0]?.id ?? null;
        });
      } catch (error) {
        setConnectionsError(describeUnknownError(error));
      } finally {
        setLoadingConnections(false);
      }
    },
    [service],
  );

  useEffect(() => {
    let cancelled = false;
    void service
      .listConnections()
      .then((list) => {
        if (cancelled) return;
        setConnections(list);
        setConnectionsError(null);
        setSelectedConnectionId((current) => {
          if (current && list.some((c) => c.id === current)) return current;
          return list[0]?.id ?? null;
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setConnectionsError(describeUnknownError(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingConnections(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service]);

  const loadDirectory = useCallback(
    async (connectionId: string, targetPath: string) => {
      const seq = ++browseSeqRef.current;
      setDirLoading(true);
      setDirError(null);
      setDirReady(false);
      try {
        const res = await service.listDirectory(connectionId, targetPath);
        if (browseSeqRef.current !== seq) return;
        setCurrentDir(res.path);
        setPathInput(res.path);
        setParentDir(res.parentPath);
        setEntries(res.entries.filter((e) => e.directory));
        setDirReady(true);
      } catch (error) {
        if (browseSeqRef.current !== seq) return;
        setEntries([]);
        setDirError(describeUnknownError(error));
      } finally {
        if (browseSeqRef.current === seq) {
          setDirLoading(false);
        }
      }
    },
    [service],
  );

  // 切换连接时自动加载新连接的家目录，并通过请求序号丢弃旧连接的迟到响应。
  useEffect(() => {
    const seq = ++browseSeqRef.current;
    if (!selectedConnectionId || form !== null) {
      return;
    }
    void service
      .listDirectory(selectedConnectionId, "")
      .then((res) => {
        if (browseSeqRef.current !== seq) return;
        setCurrentDir(res.path);
        setPathInput(res.path);
        setParentDir(res.parentPath);
        setEntries(res.entries.filter((e) => e.directory));
        setDirError(null);
        setDirReady(true);
        setDirLoading(false);
      })
      .catch((error: unknown) => {
        if (browseSeqRef.current !== seq) return;
        setCurrentDir("");
        setPathInput("");
        setEntries([]);
        setDirError(describeUnknownError(error));
        setDirReady(false);
        setDirLoading(false);
      });
  }, [selectedConnectionId, form, service]);

  const runTestForm = async (overrideForm?: ConnectionFormState) => {
    const activeForm = overrideForm ?? form;
    if (!activeForm) return;
    setFormBusy(true);
    setFormError(null);
    setFormStatus(null);
    setHostKeyPrompt(null);
    try {
      const result = await service.testConnection({
        connectionId: activeForm.editingId ?? undefined,
        config: formToInput(activeForm),
      });
      if (result.status === "ok") {
        setFormStatus(`连接成功，远端家目录：${result.homeDir}`);
      } else {
        setHostKeyPrompt(result);
      }
    } catch (error) {
      setFormError(describeUnknownError(error));
    } finally {
      setFormBusy(false);
    }
  };

  const acceptHostKeyAndRetry = () => {
    if (!form || !hostKeyPrompt) return;
    const nextForm: ConnectionFormState =
      hostKeyPrompt.hop === 1
        ? { ...form, bastionHostKey: hostKeyPrompt.hostKey }
        : { ...form, hostKey: hostKeyPrompt.hostKey };
    setForm(nextForm);
    setHostKeyPrompt(null);
    void runTestForm(nextForm);
  };

  const handleSaveForm = async () => {
    if (!form) return;
    setFormBusy(true);
    setFormError(null);
    setFormStatus(null);
    try {
      const input = formToInput(form);
      const saved =
        form.mode === "edit" && form.editingId
          ? await service.updateConnection(form.editingId, input)
          : await service.createConnection(input);
      setForm(null);
      setHostKeyPrompt(null);
      await reloadConnections(saved.id);
    } catch (error) {
      setFormError(describeUnknownError(error));
    } finally {
      setFormBusy(false);
    }
  };

  const handleDeleteConnection = async (conn: RemoteConnectionDTO) => {
    const refs = service.listProjectsForConnection(conn.id);
    if (refs.length > 0) {
      setDeleteBlockedRefs({ connectionId: conn.id, projects: refs });
      return;
    }
    setDeleteBlockedRefs(null);
    try {
      await service.deleteConnection(conn.id);
      await reloadConnections();
    } catch (error) {
      setConnectionsError(describeUnknownError(error));
    }
  };

  const handleConfirmAddProject = () => {
    if (!selectedConnectionId || !dirReady || !currentDir) return;
    const record = service.addProject(selectedConnectionId, currentDir);
    onAdded(record);
    onClose();
  };

  const affectedProjectsForEdit =
    form?.mode === "edit" && form.editingId
      ? service.listProjectsForConnection(form.editingId)
      : [];

  return (
    <ModalShell
      label="添加远程项目 (SSH)"
      size="settings"
      onDismiss={onClose}
    >
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-ui-base font-semibold text-ink">
            添加远程项目（SSH 远程目录）
          </h2>
          <p className="text-ui-xs text-ink-mute">
            选择已保存的 SSH 连接并浏览远端 Linux 目录，首版支持只读文件树与文件预览。
          </p>
        </div>
        <IconButton
          aria-label="关闭"
          onClick={onClose}
        >
          <XIcon className="ui-icon-16" />
        </IconButton>
      </div>

      {/* 主体两栏 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左栏：SSH 连接列表 */}
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-surface-subtle/40">
          <div className="flex items-center gap-2 border-b border-line p-3">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 ui-icon-14 -translate-y-1/2 text-ink-mute" />
              <input
                type="search"
                aria-label="搜索 SSH 连接"
                placeholder="搜索连接…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`${fieldSurfaceClass} w-full py-1.5 pr-2.5 pl-8 text-ui-xs`}
              />
            </div>
            <ActionButton
              tone="secondary"
              type="button"
              onClick={() => {
                setFormError(null);
                setFormStatus(null);
                setHostKeyPrompt(null);
                setForm(emptyForm());
              }}
              className="shrink-0 px-2.5 py-1.5 text-ui-xs"
            >
              新建连接
            </ActionButton>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loadingConnections ? (
              <div className="flex items-center justify-center gap-2 py-8 text-ui-xs text-ink-mute">
                <Spinner className="ui-icon-14" />
                <span>加载连接列表…</span>
              </div>
            ) : connectionsError ? (
              <p role="alert" className="p-2 text-ui-xs text-danger-ink">
                {connectionsError}
              </p>
            ) : filteredConnections.length === 0 ? (
              <p className="px-2 py-8 text-center text-ui-xs text-ink-mute">
                暂无 SSH 连接，点击上方「新建连接」创建。
              </p>
            ) : (
              <ul aria-label="SSH 连接列表" className="flex flex-col gap-1">
                {filteredConnections.map((conn) => {
                  const selected = conn.id === selectedConnectionId && form === null;
                  return (
                    <li
                      key={conn.id}
                      className={`group rounded-lg border px-2.5 py-2 transition-colors ${
                        selected
                          ? "border-accent bg-accent-soft/40"
                          : "border-transparent hover:bg-surface-hover"
                      }`}
                    >
                      <ActionButton
                        tone="ghost"
                        type="button"
                        onClick={() => {
                          setForm(null);
                          setHostKeyPrompt(null);
                          setSelectedConnectionId(conn.id);
                        }}
                        className="flex w-full flex-col items-stretch gap-0.5 px-0 py-0 text-left"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-ui-sm font-medium text-ink">
                            {conn.name}
                          </span>
                          {conn.hostKey ? (
                            <Badge tone="ok">已信任</Badge>
                          ) : (
                            <Badge tone="warn">未确认指纹</Badge>
                          )}
                        </div>
                        <span className="truncate text-ui-xs text-ink-mute">
                          {conn.user}@{conn.host}:{conn.port}
                        </span>
                      </ActionButton>
                      <div className="mt-1.5 flex items-center gap-2">
                        <ActionButton
                          tone="ghost"
                          type="button"
                          onClick={() => {
                            setFormError(null);
                            setFormStatus(null);
                            setHostKeyPrompt(null);
                            setForm(formFromConnection(conn));
                          }}
                          className="px-1 py-0.5 text-ui-caption"
                        >
                          编辑
                        </ActionButton>
                        <ActionButton
                          tone="ghost"
                          type="button"
                          onClick={() => void handleDeleteConnection(conn)}
                          className="px-1 py-0.5 text-ui-caption text-danger-ink"
                        >
                          删除
                        </ActionButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {deleteBlockedRefs && (
              <div
                role="alert"
                className="mt-2 rounded-lg border border-warn-line bg-warn-soft/50 p-2.5 text-ui-xs text-warn-ink"
              >
                <p className="font-medium">该连接仍被以下远程项目引用，无法删除：</p>
                <ul className="mt-1 list-disc pl-4">
                  {deleteBlockedRefs.projects.map((p) => (
                    <li key={p.projectId}>
                      {p.name}（{p.remoteRoot}）
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </aside>

        {/* 右栏：新建/编辑表单 或 远端目录浏览 */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {form ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
              <h3 className="text-ui-sm font-semibold text-ink">
                {form.mode === "create" ? "新建 SSH 连接" : "编辑 SSH 连接"}
              </h3>

              {affectedProjectsForEdit.length > 0 && (
                <div className="mt-2 rounded-lg border border-warn-line bg-warn-soft/40 p-2.5 text-ui-xs text-warn-ink">
                  修改主机、端口、账号或跳板将影响 {affectedProjectsForEdit.length} 个已绑定项目（
                  {affectedProjectsForEdit.map((p) => p.name).join("、")}），保存后将重新建立连接。
                </div>
              )}

              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="col-span-2 flex flex-col gap-1 text-ui-xs text-ink-mute">
                  连接名称
                  <input
                    type="text"
                    placeholder="例如：测试机-Alice"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={`${fieldSurfaceClass} px-2.5 py-1.5 text-ui-sm text-ink`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-ui-xs text-ink-mute">
                  主机地址 *
                  <input
                    type="text"
                    placeholder="10.0.0.1"
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                    className={`${fieldSurfaceClass} px-2.5 py-1.5 text-ui-sm text-ink`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-ui-xs text-ink-mute">
                  端口 *
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                    className={`${fieldSurfaceClass} px-2.5 py-1.5 text-ui-sm text-ink`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-ui-xs text-ink-mute">
                  SSH 账号 *
                  <input
                    type="text"
                    placeholder="dev"
                    value={form.user}
                    onChange={(e) => setForm({ ...form, user: e.target.value })}
                    className={`${fieldSurfaceClass} px-2.5 py-1.5 text-ui-sm text-ink`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-ui-xs text-ink-mute">
                  密码{form.mode === "edit" ? "（留空保留已存密码）" : " *"}
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className={`${fieldSurfaceClass} px-2.5 py-1.5 text-ui-sm text-ink`}
                  />
                </label>
              </div>

              <div className="mt-3">
                <ActionButton
                  tone="ghost"
                  type="button"
                  onClick={() => setForm({ ...form, useBastion: !form.useBastion })}
                  className="px-1 py-0.5 text-ui-xs"
                >
                  {form.useBastion ? "隐藏跳板机配置" : "+ 添加跳板机（可选）"}
                </ActionButton>
                {form.useBastion && (
                  <div className="mt-2 grid grid-cols-2 gap-3 rounded-lg border border-line p-3">
                    <label className="flex flex-col gap-1 text-ui-xs text-ink-mute">
                      跳板机地址
                      <input
                        type="text"
                        value={form.bastionHost}
                        onChange={(e) =>
                          setForm({ ...form, bastionHost: e.target.value })
                        }
                        className={`${fieldSurfaceClass} px-2.5 py-1.5 text-ui-sm text-ink`}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-ui-xs text-ink-mute">
                      跳板机端口
                      <input
                        type="number"
                        value={form.bastionPort}
                        onChange={(e) =>
                          setForm({ ...form, bastionPort: e.target.value })
                        }
                        className={`${fieldSurfaceClass} px-2.5 py-1.5 text-ui-sm text-ink`}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-ui-xs text-ink-mute">
                      跳板机账号
                      <input
                        type="text"
                        value={form.bastionUser}
                        onChange={(e) =>
                          setForm({ ...form, bastionUser: e.target.value })
                        }
                        className={`${fieldSurfaceClass} px-2.5 py-1.5 text-ui-sm text-ink`}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-ui-xs text-ink-mute">
                      跳板机密码
                      <input
                        type="password"
                        value={form.bastionPassword}
                        onChange={(e) =>
                          setForm({ ...form, bastionPassword: e.target.value })
                        }
                        className={`${fieldSurfaceClass} px-2.5 py-1.5 text-ui-sm text-ink`}
                      />
                    </label>
                  </div>
                )}
              </div>

              {hostKeyPrompt && (
                <div
                  role="alert"
                  className={`mt-4 rounded-lg border p-3 text-ui-xs ${
                    hostKeyPrompt.status === "host_key_mismatch"
                      ? "border-danger-line bg-danger-soft/40 text-danger-ink"
                      : "border-warn-line bg-warn-soft/40 text-warn-ink"
                  }`}
                >
                  <p className="font-semibold">
                    {hostKeyPrompt.status === "host_key_mismatch"
                      ? `警告：主机 ${hostKeyPrompt.host}:${hostKeyPrompt.port} 的 SSH 指纹已发生变化！`
                      : `首次连接 ${hostKeyPrompt.host}:${hostKeyPrompt.port}，请核对 SSH 主机指纹：`}
                  </p>
                  <p className="mt-1 font-mono break-all">
                    {hostKeyPrompt.keyType} · {hostKeyPrompt.fingerprint}
                  </p>
                  {hostKeyPrompt.status === "host_key_mismatch" && (
                    <p className="mt-1 font-mono break-all">
                      原信任指纹：{hostKeyPrompt.expectedFingerprint}
                    </p>
                  )}
                  <div className="mt-2.5 flex items-center gap-2">
                    <ActionButton
                      tone="primary"
                      type="button"
                      onClick={acceptHostKeyAndRetry}
                      className="px-2.5 py-1 text-ui-xs"
                    >
                      信任此指纹并继续测试
                    </ActionButton>
                    <ActionButton
                      tone="secondary"
                      type="button"
                      onClick={() => setHostKeyPrompt(null)}
                      className="px-2.5 py-1 text-ui-xs"
                    >
                      取消
                    </ActionButton>
                  </div>
                </div>
              )}

              {formStatus && (
                <p className="mt-3 text-ui-xs text-success-ink">{formStatus}</p>
              )}
              {formError && (
                <p role="alert" className="mt-3 text-ui-xs text-danger-ink">
                  {formError}
                </p>
              )}

              <div className="mt-5 flex items-center gap-2">
                <ActionButton
                  tone="secondary"
                  type="button"
                  disabled={formBusy}
                  onClick={() => void runTestForm()}
                  className="px-3 py-1.5 text-ui-xs"
                >
                  {formBusy ? "处理中…" : "测试连接"}
                </ActionButton>
                <ActionButton
                  tone="primary"
                  type="button"
                  disabled={formBusy || !form.host.trim() || !form.user.trim()}
                  onClick={() => void handleSaveForm()}
                  className="px-3 py-1.5 text-ui-xs"
                >
                  保存连接
                </ActionButton>
                <ActionButton
                  tone="secondary"
                  type="button"
                  disabled={formBusy}
                  onClick={() => {
                    setForm(null);
                    setHostKeyPrompt(null);
                  }}
                  className="px-3 py-1.5 text-ui-xs"
                >
                  返回浏览
                </ActionButton>
              </div>
            </div>
          ) : !selectedConnection ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-ui-sm text-ink-mute">
              请先在左侧选择或新建一个 SSH 连接。
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {/* 路径输入栏 */}
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <ActionButton
                  tone="secondary"
                  type="button"
                  disabled={dirLoading || !currentDir || currentDir === "/"}
                  onClick={() => void loadDirectory(selectedConnection.id, parentDir)}
                  className="shrink-0 px-2.5 py-1 text-ui-xs"
                >
                  上一级
                </ActionButton>
                <input
                  type="text"
                  aria-label="远端目录绝对路径"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void loadDirectory(selectedConnection.id, pathInput);
                    }
                  }}
                  placeholder="/home/user/project"
                  className={`${fieldSurfaceClass} min-w-0 flex-1 px-2.5 py-1 font-mono text-ui-xs text-ink`}
                />
                <ActionButton
                  tone="secondary"
                  type="button"
                  disabled={dirLoading}
                  onClick={() => void loadDirectory(selectedConnection.id, pathInput)}
                  className="shrink-0 px-2.5 py-1 text-ui-xs"
                >
                  前往
                </ActionButton>
              </div>

              {/* 面包屑与最近目录 */}
              <div className="flex flex-wrap items-center gap-1 border-b border-line/70 px-4 py-1.5 text-ui-xs text-ink-mute">
                {splitBreadcrumbs(currentDir || "/").map((crumb, idx) => (
                  <span key={crumb.path} className="inline-flex items-center gap-1">
                    {idx > 0 && <span>/</span>}
                    <ActionButton
                      tone="ghost"
                      type="button"
                      onClick={() => void loadDirectory(selectedConnection.id, crumb.path)}
                      className="px-1 py-0.5 text-ui-xs"
                    >
                      {crumb.label}
                    </ActionButton>
                  </span>
                ))}
              </div>

              {recentDirs.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-line/60 px-4 py-1.5 text-ui-caption">
                  <span className="text-ink-mute">最近目录：</span>
                  {recentDirs.map((dir) => (
                    <ActionButton
                      key={dir}
                      tone="secondary"
                      type="button"
                      onClick={() => void loadDirectory(selectedConnection.id, dir)}
                      className="px-1.5 py-0.5 font-mono text-ui-caption"
                    >
                      {dir}
                    </ActionButton>
                  ))}
                </div>
              )}

              {/* 目录内容列表 */}
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {dirLoading ? (
                  <div className="flex items-center justify-center gap-2 py-12 text-ui-xs text-ink-mute">
                    <Spinner className="ui-icon-14" />
                    <span>正在加载远端目录…</span>
                  </div>
                ) : dirError ? (
                  <div role="alert" className="rounded-lg border border-danger-line bg-danger-soft/30 p-3 text-ui-xs text-danger-ink">
                    <p>{dirError}</p>
                    {!selectedConnection.hostKey && (
                      <ActionButton
                        tone="secondary"
                        type="button"
                        onClick={() => setForm(formFromConnection(selectedConnection))}
                        className="mt-2 px-2.5 py-1 text-ui-xs"
                      >
                        前往编辑并确认主机指纹
                      </ActionButton>
                    )}
                  </div>
                ) : entries.length === 0 ? (
                  <p className="py-10 text-center text-ui-xs text-ink-mute">
                    当前目录下没有子目录，可直接添加此目录为项目根目录。
                  </p>
                ) : (
                  <ul aria-label="远端目录列表" className="flex flex-col gap-0.5">
                    {entries.map((entry) => (
                      <li key={entry.path}>
                        <ActionButton
                          tone="ghost"
                          type="button"
                          onClick={() => void loadDirectory(selectedConnection.id, entry.path)}
                          className="flex w-full items-center justify-start gap-2 px-2.5 py-1.5 text-left text-ui-sm"
                        >
                          <FolderGlyph isExpanded={false} className="ui-icon-14 shrink-0 text-ink-mute" />
                          <span className="truncate">{entry.name}</span>
                        </ActionButton>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* 底部确认条 */}
              <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-ui-xs text-ink">
                    {dirReady && currentDir
                      ? `${selectedConnection.name} · ${currentDir}`
                      : "请选择可访问的远端目录"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <ActionButton
                    tone="secondary"
                    type="button"
                    onClick={onClose}
                    className="px-3 py-1.5 text-ui-xs"
                  >
                    取消
                  </ActionButton>
                  <ActionButton
                    tone="primary"
                    type="button"
                    disabled={!dirReady || !currentDir}
                    onClick={handleConfirmAddProject}
                    className="px-3.5 py-1.5 text-ui-xs"
                  >
                    添加项目
                  </ActionButton>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </ModalShell>
  );
}
