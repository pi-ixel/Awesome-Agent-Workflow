import { readWorkbenchUi, useWorkbenchLayout, useWorkbenchUiValue } from "./bindings/layoutView.ts";
import { useState } from "react";
import logo from "../../../shared/assets/aaw-logo.png";
import { translateWorkbenchSettings } from "./settingsText.ts";
import { btnDanger, btnSecondary, focusVisibleRing } from "../../../shared/ui/controls";
import { useWorkbenchAppearance, useWorkbenchEntries } from "./bindings/react.ts";

/** 「恢复默认设置」的行内确认：取消不动作，确认才写默认值。 */
function ResetConfirm({
  labels,
  onConfirm,
  onCancel,
}: {
  readonly labels: readonly string[];
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <span
      role="alertdialog"
      aria-label="恢复默认设置确认"
      className="flex items-center gap-2 rounded-md border border-line-strong bg-raised px-2 py-1 shadow-elev-2"
    >
      <span className="text-xs text-ink">
        {labels.length > 0 ? `确定将${labels.join("、")}恢复为默认设置？` : "确定恢复默认设置？"}
      </span>
      <button
        type="button"
        onClick={onCancel}
        className={`${btnSecondary} px-2 py-0.5 text-xs`}
      >
        取消
      </button>
      <button
        type="button"
        onClick={onConfirm}
        className={`${btnDanger} px-2 py-0.5 text-xs`}
      >
        恢复默认
      </button>
    </span>
  );
}

function SettingsPage() {
  const initialTab = useWorkbenchUiValue((state) => state.settingsInitialTab);
  return <SettingsContent key={initialTab} initialTab={initialTab} />;
}

function SettingsContent({ initialTab }: { readonly initialTab: string }) {
  const workbenchLayout = useWorkbenchLayout();
  const tabs = [...useWorkbenchEntries("settings")].sort(
    (left, right) => (left.order ?? 100) - (right.order ?? 100),
  );
  const [selectedTab, setActiveTab] = useState(initialTab);
  const activeTab =
    tabs.find((tab) => tab.id === selectedTab)?.id ?? tabs[0]?.id;
  const [isResetConfirmOpen, setResetConfirmOpen] = useState(false);
  const { appearance, preferences: { language } } = useWorkbenchAppearance();
  const settingsReset = useWorkbenchEntries("settingsReset");
  const t = translateWorkbenchSettings(language);

  return (
    <section
      aria-label="设置"
      className="relative flex h-full min-h-0 flex-row bg-sidebar"
    >
      {/* 设置专属侧栏：品牌、返回与圆角导航；窄窗口缩窄侧栏。 */}
      <nav
        aria-label="设置分组"
        className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto px-2 pb-4 max-[880px]:w-52"
      >
        <div
          className="flex h-14 shrink-0 items-center gap-2 px-2"
          data-tauri-drag-region=""
        >
          <img src={logo} alt="AAW" className="size-7" />
        </div>
        <button
          type="button"
          onClick={() => readWorkbenchUi(workbenchLayout).closeOverlay()}
          className={`mb-5 flex h-9 shrink-0 items-center gap-2 rounded-xl bg-ink/80 px-3 text-left text-ui-base leading-6 font-semibold text-base transition-colors hover:bg-ink/90 ${focusVisibleRing}`}
        >
          <svg
            aria-hidden="true"
            className="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m12 5-7 7 7 7M5 12h14" />
          </svg>
          返回工作区
        </button>
        <p className="px-3 pb-1 text-ui-caption text-ink-mute">基础设置</p>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`settings-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`settings-panel-${tab.id}`}
              onClick={() => {
                setActiveTab(tab.id);
              }}
              className={`flex h-8 w-full shrink-0 items-center gap-2 rounded-xl px-3 text-left text-ui-base leading-6 font-normal transition-colors ${
                isActive
                  ? "bg-selected text-ink"
                  : "text-ink-soft hover:bg-surface-hover hover:text-ink"
              } ${focusVisibleRing}`}
            >
              <tab.Icon
                className={`size-4 shrink-0 ${isActive ? "text-ink" : "text-ink-soft"}`}
              />
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* 内容独立滚动；自动保存提示固定在整体右下角。 */}
      <div className="@container/settings my-1 mr-1 min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl border border-line bg-base pb-12 text-ui-base text-ink">
        <div className="mx-auto w-full max-w-[880px] px-6 pt-14 pb-6 max-[880px]:px-4">
          <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {tabs.find((tab) => tab.id === activeTab)?.label}
            </h1>
            {isResetConfirmOpen ? (
              <ResetConfirm
                labels={[
                  ...(appearance ? ["界面语言、主题与字号"] : []),
                  ...settingsReset.map(({ label }) => label),
                ]}
                onConfirm={() => {
                  appearance?.reset();
                  for (const entry of settingsReset) entry.reset();
                  setResetConfirmOpen(false);
                }}
                onCancel={() => {
                  setResetConfirmOpen(false);
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setResetConfirmOpen(true);
                }}
                className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-danger-ink transition-colors hover:bg-danger-bg/60"
              >
                {t("settings.reset")}
              </button>
            )}
          </div>

          {tabs.map((tab) => (
            <div
              key={tab.id}
              id={`settings-panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`settings-tab-${tab.id}`}
              hidden={activeTab !== tab.id}
              className={tab.layoutClass}
            >
              <tab.View />
            </div>
          ))}
        </div>
      </div>
      <p
        role="status"
        className="pointer-events-none absolute bottom-4 right-6 flex items-center gap-2 rounded-md bg-base/90 px-2 py-1 text-xs text-ink-mute"
      >
        <span aria-hidden="true" className="size-1 rounded-full bg-ok-ink" />
        自动保存
      </p>
    </section>
  );
}

export default SettingsPage;
