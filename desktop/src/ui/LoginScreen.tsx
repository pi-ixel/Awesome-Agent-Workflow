/**
 * 登录界面（未登录时的全屏门槛）：企业 SSO 主路径 + 开发者降级登录。
 *
 * - SSO：填认证接口地址（本机持久化，对接内网后可在代码里固化默认值），
 *   点击后等待认证完成——服务端会弹认证页（可能需要人工介入），按钮转
 *   进行中态并提供「取消」；失败原因（HTTP 状态 / 契约解析）原文展示；
 * - 降级（对接内网前的功能自验）：开发者手填姓名 + 工号（邮箱可选），
 *   唯一 ID 用本机固定 UUID（authStore.getDevUuid，只读展示 + 可复制）；
 * - 视觉对齐 StartupScreen：同款可拖拽标题栏 + 窗控，品牌标记复用
 *   aaw-logo，主题一律走语义 token 类。
 */
import { useState, type FormEvent } from "react";

import logo from "../assets/aaw-logo.png";
import { getDevUuid, useAuthStore } from "../stores/authStore.ts";
import { useToastStore } from "../stores/toastStore.ts";
import { btnGhost, btnPrimary, btnSecondary } from "./controls.tsx";
import { WindowControls } from "./workbench/WindowControls.tsx";

/** 输入框公共样式（对齐 SettingsPage 的行内输入）。 */
const inputClass =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent-ink";

