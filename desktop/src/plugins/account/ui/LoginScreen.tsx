/**
 * 登录界面（未登录时的全屏门槛）。
 *
 * - 构建内置了 SSO 配置（core/authConfig.ts）：呈现「企业身份登录」入口，
 *   进入本界面即直接发起一次认证尝试（先静默探测已有登录态，需要时弹出
 *   企业认证窗口，完成自动继续），等待中可取消；失败原文展示；
 * - 手动身份输入是 **兜底通道**：默认不可见（防止不耐烦的用户顺手
 *   点击、绕过统一身份认证）；认证失败立即出现，等待满 45s 也先亮出
 *   （轮询与登录窗不打断，给等不了的用户一个出口）；
 * - 未内置（本构建未对接内网）：直接呈现登录窗口——用户只填用户名
 *   （界面展示用）与工号（唯一区分身份），其余细节（端点 / 登录页 /
 *   内部唯一 ID）一律不暴露。
 * - Workbench 提供登录外壳和窗控。表单使用共享的品牌标记和主题样式。
 */
import { useEffect, useState, type FormEvent } from "react";
import { useStore } from "zustand";

import logo from "../../../shared/assets/aaw-logo.png";
import type { AccountService } from "../service.ts";
import { useFeedback } from "../../../shared/ui/feedback.ts";
import { btnGhost, btnPrimary } from "../../../shared/ui/controls.tsx";

/** 输入框公共样式（对齐 SettingsPage 的行内输入）。 */
const inputClass =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent-ink";

/**
 * 认证等待多久后先亮出手动兜底入口（毫秒）。轮询与登录窗不受影响——
 * 只是给等不了的用户多一个出口；认证真实失败时入口立即出现。
 */
const SSO_MANUAL_ENTRY_DELAY_MS = 45_000;

export function LoginScreen({ account }: { readonly account: AccountService }) {
  const notify = useFeedback();
  const currentUser = useStore(account.state, (state) => state.currentUser);
  const ssoPending = useStore(account.state, (state) => state.ssoPending);
  const ssoError = useStore(account.state, (state) => state.ssoError);
  const { loginWithSso, cancelSsoLogin, loginAsDev } = account;

  const ssoReady = account.isSsoConfigured();
  const ssoAttemptId = useStore(account.state, (state) => state.ssoAttemptId);
  const [showManualForm, setShowManualForm] = useState(!ssoReady);
  const [name, setName] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // 「等待满 45s 先亮出」的解锁标记：记录所属等待轮次，新一轮等待自动失效
  const [manualUnlock, setManualUnlock] = useState<{
    attempt: number;
    unlocked: boolean;
  }>({ attempt: 0, unlocked: false });

  // 内置了 SSO：进登录界面即直接尝试认证（每进程一次），成功自动进工作台
  useEffect(() => {
    if (ssoReady) account.trySsoOnce();
  }, [account, ssoReady]);

  // 认证等待计时：满 45s 先亮出手动入口（不取消认证、不打断登录窗；
  // 只在定时器回调里写状态，effect 体内不做同步 setState）
  useEffect(() => {
    if (!ssoReady || !ssoPending) {
      return;
    }
    const timer = setTimeout(
      () => setManualUnlock({ attempt: ssoAttemptId, unlocked: true }),
      SSO_MANUAL_ENTRY_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [ssoReady, ssoPending, ssoAttemptId]);

  const manualEntryUnlocked =
    manualUnlock.attempt === ssoAttemptId && manualUnlock.unlocked;
  // 手动入口可见：认证已失败（真实兜底），或本轮等待满 45s（先亮出，不中止等待）
  const manualEntryVisible =
    !showManualForm &&
    (manualEntryUnlocked || (ssoError !== null && !ssoPending));

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
      notify?.({
        message: `已登录：${user.name}`,
        variant: "ok",
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
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
            {/* 手动入口是兜底通道：默认不可见（防止不耐烦的用户顺手
                点击绕过统一身份认证）；认证失败立即出现，等待满 45s
                也先亮出（不中止等待中的认证） */}
            {manualEntryVisible && (
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
  );
}
