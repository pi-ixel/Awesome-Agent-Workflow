import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { UiIcon } from "../../../shared/ui/UiIcon.tsx";
import { DangerButton } from "../../../shared/ui/controls.tsx";
import {
  readWorkbenchUi,
  useWorkbenchLayout,
  useWorkbenchUiValue,
} from "./bindings/layoutView.ts";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { nativeConfigurationStatus } from "../../host/service.ts";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { translateWorkbenchSettings } from "./settingsText.ts";
import { focusVisibleRing } from "../../../shared/ui/controls";
import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import {
  useWorkbenchAppearance,
  useWorkbenchEntries,
} from "./bindings/react.ts";

const settingsGroups = [
  { id: "basic", label: "基础设置" },
  { id: "agent", label: "Agent能力" },
  { id: "data", label: "数据与统计" },
] as const;

const settingsGroupByTab: Readonly<
  Partial<Record<string, (typeof settingsGroups)[number]["id"]>>
> = {
  agents: "agent",
  tools: "agent",
  session: "agent",
  storage: "data",
  "usage-statistics": "data",
  archive: "data",
};

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
    <ConfirmationDialog
      role="alertdialog"
      label="恢复默认设置确认"
      title="恢复默认设置？"
      confirmLabel="恢复默认"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p>
        {labels.length > 0
          ? `这会将${labels.join("、")}恢复为默认设置。`
          : "这会将当前配置恢复为默认设置。"}
      </p>
    </ConfirmationDialog>
  );
}

function SettingsPage() {
  const initialTab = useWorkbenchUiValue((state) => state.settingsInitialTab);
  const workbenchLayout = useWorkbenchLayout();
  return (
    <ModalShell
      label="设置"
      size="settings"
      onDismiss={() => readWorkbenchUi(workbenchLayout).closeOverlay()}
    >
      <SettingsContent key={initialTab} initialTab={initialTab} />
    </ModalShell>
  );
}