export function LoginScreen() {
  const currentUser = useAuthStore((state) => state.currentUser);
  const ssoEndpoint = useAuthStore((state) => state.ssoEndpoint);
  const ssoPending = useAuthStore((state) => state.ssoPending);
  const ssoError = useAuthStore((state) => state.ssoError);
  const setSsoEndpoint = useAuthStore((state) => state.setSsoEndpoint);
  const loginWithSso = useAuthStore((state) => state.loginWithSso);
  const cancelSsoLogin = useAuthStore((state) => state.cancelSsoLogin);
  const loginAsDev = useAuthStore((state) => state.loginAsDev);

  const [showDevForm, setShowDevForm] = useState(false);
  const [devName, setDevName] = useState("");
  const [devEmployeeId, setDevEmployeeId] = useState("");
  const [devEmail, setDevEmail] = useState("");
  const [devError, setDevError] = useState<string | null>(null);
  const [devUuid] = useState(() => getDevUuid());

  if (currentUser !== null) {
    // 已登录（登录动作完成、门槛解除）：本组件随即被 AuthGate 卸载，
    // 这里只防一下状态竞态下的闪现
    return null;
  }

  const submitDevLogin = (event: FormEvent): void => {
    event.preventDefault();
    if (devName.trim() === "" || devEmployeeId.trim() === "") {
      setDevError("姓名与工号为必填项");
      return;
    }
    try {
      const user = loginAsDev({
        name: devName,
        employeeId: devEmployeeId,
        email: devEmail,
      });
      useToastStore.getState().push({
        message: `已以开发者身份登录：${user.name}（${user.employeeId}）`,
        variant: "ok",
      });
    } catch (error) {
      setDevError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section
      className="fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-base text-ink"
      aria-label="登录"
    >
      {/* 可拖拽标题栏 + 窗控：登录是全屏门槛，不能把窗口钉死 */}
      <div
        className="flex h-10 shrink-0 items-center"
        data-tauri-drag-region=""
      >
        <WindowControls />
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
        <div className="w-full max-w-md rounded-xl border border-line-strong bg-surface p-6 shadow-elev-3">
          {/* 品牌头 */}
          <div className="flex items-center gap-3">
            <img
              src={logo}
              alt=""
              draggable={false}
              className="size-10 rounded-lg"
            />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-ink">登录 AAW</h1>
              <p className="truncate text-ui-sm text-ink-mute">
                使用企业身份登录，工作数据将归属你的账号
              </p>
            </div>
          </div>

          {/* SSO 主路径 */}
          <div className="mt-6">
            <label
              htmlFor="sso-endpoint"
              className="block text-ui-sm font-medium text-ink"
            >
              企业 SSO 认证接口
            </label>
            <input
              id="sso-endpoint"
              type="url"
              value={ssoEndpoint}
              onChange={(event) => setSsoEndpoint(event.target.value)}
              placeholder="https://sso.example.com/auth"
              disabled={ssoPending}
              spellCheck={false}
              className={`${inputClass} mt-1.5`}
            />
            <button
              type="button"
              onClick={() => void loginWithSso()}
              disabled={ssoPending}
              className={`${btnPrimary} mt-2.5 h-9 w-full text-sm`}
            >
              {ssoPending ? "等待认证完成…" : "使用企业 SSO 登录"}
            </button>
            {ssoPending && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-ui-sm text-ink-mute" role="status">
                  已发起认证，请在弹出的登录页完成操作（最长等待 3 分钟）
                </p>
                <button
                  type="button"
                  onClick={cancelSsoLogin}
                  className={`${btnGhost} shrink-0 rounded-md px-2 py-1 text-ui-sm`}
                >
                  取消
                </button>
              </div>
            )}
            {ssoError !== null && !ssoPending && (
              <p
                role="alert"
                className="mt-2 rounded-md border border-danger-line bg-danger-bg/40 px-2.5 py-2 text-ui-sm break-all text-danger-ink"
              >
                {ssoError}
              </p>
            )}
          </div>

          {/* 分隔线 */}
          <div className="mt-6 flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-line-strong" />
            <span className="text-ui-sm text-ink-faint">或</span>
            <span className="h-px flex-1 bg-line-strong" />
          </div>

          {/* 开发者降级登录 */}
          <div className="mt-5">
            {!showDevForm ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowDevForm(true)}
                  className={`${btnSecondary} h-9 w-full text-sm`}
                >
                  开发者身份登录（降级自验）
                </button>
                <p className="mt-2 text-center text-ui-sm text-ink-faint">
                  内网 SSO 对接完成前的功能自验通道
                </p>
              </>
            ) : (
              <form
                aria-label="开发者降级登录"
                onSubmit={submitDevLogin}
                className="flex flex-col gap-2.5"
              >
                <p className="text-ui-sm font-medium text-ink">
                  开发者身份（降级自验）
                </p>
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="block">
                    <span className="mb-1 block text-ui-sm text-ink-mute">
                      姓名 <span className="text-danger-ink">*</span>
                    </span>
                    <input
                      value={devName}
                      onChange={(event) => setDevName(event.target.value)}
                      placeholder="张三"
                      autoFocus
                      className={inputClass}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-ui-sm text-ink-mute">
                      工号 <span className="text-danger-ink">*</span>
                    </span>
                    <input
                      value={devEmployeeId}
                      onChange={(event) => setDevEmployeeId(event.target.value)}
                      placeholder="100001"
                      className={inputClass}
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-ui-sm text-ink-mute">
                    邮箱（可选）
                  </span>
                  <input
                    type="email"
                    value={devEmail}
                    onChange={(event) => setDevEmail(event.target.value)}
                    placeholder="name@example.com"
                    className={inputClass}
                  />
                </label>
                {/* 唯一 ID 只读展示：本机固定 UUID，自验数据的稳定归属 */}
                <div>
                  <span className="mb-1 block text-ui-sm text-ink-mute">
                    唯一 ID（本机固定，自动分配）
                  </span>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-base px-2.5 py-1.5 font-mono text-xs text-ink-soft">
                      {devUuid}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(devUuid)
                          .then(() => {
                            useToastStore.getState().push({
                              message: "已复制唯一 ID",
                              variant: "ok",
                            });
                          })
                          .catch(() => {
                            useToastStore
                              .getState()
                              .push({ message: "复制失败", variant: "warn" });
                          });
                      }}
                      className={`${btnGhost} shrink-0 rounded-md px-2 py-1.5 text-ui-sm`}
                    >
                      复制
                    </button>
                  </div>
                </div>
                {devError !== null && (
                  <p role="alert" className="text-ui-sm text-danger-ink">
                    {devError}
                  </p>
                )}
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="submit"
                    className={`${btnPrimary} h-9 flex-1 text-sm`}
                  >
                    以此身份登录
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowDevForm(false);
                      setDevError(null);
                    }}
                    className={`${btnGhost} rounded-md px-3 py-1.5 text-sm`}
                  >
                    返回
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
