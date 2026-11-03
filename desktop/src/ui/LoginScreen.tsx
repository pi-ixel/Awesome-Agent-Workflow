/**
 * 登录界面（未登录时的全屏门槛）。
 *
 * - 构建内置了 SSO 配置（core/authConfig.ts）：呈现「企业身份登录」入口，
 *   进入本界面即直接发起一次认证尝试（先静默探测已有登录态，需要时弹出
 *   企业认证窗口，完成自动继续），等待中可取消；失败原文展示；另留一个
 *   不显眼的手动输入入口；
 * - 未内置（本构建未对接内网）：直接呈现登录窗口——用户只填用户名
 *   （界面展示用）与工号（唯一区分身份），其余细节（端点 / 登录页 /
 *   内部唯一 ID）一律不暴露。
 * - 视觉对齐 StartupScreen：同款可拖拽标题栏 + 窗控，品牌标记复用
 *   aaw-logo，主题一律走语义 token 类。
 */
import { useEffect, useState, type FormEvent } from "react";

import logo from "../assets/aaw-logo.png";
import {
  isSsoConfigured,
  shouldAttemptSsoOnce,
  useAuthStore,
} from "../stores/authStore.ts";
import { useToastStore } from "../stores/toastStore.ts";
import { btnGhost, btnPrimary } from "./controls.tsx";
import { WindowControls } from "./workbench/WindowControls.tsx";

/** 输入框公共样式（对齐 SettingsPage 的行内输入）。 */
const inputClass =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent-ink";

export function LoginScreen() {
  const currentUser = useAuthStore((state) => state.currentUser);
  const ssoPending = useAuthStore((state) => state.ssoPending);
  const ssoError = useAuthStore((state) => state.ssoError);
  const loginWithSso = useAuthStore((state) => state.loginWithSso);
  const cancelSsoLogin = useAuthStore((state) => state.cancelSsoLogin);
  const loginAsDev = useAuthStore((state) => state.loginAsDev);

  const ssoReady = isSsoConfigured();
  const [showManualForm, setShowManualForm] = useState(!ssoReady);
  const [name, setName] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // 内置了 SSO：进登录界面即直接尝试认证（每进程一次），成功自动进工作台
  useEffect(() => {
    if (ssoReady && shouldAttemptSsoOnce()) {
      void loginWithSso();
    }
  }, [ssoReady, loginWithSso]);

  if (currentUser !== null) {
    // 已登录（登录动作完成、门槛解除）：本组件随即被 AuthGate 卸载，
    // 这里只防一下状态竞态下的闪现
    return null;
  }

  const submitLogin = (event: FormEvent): void => {
    event.preventDefault();
    if (name.trim() === "" || employeeId.trim() === "") {
      setFormError("请填写用户名和工号");
      return;
    }
    try {
      const user = loginAsDev({ name, employeeId });
      useToastStore.getState().push({
        message: `已登录：${user.name}`,
        variant: "ok",
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
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
        <div className="w-full max-w-sm rounded-xl border border-line-strong bg-surface p-6 shadow-elev-3">
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
                登录后开始使用你的工作区
              </p>
            </div>
          </div>

          {/* SSO 主路径：直接尝试，无需任何配置展示 */}
          {ssoReady && (
            <div className="mt-6">
              <button
                type="button"
                onClick={() => void loginWithSso()}
                disabled={ssoPending}
                className={`${btnPrimary} h-9 w-full text-sm`}
              >
                {ssoPending ? "正在认证…" : "企业身份登录"}
              </button>
              {ssoPending && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-ui-sm text-ink-mute" role="status">
                    正在检测已有登录态，需要登录时会弹出企业认证窗口
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
              {!showManualForm && (
                <button
                  type="button"
                  onClick={() => setShowManualForm(true)}
                  className={`${btnGhost} mt-2 h-8 w-full text-sm`}
                >
                  手动输入身份登录
                </button>
              )}
            </div>
          )}

          {/* 手动身份窗口：用户名（展示用）+ 工号（唯一区分身份） */}
          {showManualForm && (
            <form
              aria-label="身份登录"
              onSubmit={submitLogin}
              className={`flex flex-col gap-2.5 ${ssoReady ? "mt-4 border-t border-line pt-4" : "mt-6"}`}
            >
              <label className="block">
                <span className="mb-1 block text-ui-sm text-ink-mute">
                  用户名 <span className="text-danger-ink">*</span>
                </span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="如：张三"
                  autoFocus
                  spellCheck={false}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-ui-sm text-ink-mute">
                  工号 <span className="text-danger-ink">*</span>
                </span>
                <input
                  value={employeeId}
                  onChange={(event) => setEmployeeId(event.target.value)}
                  placeholder="如：100001"
                  spellCheck={false}
                  className={inputClass}
                />
              </label>
              <p className="text-ui-sm text-ink-faint">
                用户名仅用于界面展示，工号用于唯一区分身份
              </p>
              {formError !== null && (
                <p role="alert" className="text-ui-sm text-danger-ink">
                  {formError}
                </p>
              )}
              <button
                type="submit"
                className={`${btnPrimary} mt-1 h-9 text-sm`}
              >
                登录
              </button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
