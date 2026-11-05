import { LegacyAgentDataSection } from "./LegacyAgentDataSection.tsx";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArchiveManagementSection } from "./ArchiveManagementSection.tsx";
import logo from "../assets/aaw-logo.png";
import { version as desktopVersion } from "../../package.json";
import {
  SettingCard,
  SettingRow,
  SegmentedControl,
  settingsInputClass,
} from "./SettingsPageParts";
import { UpdateSettings } from "./DesktopUpdate.tsx";
/**
 * 设置页（侧边 Tab 形态）：三个粗分片——通用（语言 / 主题 / 关于）、
 * Agent、工具路径（uv / aaw 脚本 / skills 源目录 + 内置安装器）、
 * 会话与审批（审批默认模式）。
 *
 * 设计语言（与定稿设计稿一致）：
 * - 左侧竖排 Tab（色块选中态：raised 底 + elev-1，图标使用中性色），
 *   右侧内容列内部滚动；窄容器回落为顶部横排；
 * - 设置行（SettingRow）：左「标题 + 一句说明」右控件，发丝线分行、
 *   控件列宽对齐——扫视视线沿一条直线走，不在上下漂移的标签间找；
 * - 路径类输入等宽字体；iCode 行尾挂状态 chip（版本 / 错误），探测
 *   动作降级为行内文字按钮；审批模式用分段控件 + 说明行（「自动拒绝」
 *   琥珀色警示）；语言仅一项可选时呈静态值，不渲染单选项选单；
 * - 每项变更经 settings / workspace store 的真实 setter 即时持久化
 *   （右下角「自动保存」）；「恢复默认设置」清掉全部本地
 *   配置，走行内二次确认（与关闭会话确认同形态），确认前不写状态。
 */
import { useMemo, useState, type ReactNode } from "react";
import { MAX_UI_FONT_SIZE_PX, MIN_UI_FONT_SIZE_PX } from "../core/uiFontSize";
import {
  themeOptions,
  useSettingsStore,
  type ApprovalMode,
  type DiscoveredAgent,
} from "../stores/settingsStore";
import { createTranslator, languageOptions } from "../core/i18n";
import {
  btnDanger,
  btnSecondary,
  focusVisibleRing,
  ToggleSwitch,
} from "./controls";
import {
  resolveAgentAdapter,
  type CustomAgentEntry,
} from "../agents/registry.ts";
import {
  ArchiveIcon,
  ArrowDownToLineIcon,
  BrainIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  TerminalIcon,
  type IconProps,
} from "./icons";
import { AgentsSettingsSection } from "./AgentsSettings.tsx";
import { useWorkbenchUiStore } from "../stores/workbenchUiStore";
import { useToolPathSettings } from "./workspaces/settingsLinks";
import SkillsInstallerSection from "./SkillsInstallerSection";

/** 路径 / 命令类输入：等宽字体（路径里的大小写与分隔符要逐字可读）。 */
const textInputClass = `${settingsInputClass} font-mono`;