function SettingsContent({ initialTab }: { readonly initialTab: string }) {
  const workbenchLayout = useWorkbenchLayout();
  const tabs = [...useWorkbenchEntries("settings")].sort(
    (left, right) => (left.order ?? 100) - (right.order ?? 100),
  );
  const [selectedTab, setActiveTab] = useState(initialTab);
  const activeEntry = tabs.find((tab) => tab.id === selectedTab) ?? tabs[0];
  const activeTab = activeEntry?.id;
  const HeaderAction = activeEntry?.HeaderAction;
  const [isResetConfirmOpen, setResetConfirmOpen] = useState(false);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const focusRequest = useWorkbenchUiValue((state) => state.settingsFocus);
  const handledFocus = useRef<typeof focusRequest>(null);
  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest) return;
    const row = document.getElementById(focusRequest.elementId);
    if (!row || !contentRef.current?.contains(row) || row.closest("[hidden]")) return;
    handledFocus.current = focusRequest;
    const control = row.querySelector<HTMLElement>('button[aria-pressed="true"], input, select');
    control?.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest" });
  }, [activeTab, focusRequest]);
  const dismissReset = () => {
    setResetConfirmOpen(false);
    requestAnimationFrame(() => resetTrigger.current?.focus());
  };
  const {
    appearance,
    preferences: { language },
  } = useWorkbenchAppearance();
  const settingsReset = useWorkbenchEntries("settingsReset");
  const t = translateWorkbenchSettings(language);
  const storage = useStore(nativeConfigurationStatus);

  return (
    <>
      <header className="flex h-16 shrink-0 items-center justify-between px-6">
        <h2 className="text-ui-base font-semibold text-ink">设置</h2>
        <div
          role="group"
          aria-label="设置操作"
          inert={isResetConfirmOpen}
          className="ml-auto mr-3 flex flex-wrap items-center justify-end gap-3"
        >
          <h1 className="sr-only">{activeEntry?.label}</h1>
          {activeTab !== "usage-statistics" && (
            <DangerButton
              ref={resetTrigger}
              type="button"
              onClick={() => setResetConfirmOpen(true)}
              className="px-3 py-1.5 text-sm"
            >
              {t("settings.reset")}
            </DangerButton>
          )}
          {HeaderAction && <HeaderAction />}
        </div>
        <IconButton iconSize="dialog"
          type="button"
          aria-label="关闭设置"
          data-hint="关闭设置"
          onClick={() => readWorkbenchUi(workbenchLayout).closeOverlay()}
          className={`flex items-center justify-center rounded-lg hover:bg-surface-hover ${focusVisibleRing}`}
        >
          <UiIcon
            className="ui-icon-16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </UiIcon>
        </IconButton>
      </header>
      <section className="relative flex min-h-0 flex-1 flex-row max-[560px]:flex-col">
        {/* 设置导航独立滚动；窄窗口改为上下布局，留足内容宽度。 */}
        <nav
          aria-label="设置分组"
          inert={isResetConfirmOpen}
          className="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto px-3 pb-4 max-[700px]:w-40 max-[560px]:max-h-36 max-[560px]:w-full"
        >
          <div
            role="tablist"
            aria-label="设置页签"
            aria-orientation="vertical"
            className="flex flex-col gap-5"
          >
            {settingsGroups.map(({ id, label }) => {
              const groupTabs = tabs.filter(
                (tab) => (tab.group ?? settingsGroupByTab[tab.id] ?? "basic") === id,
              );
              if (!groupTabs.length) return null;
              return (
                <div
                  key={id}
                  role="group"
                  aria-labelledby={`settings-group-${id}`}
                  className="flex flex-col gap-1"
                >
                  <p
                    id={`settings-group-${id}`}
                    className="px-3 pb-1 text-ui-caption text-ink-mute"
                  >
                    {label}
                  </p>
                  {groupTabs.map((tab) => {
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
                          if (contentRef.current)
                            contentRef.current.scrollTop = 0;
                        }}
                        className={`flex min-h-8 w-full shrink-0 items-center gap-2 rounded-xl px-3 text-left text-ui-base leading-6 font-normal transition-colors ${
                          isActive
                            ? "bg-selected text-ink"
                            : "text-ink-soft hover:bg-surface-hover hover:text-ink"
                        } ${focusVisibleRing}`}
                      >
                        <tab.Icon
                          className={`ui-icon-16 shrink-0 ${isActive ? "text-ink" : "text-ink-soft"}`}
                        />
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </nav>

        {/* 内容独立滚动；自动保存提示固定在整体右下角。 */}
        <div
          ref={contentRef}
          inert={isResetConfirmOpen}
          className="@container/settings min-h-0 min-w-0 flex-1 overflow-auto bg-surface pb-12 text-ui-base text-ink"
        >
          <div className="mx-auto w-full max-w-[880px] px-6 pb-6 max-[880px]:px-4">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                id={`settings-panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`settings-tab-${tab.id}`}
                hidden={activeTab !== tab.id}
                className={tab.layoutClass}
              >
                <tab.View active={activeTab === tab.id} />
              </div>
            ))}
          </div>
        </div>
        <p
          role="status"
          className="pointer-events-none absolute bottom-4 right-6 flex items-center gap-2 rounded-md bg-base/90 px-2 py-1 text-xs text-ink-mute"
        >
          <span aria-hidden="true" className="size-1 rounded-full bg-ok-ink" />
          {storage.saving
            ? "正在保存…"
            : storage.error
              ? "有未保存的配置"
              : "自动保存"}
        </p>
        {isResetConfirmOpen && (
          <ResetConfirm
            labels={[
              ...(appearance ? ["界面语言、主题、字号和文件树位置"] : []),
              ...settingsReset.map(({ label }) => label),
            ]}
            onConfirm={() => {
              appearance?.reset();
              for (const entry of settingsReset) entry.reset();
              dismissReset();
            }}
            onCancel={dismissReset}
          />
        )}
      </section>
    </>
  );
}

export default SettingsPage;
