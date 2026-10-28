/**
 * 设置页（侧边 Tab 形态）：三个粗分片——通用（语言 / 主题 / 关于）、
 * 工具路径（iCode / uv / aaw 脚本 / skills 源目录 + 内置安装器）、
 * 会话与审批（审批默认模式）。
 *
 * 设计语言（与定稿设计稿一致）：
 * - 左侧竖排 Tab（色块选中态：raised 底 + elev-1，图标转 info 色），
 *   右侧内容列内部滚动；窄容器回落为顶部横排；
 * - 设置行（SettingRow）：左「标题 + 一句说明」右控件，发丝线分行、
 *   控件列宽对齐——扫视视线沿一条直线走，不在上下漂移的标签间找；
 * - 路径类输入等宽字体；iCode 行尾挂状态 chip（版本 / 错误），探测
 *   动作降级为行内文字按钮；审批模式用分段控件 + 说明行（「自动拒绝」
 *   琥珀色警示）；语言仅一项可选时呈静态值，不渲染单选项选单；
 * - 每项变更经 settings / workspace store 的真实 setter 即时持久化
 *   （页头「修改即时生效，自动保存」）；「恢复默认设置」清掉全部本地
 *   配置，走行内二次确认（与关闭会话确认同形态），确认前不写状态。
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  MAX_UI_FONT_SIZE_PX,
  MIN_UI_FONT_SIZE_PX,
} from "../core/uiFontSize";
import {
  themeOptions,
  useSettingsStore,
  type ApprovalMode,
} from "../stores/settingsStore";
import { createTranslator, languageOptions } from "../core/i18n";
import { btnDanger, btnSecondary, focusVisibleRing } from "./controls";
import {
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  TerminalIcon,
  type IconProps,
} from "./icons";
import { useToolPathSettings } from "./workspaces/settingsLinks";
import SkillsInstallerSection from "./SkillsInstallerSection";

/** 路径 / 命令类输入：等宽字体（路径里的大小写与分隔符要逐字可读）。 */
const textInputClass =
  "h-8 w-full min-w-0 rounded-lg border border-line-strong bg-base px-2.5 font-mono text-xs text-ink placeholder:text-ink-ghost focus:border-sky-500/60 focus:shadow-[0_0_0_1px_rgb(14_165_233/0.25)] focus:outline-none";

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
        将清除 iCode 路径、uv / aaw 路径、审批模式、语言、主题与 skills
        源目录，确认？
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
      ? Math.min(MAX_UI_FONT_SIZE_PX, Math.max(MIN_UI_FONT_SIZE_PX, Math.round(parsed)))
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

/** 设置卡：区块容器（行由 SettingRow 组成，卡内发丝线分行）。 */
function SettingCard({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      aria-label={label}
      className="overflow-hidden rounded-xl border border-line bg-surface shadow-elev-1"
    >
      {children}
    </div>
  );
}

/** 设置行：左「标题 + 说明」右控件；footer 承接状态行 / 推导提示等
 * 附属信息（占整行宽，视觉上仍是本行的一部分）。 */
