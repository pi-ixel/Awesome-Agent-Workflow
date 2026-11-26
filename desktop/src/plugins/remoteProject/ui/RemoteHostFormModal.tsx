import { useState } from "react";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import {
  ActionButton,
  Checkbox,
  Spinner,
} from "../../../shared/ui/controls.tsx";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import { Disclosure } from "../../../shared/ui/Disclosure.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { settingsInputClass } from "../../../shared/ui/inputStyles.ts";
import {
  settingsLabelClass,
  settingsDescriptionClass,
} from "../../../shared/ui/settingsTypography.ts";
import { XIcon } from "../../../shared/ui/icons.tsx";
import { describeUnknownError } from "../../../shared/errors.ts";
import type {
  RemoteAuthType,
  RemoteConnectionDTO,
  RemoteConnectionInput,
  RemoteProjectService,
} from "../service.ts";

interface HostFormState {
  readonly name: string;
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly authType: RemoteAuthType;
  readonly privateKeyPath: string;
  readonly password: string;
  readonly hostKey: string;
  readonly useBastion: boolean;
  readonly bastionHost: string;
  readonly bastionPort: string;
  readonly bastionUser: string;
  readonly bastionPassword: string;
  readonly bastionHostKey: string;
}

function initialFormState(
  connection?: RemoteConnectionDTO | null,
): HostFormState {
  if (!connection) {
    return {
      name: "",
      host: "",
      port: "22",
      user: "",
      authType: "password",
      privateKeyPath: "",
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
  return {
    name: connection.name,
    host: connection.host,
    port: String(connection.port || 22),
    user: connection.user,
    authType: connection.authType ?? "password",
    privateKeyPath: connection.privateKeyPath ?? "",
    password: "",
    hostKey: connection.hostKey ?? "",
    useBastion: Boolean(connection.bastion?.host),
    bastionHost: connection.bastion?.host ?? "",
    bastionPort: String(connection.bastion?.port || 22),
    bastionUser: connection.bastion?.user ?? "",
    bastionPassword: "",
    bastionHostKey: connection.bastion?.hostKey ?? "",
  };
}

function formToInput(form: HostFormState): RemoteConnectionInput {
  const host = form.host.trim();
  const user = form.user.trim();
  const name = form.name.trim() || (user ? `${user}@${host}` : host);
  const port = Number.parseInt(form.port, 10) || 22;
  const bastionPort = Number.parseInt(form.bastionPort, 10) || 22;
  return {
    name,
    host,
    port,
    user,
    authType: form.authType,
    ...(form.authType === "key" && form.privateKeyPath.trim()
      ? { privateKeyPath: form.privateKeyPath.trim() }
      : {}),
    ...(form.authType !== "agent" && form.password
      ? { password: form.password }
      : {}),
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

export interface RemoteHostFormModalProps {
  readonly service: RemoteProjectService;
  readonly connection?: RemoteConnectionDTO | null;
  readonly onClose: () => void;
  readonly onSaved: (connection: RemoteConnectionDTO) => void;
}

export function RemoteHostFormModal({
  service,
  connection,
  onClose,
  onSaved,
}: RemoteHostFormModalProps) {
  const isEdit = Boolean(connection);
  const [form, setForm] = useState<HostFormState>(() =>
    initialFormState(connection),
  );
  const defaultAdvancedOpen = Boolean(
    connection &&
    ((connection.port && connection.port !== 22) || connection.bastion?.host),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const validate = (): string | null => {
    if (!form.host.trim() || !form.user.trim()) {
      return "请填写主机地址和用户名。";
    }
    if (form.authType === "key" && !form.privateKeyPath.trim()) {
      return "私钥认证需要填写私钥文件路径。";
    }
    if (
      form.useBastion &&
      (!form.bastionHost.trim() || !form.bastionUser.trim())
    ) {
      return "启用跳板机时请填写跳板机地址和用户名。";
    }
    return null;
  };

  const handleTest = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await service.testConnection({
        config: formToInput(form),
        ...(connection ? { connectionId: connection.id } : {}),
      });
      if (result.status === "ok") {
        setStatus(`连接成功，远端家目录：${result.homeDir || "/"}`);
      } else {
        setError("连接测试失败");
      }
    } catch (err) {
      setError(describeUnknownError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const input = formToInput(form);
      const saved = connection
        ? await service.updateConnection(connection.id, input)
        : await service.createConnection(input);
      onSaved(saved);
    } catch (err) {
      setError(describeUnknownError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      onDismiss={onClose}
      label={isEdit ? "编辑远程主机" : "添加远程主机"}
      size="default"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div>
          <h2 className="text-ui-base font-semibold text-ink">
            {isEdit ? "编辑远程主机" : "添加远程主机"}
          </h2>
          <p className={`mt-0.5 ${settingsDescriptionClass}`}>
            配置 SSH 连接信息，保存后可用于添加多个远程项目。
          </p>
        </div>
        <IconButton aria-label="关闭" onClick={onClose}>
          <XIcon className="ui-icon-16" />
        </IconButton>
      </div>

      <div className="flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
        <label className="block">
          <span className={`mb-1 ${settingsLabelClass}`}>主机名称（可选）</span>
          <input
            type="text"
            aria-label="连接名称"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="例如：dev-box（留空则自动使用 user@host）"
            className={`${settingsInputClass}`}
          />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={`mb-1 ${settingsLabelClass}`}>主机地址</span>
            <input
              type="text"
              aria-label="主机地址"
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder="10.0.0.12 或 dev.example.com"
              className={`${settingsInputClass} font-mono`}
            />
          </label>
          <label className="block">
            <span className={`mb-1 ${settingsLabelClass}`}>用户名</span>
            <input
              type="text"
              aria-label="用户名"
              value={form.user}
              onChange={(e) => setForm({ ...form, user: e.target.value })}
              placeholder="root / ubuntu"
              className={`${settingsInputClass} font-mono`}
            />
          </label>
        </div>

        <div>
          <span className={`mb-1.5 ${settingsLabelClass}`}>认证方式</span>
          <SegmentedControl
            groupLabel="SSH 认证方式"
            value={form.authType}
            onChange={(authType) => setForm({ ...form, authType })}
            options={[
              { value: "password", label: "密码" },
              { value: "key", label: "私钥文件" },
              { value: "agent", label: "SSH Agent" },
            ]}
          />
        </div>

        {form.authType === "key" && (
          <label className="block">
            <span className={`mb-1 ${settingsLabelClass}`}>私钥文件路径</span>
            <input
              type="text"
              aria-label="私钥文件路径"
              value={form.privateKeyPath}
              onChange={(e) =>
                setForm({ ...form, privateKeyPath: e.target.value })
              }
              placeholder="~/.ssh/id_ed25519"
              className={`${settingsInputClass} font-mono`}
            />
          </label>
        )}

        {form.authType !== "agent" ? (
          <label className="block">
            <span className={`mb-1 ${settingsLabelClass}`}>
              {form.authType === "key"
                ? isEdit
                  ? "私钥口令（留空保持不变）"
                  : "私钥口令（无口令可留空）"
                : isEdit
                  ? "SSH 密码（留空保持不变）"
                  : "SSH 密码"}
            </span>
            <input
              type="password"
              aria-label={form.authType === "key" ? "私钥口令" : "SSH 密码"}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder={
                form.authType === "key"
                  ? "可选，仅加密私钥需要"
                  : isEdit
                    ? "不修改请留空"
                    : "加密保存在本机"
              }
              className={`${settingsInputClass}`}
            />
          </label>
        ) : (
          <p className="rounded-control border border-line bg-raised/50 px-3 py-2 text-ui-caption text-ink-mute">
            将通过本机 SSH Agent 自动认证（Windows OpenSSH Authentication Agent
            或 Unix SSH_AUTH_SOCK）。
          </p>
        )}

        <div className="rounded-control border border-line bg-raised/30 px-3 py-2">
          <Disclosure
            defaultOpen={defaultAdvancedOpen}
            summary={
              <span className={settingsLabelClass}>
                高级选项（端口、跳板机）
              </span>
            }
          >
            <div className="mt-3 space-y-3 border-t border-line/70 pt-3">
              <label className="block max-w-[160px]">
                <span className={`mb-1 ${settingsLabelClass}`}>SSH 端口</span>
                <input
                  type="text"
                  aria-label="端口"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  placeholder="22"
                  className={`${settingsInputClass} font-mono`}
                />
              </label>

              <Checkbox
                checked={form.useBastion}
                onChange={(checked) =>
                  setForm({ ...form, useBastion: checked })
                }
                label="通过跳板机（Bastion）连接"
              />

              {form.useBastion && (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <label className="block">
                    <span className={`mb-1 ${settingsLabelClass}`}>
                      跳板机地址
                    </span>
                    <input
                      type="text"
                      aria-label="跳板机地址"
                      value={form.bastionHost}
                      onChange={(e) =>
                        setForm({ ...form, bastionHost: e.target.value })
                      }
                      placeholder="bastion.example.com"
                      className={`${settingsInputClass} font-mono`}
                    />
                  </label>
                  <label className="block">
                    <span className={`mb-1 ${settingsLabelClass}`}>
                      跳板机端口
                    </span>
                    <input
                      type="text"
                      aria-label="跳板机端口"
                      value={form.bastionPort}
                      onChange={(e) =>
                        setForm({ ...form, bastionPort: e.target.value })
                      }
                      placeholder="22"
                      className={`${settingsInputClass} font-mono`}
                    />
                  </label>
                  <label className="block">
                    <span className={`mb-1 ${settingsLabelClass}`}>
                      跳板机用户名
                    </span>
                    <input
                      type="text"
                      aria-label="跳板机用户名"
                      value={form.bastionUser}
                      onChange={(e) =>
                        setForm({ ...form, bastionUser: e.target.value })
                      }
                      placeholder="jump"
                      className={`${settingsInputClass} font-mono`}
                    />
                  </label>
                  <label className="block">
                    <span className={`mb-1 ${settingsLabelClass}`}>
                      {isEdit ? "跳板机密码（留空保持不变）" : "跳板机密码"}
                    </span>
                    <input
                      type="password"
                      aria-label="跳板机密码"
                      value={form.bastionPassword}
                      onChange={(e) =>
                        setForm({ ...form, bastionPassword: e.target.value })
                      }
                      className={`${settingsInputClass}`}
                    />
                  </label>
                </div>
              )}
            </div>
          </Disclosure>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-control border border-danger-ink/30 bg-danger-soft px-3 py-2 text-ui-caption text-danger-ink"
          >
            {error}
          </div>
        )}
        {status && (
          <div className="rounded-control border border-ok-ink/30 bg-ok-soft px-3 py-2 text-ui-caption text-ok-ink">
            {status}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line px-5 py-3">
        <ActionButton
          tone="secondary"
          size="compact"
          type="button"
          disabled={busy}
          onClick={() => void handleTest()}
        >
          {busy ? <Spinner className="ui-icon-12" /> : "测试连接"}
        </ActionButton>
        <div className="flex items-center gap-2">
          <ActionButton
            tone="ghost"
            size="compact"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </ActionButton>
          <ActionButton
            tone="primary"
            size="compact"
            type="button"
            disabled={busy}
            onClick={() => void handleSave()}
          >
            {busy ? "保存中…" : isEdit ? "保存修改" : "保存主机"}
          </ActionButton>
        </div>
      </div>
    </ModalShell>
  );
}