/** 「恢复默认设置」的行内确认：取消不动作，确认才写默认值。 */
function ResetConfirm({
  onConfirm,
  onCancel,
}: {
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
        将清除 iCode 路径、Agent 选择与自定义 Agent、uv / aaw 路径、审批
        模式、语言、主题与 skills 源目录，确认？
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

/**
 * 界面字号数字输入（复刻 ZCode 的 FontSizeInput）：草稿态编辑,失焦 /
 * 回车提交,取整夹取 12–20;非法输入回落当前值。
 */
function FontSizeInput({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (px: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = (): void => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    const next = Number.isFinite(parsed)
      ? Math.min(
          MAX_UI_FONT_SIZE_PX,
          Math.max(MIN_UI_FONT_SIZE_PX, Math.round(parsed)),
        )
      : value;
    setDraft(String(next));
    if (next !== value) {
      onChange(next);
    }
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      min={MIN_UI_FONT_SIZE_PX}
      max={MAX_UI_FONT_SIZE_PX}
      step={1}
      value={draft}
      aria-label="界面字号"
      onChange={(event) => {
        setDraft(event.currentTarget.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      className="w-20 rounded-md border border-line-strong bg-surface px-2 py-1 text-center text-sm text-ink outline-none transition-colors focus:border-ink-faint"
    />
  );
}

/** 关于块的键值行。 */
function AboutRow({ k, v }: { readonly k: string; readonly v: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-3 first:border-t-0">
      <span className="text-ui-base font-medium text-ink">{k}</span>
      <span className="text-ui-base text-ink-mute">{v}</span>
    </div>
  );
}

type SettingsTabId =
  "general" | "updates" | "agents" | "tools" | "session" | "archive";

// 外部设置入口指定初始页签；诊断使用独立窗口入口。
let settingsInitialTab: SettingsTabId = "general";

export function openSettingsOverlayTab(tab: SettingsTabId): void {
  settingsInitialTab = tab;
  useWorkbenchUiStore.getState().toggleOverlay("settings");
}

/** Tab 定义（图标组件随 Tab 走，导航渲染用）。 */
const TABS: readonly {
  readonly id: SettingsTabId;
  readonly label: string;
  readonly Icon: (props: IconProps) => ReactNode;
}[] = [
  { id: "general", label: "通用", Icon: SlidersHorizontalIcon },
  { id: "updates", label: "更新", Icon: ArrowDownToLineIcon },
  { id: "agents", label: "Agent", Icon: BrainIcon },
  { id: "tools", label: "工具路径", Icon: TerminalIcon },
  { id: "session", label: "会话与审批", Icon: ShieldCheckIcon },
  { id: "archive", label: "归档管理", Icon: ArchiveIcon },
];

/** 审批模式分段选项（短标签；完整语义在行 footer 的说明里）。 */
const APPROVAL_SEGMENTS = [
  { value: "ask" as const, label: "手动确认" },
  { value: "auto-allow" as const, label: "自动放行" },
];

/** 审批模式选中项的说明行（含风险提示）。 */
const APPROVAL_DESCRIPTIONS: Readonly<Record<ApprovalMode, string>> = {
  ask: "手动确认 — 每次敏感操作前询问。",
  "auto-allow": "自动放行 — 自动允许操作；无可用允许选项时仍会询问。",
};

/** 「关于」行使用当前适配器的展示名。 */
function agentAboutLabel(
  activeAgentId: string,
  agents: readonly CustomAgentEntry[],
  discoveredAgents: readonly DiscoveredAgent[],
): string {
  const resolved = resolveAgentAdapter(activeAgentId, agents, discoveredAgents);
  if (resolved === null) return activeAgentId;
  return resolved.adapter.displayName;
}

function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(settingsInitialTab);
  const [isResetConfirmOpen, setResetConfirmOpen] = useState(false);
  const approvalMode = useSettingsStore((state) => state.approvalMode);
  const language = useSettingsStore((state) => state.language);
  const skillsSourceDir = useSettingsStore((state) => state.skillsSourceDir);
  const theme = useSettingsStore((state) => state.theme);
  const setApprovalMode = useSettingsStore((state) => state.setApprovalMode);
  const autoAnswerQuestions = useSettingsStore(
    (state) => state.autoAnswerQuestions,
  );
  const setAutoAnswerQuestions = useSettingsStore(
    (state) => state.setAutoAnswerQuestions,
  );
  const setLanguage = useSettingsStore((state) => state.setLanguage);
  const setSkillsSourceDir = useSettingsStore(
    (state) => state.setSkillsSourceDir,
  );
  const setTheme = useSettingsStore((state) => state.setTheme);
  const uiFontSize = useSettingsStore((state) => state.uiFontSize);
  const setUiFontSize = useSettingsStore((state) => state.setUiFontSize);
  const messageStreamShowTodos = useSettingsStore(
    (state) => state.messageStreamShowTodos,
  );
  const setMessageStreamShowTodos = useSettingsStore(
    (state) => state.setMessageStreamShowTodos,
  );
  const sessionAutoArchiveEnabled = useSettingsStore(
    (state) => state.sessionAutoArchiveEnabled,
  );
  const sessionAutoArchiveOlderThanDays = useSettingsStore(
    (state) => state.sessionAutoArchiveOlderThanDays,
  );
  const setSessionAutoArchive = useSettingsStore(
    (state) => state.setSessionAutoArchive,
  );
  const resetToDefaults = useSettingsStore((state) => state.resetToDefaults);
  const activeAgentId = useSettingsStore((state) => state.activeAgentId);
  const agents = useSettingsStore((state) => state.agents);
  const discoveredAgents = useSettingsStore((state) => state.discoveredAgents);
  const toolPaths = useToolPathSettings();

  const t = useMemo(() => createTranslator(language), [language]);

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
          onClick={() => useWorkbenchUiStore.getState().closeOverlay()}
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
        {TABS.map((tab) => {
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
              {TABS.find((tab) => tab.id === activeTab)?.label}
            </h1>
            {isResetConfirmOpen ? (
              <ResetConfirm
                onConfirm={() => {
                  resetToDefaults();
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

          {/* —— Tab 1：通用（语言 / 主题 / 关于） —— */}
          <div
            id="settings-panel-general"
            role="tabpanel"
            aria-labelledby="settings-tab-general"
            hidden={activeTab !== "general"}
            className="flex flex-col gap-5"
          >
            <SettingCard label="基础偏好">
              <SettingRow
                label={t("settings.languageSection")}
                desc="用于菜单和提示"
              >
                {languageOptions.length > 1 ? (
                  <SegmentedControl
                    groupLabel={t("settings.languageSection")}
                    value={language}
                    options={languageOptions.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                    onChange={setLanguage}
                  />
                ) : (
                  // 只有一项可选（English 预留未下发）：呈静态值，不渲染
                  // 单选项选单——看得见却只有一个方向的选择器是伪控件
                  <span className="inline-flex min-h-8 items-center rounded-md bg-surface px-3 py-1 text-ui-base font-medium text-ink-mute">
                    {languageOptions[0]?.label ?? "中文"}
                  </span>
                )}
              </SettingRow>
              <SettingRow label="主题" desc="选择深色或浅色外观">
                <SegmentedControl
                  groupLabel="外观主题"
                  value={theme}
                  options={themeOptions}
                  onChange={setTheme}
                />
              </SettingRow>
              <SettingRow label="界面字号" desc="调整文字大小（12–20px）">
                <FontSizeInput value={uiFontSize} onChange={setUiFontSize} />
              </SettingRow>
            </SettingCard>

            <SettingCard label="关于">
              <AboutRow k="版本" v={desktopVersion} />
              <AboutRow
                k="仓库"
                v={
                  <button
                    type="button"
                    className="text-info-ink hover:underline"
                    onClick={() => {
                      void openUrl(
                        "https://github.com/pi-ixel/Awesome-Agent-Workflow",
                      ).catch(() =>
                        window.open(
                          "https://github.com/pi-ixel/Awesome-Agent-Workflow",
                          "_blank",
                          "noopener,noreferrer",
                        ),
                      );
                    }}
                  >
                    Awesome-Agent-Workflow
                  </button>
                }
              />
              <AboutRow
                k="agent"
                v={agentAboutLabel(activeAgentId, agents, discoveredAgents)}
              />
            </SettingCard>
          </div>

          <div
            id="settings-panel-updates"
            role="tabpanel"
            aria-labelledby="settings-tab-updates"
            hidden={activeTab !== "updates"}
          >
            <UpdateSettings />
          </div>

          {/* —— Tab 2：Agent（多 agent 管理：切换 / 发现 / 自定义 / 协议自检） —— */}
          <div
            id="settings-panel-agents"
            role="tabpanel"
            aria-labelledby="settings-tab-agents"
            hidden={activeTab !== "agents"}
          >
            <AgentsSettingsSection />
          </div>

          {/* —— Tab 3：工具路径 —— */}
          <div
            id="settings-panel-tools"
            role="tabpanel"
            aria-labelledby="settings-tab-tools"
            hidden={activeTab !== "tools"}
            className="flex flex-col gap-5"
          >
            <SettingCard label={t("settings.toolPathsSection")}>
              <SettingRow
                label="uv 命令"
                desc="执行 aaw CLI 与工作流脚本的解释器命令（可写绝对路径）"
                htmlFor="uv-command"
              >
                <input
                  id="uv-command"
                  type="text"
                  value={toolPaths.uvCommand}
                  onChange={(event) => {
                    toolPaths.setUvCommand(event.target.value);
                  }}
                  placeholder="uv"
                  className={textInputClass}
                />
              </SettingRow>

              <SettingRow
                label="aaw 脚本路径"
                desc="留空则按下方 skills 源目录推导"
                htmlFor="aaw-script"
              >
                <input
                  id="aaw-script"
                  type="text"
                  value={toolPaths.aawScriptPath}
                  onChange={(event) => {
                    toolPaths.setAawScriptPath(event.target.value);
                  }}
                  placeholder="skills/aaw-workflow/scripts/aaw.py"
                  className={textInputClass}
                />
              </SettingRow>

              <SettingRow
                label={t("settings.skillsSourceSection")}
                desc={t("settings.skillsSourceHint")}
                htmlFor="skills-source"
              >
                <input
                  id="skills-source"
                  type="text"
                  value={skillsSourceDir}
                  onChange={(event) => {
                    setSkillsSourceDir(event.target.value);
                  }}
                  className={textInputClass}
                />
              </SettingRow>
            </SettingCard>

            <SkillsInstallerSection />
          </div>

          {/* —— Tab 4：会话与审批 —— */}
          <div
            id="settings-panel-session"
            role="tabpanel"
            aria-labelledby="settings-tab-session"
            hidden={activeTab !== "session"}
            className="flex flex-col gap-5"
          >
            <SettingCard label="会话策略">
              <SettingRow
                label="在消息流中显示任务步骤"
                desc="显示 Agent 的任务进度"
              >
                <ToggleSwitch
                  appearance="neutral"
                  label="在消息流中显示任务步骤"
                  checked={messageStreamShowTodos}
                  onChange={setMessageStreamShowTodos}
                />
              </SettingRow>
              <SettingRow
                label={t("settings.approvalSection")}
                desc="敏感操作的确认方式"
                footer={
                  <p className="text-ui-caption leading-relaxed text-ink-mute">
                    {APPROVAL_DESCRIPTIONS[approvalMode]}
                  </p>
                }
                footerAlign="start"
              >
                <SegmentedControl
                  groupLabel={t("settings.approvalSection")}
                  value={approvalMode}
                  options={APPROVAL_SEGMENTS}
                  onChange={setApprovalMode}
                />
              </SettingRow>
              <SettingRow
                label="问答自动应答"
                desc="60 秒未作答时，自动选择每题的第一项"
                footer={
                  <p className="text-ui-caption leading-relaxed text-ink-mute">
                    {autoAnswerQuestions
                      ? "悬停或开始作答即可取消本次自动应答。"
                      : "自动选择可能不符合你的意图，请谨慎开启。"}
                  </p>
                }
                footerAlign="start"
              >
                <ToggleSwitch
                  appearance="neutral"
                  label="问答自动应答"
                  checked={autoAnswerQuestions}
                  onChange={setAutoAnswerQuestions}
                />
              </SettingRow>
            </SettingCard>
          </div>

          {/* —— Tab 5：归档管理（自动归档策略 + 本机归档覆盖层） —— */}
          <div
            id="settings-panel-archive"
            role="tabpanel"
            aria-labelledby="settings-tab-archive"
            hidden={activeTab !== "archive"}
            className="flex flex-col gap-5"
          >
            <SettingCard label="自动归档">
              <SettingRow
                label="自动归档闲置会话"
                desc="每 5 分钟扫描一次；正在运行、置顶与无时间记录的会话不会被归档"
                footer={
                  <p className="text-ui-caption leading-relaxed text-ink-mute">
                    {sessionAutoArchiveEnabled
                      ? `已开启：闲置超过 ${sessionAutoArchiveOlderThanDays} 天的会话自动收进下方归档列表。`
                      : "默认关闭——静默收起历史会话必须由用户显式开启。归档只是从侧栏列表收起，不删除任何数据。"}
                  </p>
                }
                footerAlign="start"
              >
                <ToggleSwitch
                  appearance="neutral"
                  label="自动归档闲置会话"
                  checked={sessionAutoArchiveEnabled}
                  onChange={(enabled) => setSessionAutoArchive(enabled)}
                />
              </SettingRow>
              <SettingRow
                label="闲置天数阈值"
                desc="会话最近活跃时间早于该天数即视为闲置（1–365）"
              >
                <ArchiveDaysInput
                  value={sessionAutoArchiveOlderThanDays}
                  onChange={(days) => {
                    setSessionAutoArchive(sessionAutoArchiveEnabled, days);
                  }}
                />
              </SettingRow>
            </SettingCard>
            <ArchiveManagementSection />
            <LegacyAgentDataSection />
          </div>
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

/** 自动归档天数输入（1–365，失焦/回车提交；非法回落现值）。 */
function ArchiveDaysInput({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (days: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = (): void => {
    const parsed = Number(draft);
    const next = Number.isFinite(parsed)
      ? Math.min(365, Math.max(1, Math.floor(parsed)))
      : value;
    setDraft(String(next));
    if (next !== value) {
      onChange(next);
    }
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      min={1}
      max={365}
      step={1}
      value={draft}
      aria-label="自动归档闲置天数"
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        }
      }}
      className="w-20 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info"
    />
  );
}

export default SettingsPage;