function SettingRow({
  label,
  desc,
  htmlFor,
  footer,
  footerAlign = "end",
  children,
}: {
  readonly label: string;
  readonly desc?: string;
  /** 可聚焦控件（input）的关联 id；纯展示行省略。 */
  readonly htmlFor?: string;
  readonly footer?: ReactNode;
  readonly footerAlign?: "start" | "end";
  readonly children?: ReactNode;
}) {
  return (
    <div className="border-t border-line px-5 py-3.5 first:border-t-0">
      <div className="grid grid-cols-1 items-center gap-2.5 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(240px,320px)] sm:gap-5">
        <div className="min-w-0">
          {htmlFor !== undefined ? (
            <label
              htmlFor={htmlFor}
              className="block text-md font-medium text-ink"
            >
              {label}
            </label>
          ) : (
            <span className="block text-md font-medium text-ink">{label}</span>
          )}
          {desc !== undefined && desc.length > 0 ? (
            <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
              {desc}
            </p>
          ) : null}
        </div>
        {children !== undefined ? (
          <div className="flex min-w-0 items-center justify-start gap-2 sm:justify-end">
            {children}
          </div>
        ) : null}
      </div>
      {footer !== undefined ? (
        <div
          className={`mt-2 flex ${footerAlign === "end" ? "justify-end" : "justify-start"}`}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/** 分段控件（语言 / 主题 / 审批模式共用）：胶囊组，选中 raised 底。 */
function SegmentedControl<T extends string>({
  groupLabel,
  value,
  options,
  onChange,
  warnValue,
}: {
  readonly groupLabel: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (next: T) => void;
  /** 选中时以琥珀警示呈现的选项值（如「自动拒绝」）。 */
  readonly warnValue?: T;
}) {
  return (
    <div
      role="group"
      aria-label={groupLabel}
      className="inline-flex shrink-0 gap-0.5 rounded-lg border border-line-strong bg-base p-0.5"
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        const isWarn = isSelected && option.value === warnValue;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isSelected}
            onClick={() => {
              onChange(option.value);
            }}
            className={`press shrink-0 rounded-md px-3 py-1 text-xs transition-colors ${
              isWarn
                ? "bg-warn-bg/70 text-warn-ink"
                : isSelected
                  ? "bg-raised text-ink shadow-elev-1"
                  : "text-ink-mute hover:text-ink-soft"
            } ${focusVisibleRing}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 状态 chip：iCode 探测结论等一行级状态的容器。 */
function StatusChip({
  tone,
  title,
  children,
}: {
  readonly tone: "ok" | "idle" | "danger";
  readonly title?: string;
  readonly children: ReactNode;
}) {
  const toneClass = {
    ok: "border-ok-line bg-ok-bg/70 text-ok-ink",
    idle: "border-line-strong bg-raised text-ink-faint",
    danger: "border-danger-line bg-danger-bg/70 text-danger-ink",
  }[tone];
  return (
    <span
      title={title}
      className={`inline-flex max-w-56 shrink-0 items-center gap-1.5 truncate rounded-full border px-2.5 py-0.5 text-2xs ${toneClass}`}
    >
      <span
        aria-hidden={true}
        className="size-1 shrink-0 rounded-full bg-current"
      />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** 关于块的键值行。 */
function AboutRow({ k, v }: { readonly k: string; readonly v: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-t border-line px-5 py-2.5 first:border-t-0">
      <span className="text-md font-medium text-ink">{k}</span>
      <span className="font-mono text-xs text-ink-mute">{v}</span>
    </div>
  );
}

type SettingsTabId = "general" | "tools" | "session";

/** Tab 定义（图标组件随 Tab 走，导航渲染用）。 */
const TABS: readonly {
  readonly id: SettingsTabId;
  readonly label: string;
  readonly Icon: (props: IconProps) => ReactNode;
}[] = [
  { id: "general", label: "通用", Icon: SlidersHorizontalIcon },
  { id: "tools", label: "工具路径", Icon: TerminalIcon },
  { id: "session", label: "会话与审批", Icon: ShieldCheckIcon },
];

/** 审批模式分段选项（短标签；完整语义在行 footer 的说明里）。 */
const APPROVAL_SEGMENTS = [
  { value: "ask" as const, label: "手动确认" },
  { value: "auto-allow" as const, label: "自动放行" },
];

/** 审批模式选中项的说明行（含风险提示）。 */
const APPROVAL_DESCRIPTIONS: Readonly<Record<ApprovalMode, string>> = {
  ask: "手动确认 — 每个敏感工具调用都弹出审批，由你逐条决定。",
  "auto-allow":
    "自动放行 — 工具权限请求自动按「允许」应答（先「仅本次」后「始终」）；agent 未提供允许选项时仍会弹窗询问。",
};

function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");
  const [isResetConfirmOpen, setResetConfirmOpen] = useState(false);
  const approvalMode = useSettingsStore((state) => state.approvalMode);
  const language = useSettingsStore((state) => state.language);
  const skillsSourceDir = useSettingsStore((state) => state.skillsSourceDir);
  const theme = useSettingsStore((state) => state.theme);
  const connection = useSettingsStore((state) => state.connection);
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
  const testConnection = useSettingsStore((state) => state.testConnection);
  const isProbingPath = useSettingsStore((state) => state.isProbingChrysPath);
  const reprobePath = useSettingsStore((state) => state.probeChrysPathIfNeeded);
  const resetToDefaults = useSettingsStore((state) => state.resetToDefaults);
  const toolPaths = useToolPathSettings();

  const t = useMemo(() => createTranslator(language), [language]);

  return (
    <section
      aria-label="设置"
      className="flex h-full min-h-0 flex-row max-[880px]:flex-col"
    >
      {/* 侧边 Tab：色块选中态（raised 底 + elev-1 + 图标转 info 色）；
          窄容器回落为顶部横排 */}
      <nav
        aria-label="设置分组"
        className="flex w-[198px] shrink-0 flex-col gap-0.5 border-r border-line bg-base p-2.5 max-[880px]:w-full max-[880px]:flex-row max-[880px]:overflow-x-auto max-[880px]:border-r-0 max-[880px]:border-b"
      >
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
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-md transition-colors max-[880px]:w-auto max-[880px]:whitespace-nowrap ${
                isActive
                  ? "bg-raised text-ink shadow-elev-1"
                  : "text-ink-mute hover:bg-raised/60 hover:text-ink-soft"
              } ${focusVisibleRing}`}
            >
              <tab.Icon
                className={`h-3.5 w-3.5 shrink-0 ${isActive ? "text-info-ink" : "text-ink-faint"}`}
              />
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* 内容列：页头（自动保存说明 + 恢复默认）+ 三个 Tab 面板 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 py-7 max-[880px]:px-4 max-[880px]:py-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-xs text-ink-faint">
              <span
                aria-hidden={true}
                className="size-1 rounded-full bg-ok-ink"
              />
              修改即时生效，自动保存
            </p>
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
                className="rounded-lg border border-danger-line px-3 py-1 text-xs text-danger-ink transition-colors hover:bg-danger-bg/60"
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
                desc="影响菜单与提示文案；会话内容不受影响"
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
                  <StatusChip tone="idle">
                    {languageOptions[0]?.label ?? "中文"}
                  </StatusChip>
                )}
              </SettingRow>
              <SettingRow
                label="主题"
                desc="暗夜为默认深色界面；暖白为米白浅色界面"
              >
                <SegmentedControl
                  groupLabel="外观主题"
                  value={theme}
                  options={themeOptions}
                  onChange={setTheme}
                />
              </SettingRow>
              <SettingRow
                label="界面字号"
                desc="全站文字大小（12–20px），图标与间距不跟随缩放"
              >
                <FontSizeInput value={uiFontSize} onChange={setUiFontSize} />
              </SettingRow>
            </SettingCard>

            <SettingCard label="关于">
              <AboutRow k="版本" v="0.1.0" />
              <AboutRow
                k="仓库"
                v={
                  <span className="text-info-ink">Awesome-Agent-Workflow</span>
                }
              />
              <AboutRow k="agent" v="iCode（chrys 协议）" />
            </SettingCard>
          </div>

          {/* —— Tab 2：工具路径 —— */}
          <div
            id="settings-panel-tools"
            role="tabpanel"
            aria-labelledby="settings-tab-tools"
            hidden={activeTab !== "tools"}
            className="flex flex-col gap-5"
          >
            <SettingCard label={t("settings.toolPathsSection")}>
              <SettingRow
                label={t("settings.chrysSection")}
                desc="ACP 会话的 agent 进程"
                htmlFor="chrys-path"
                footer={
                  <>
                    {toolPaths.chrysPath.trim() === "" ? (
                      <p role="alert" className="text-xs text-warn-ink">
                        未找到 iCode，请手动指定路径
                      </p>
                    ) : null}
                    {connection.status !== "idle" ? (
                      <p
                        role="status"
                        className={`text-xs ${
                          connection.status === "ok"
                            ? "text-ok-ink"
                            : connection.status === "testing"
                              ? "text-ink-faint"
                              : "text-danger-ink"
                        }`}
                      >
                        {connection.message}
                        {connection.checkedAt === null
                          ? ""
                          : ` · ${connection.checkedAt.slice(11, 19)}`}
                      </p>
                    ) : null}
                  </>
                }
              >
                <input
                  id="chrys-path"
                  type="text"
                  value={toolPaths.chrysPath}
                  onChange={(event) => {
                    toolPaths.setChrysPath(event.target.value);
                  }}
                  className={textInputClass}
                />
                <button
                  type="button"
                  disabled={isProbingPath}
                  onClick={() => {
                    void reprobePath(true);
                  }}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-info-ink disabled:opacity-50"
                >
                  {isProbingPath ? "正在检测…" : "重新检测路径"}
                </button>
                {connection.status === "ok" ? (
                  <StatusChip tone="ok" title={connection.message}>
                    已连接
                  </StatusChip>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    void testConnection();
                  }}
                  disabled={connection.status === "testing"}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-info-ink transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {connection.status === "testing"
                    ? t("settings.testing")
                    : t("settings.testConnection")}
                </button>
              </SettingRow>

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

          {/* —— Tab 3：会话与审批 —— */}
          <div
            id="settings-panel-session"
            role="tabpanel"
            aria-labelledby="settings-tab-session"
            hidden={activeTab !== "session"}
            className="flex flex-col gap-5"
          >
            <SettingCard label="会话策略">
              <SettingRow
                label={t("settings.approvalSection")}
                desc="agent 执行敏感工具前的确认策略"
                footer={
                  <p className="text-xs leading-relaxed text-ink-faint">
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
                desc="结构化提问挂起 60 秒无交互，自动提交每题的第一个选项"
                footer={
                  <p className="text-xs leading-relaxed text-ink-faint">
                    {autoAnswerQuestions
                      ? "已开启：面板中悬停或开始作答即取消本次自动应答。"
                      : "默认关闭——自动选择有误操作风险，开启是显式决定。"}
                  </p>
                }
                footerAlign="start"
              >
                <SegmentedControl
                  groupLabel="问答自动应答"
                  value={autoAnswerQuestions ? "on" : "off"}
                  options={[
                    { value: "off", label: "关闭" },
                    { value: "on", label: "开启" },
                  ]}
                  onChange={(value) => {
                    setAutoAnswerQuestions(value === "on");
                  }}
                />
              </SettingRow>
            </SettingCard>
          </div>
        </div>
      </div>
    </section>
  );
}

export default SettingsPage;
