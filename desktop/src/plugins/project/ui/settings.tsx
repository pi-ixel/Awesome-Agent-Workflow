import { useState, type ComponentType } from "react";
import type { WorkbenchContributions } from "../../workbench/types.ts";
import type { SkillsSettingsView } from "../../skills/types.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import type { ApprovalMode } from "../types.ts";
import { useProjectPreferences } from "./preferencesView.tsx";
import { createTranslator } from "../../../shared/i18n.ts";
import { useWorkbenchLanguage } from "../../workbench/service.ts";
import {
  SegmentedControl,
  SettingCard,
  SettingRow,
  settingsInputClass,
} from "../../../shared/ui/SettingsPageParts.tsx";
import { ToggleSwitch } from "../../../shared/ui/controls.tsx";
import { ArchiveIcon, ShieldCheckIcon, TerminalIcon } from "../../../shared/ui/icons.tsx";
import { LegacyAgentDataSection } from "./LegacyAgentDataSection.tsx";
import { useToolPathSettings } from "./workspaces/settingsLinks.ts";
import { ArchiveManagementSection } from "./ArchiveManagementSection.tsx";

const settingsText = {
  "settings.approvalSection": "审批默认模式",
  "settings.toolPathsSection": "工具路径",
};

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

function SessionSettings() {
  const language = useWorkbenchLanguage();
  const {
    preferences,
    values: { approvalMode, autoAnswerQuestions, messageStreamShowTodos },
  } = useProjectPreferences();
  const t = createTranslator(language, settingsText);
  return (
    <>
      <SettingCard label="会话策略">
        <SettingRow label="在消息流中显示任务步骤" desc="显示 Agent 的任务进度">
          <ToggleSwitch
            appearance="neutral"
            label="在消息流中显示任务步骤"
            checked={messageStreamShowTodos}
            onChange={(value) => preferences?.setMessageStreamShowTodos(value)}
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
            onChange={(value) => preferences?.setApprovalMode(value)}
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
            onChange={(value) => preferences?.setAutoAnswerQuestions(value)}
          />
        </SettingRow>
      </SettingCard>
    </>
  );
}

function ArchiveSettings({ LegacyAgentData }: { readonly LegacyAgentData: ComponentType }) {
  const {
    preferences,
    values: { sessionAutoArchiveEnabled, sessionAutoArchiveOlderThanDays },
  } = useProjectPreferences();
  return (
    <>
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
            onChange={(enabled) => preferences?.setSessionAutoArchive(enabled)}
          />
        </SettingRow>
        <SettingRow
          label="闲置天数阈值"
          desc="会话最近活跃时间早于该天数即视为闲置（1–365）"
        >
          <ArchiveDaysInput
            key={sessionAutoArchiveOlderThanDays}
            value={sessionAutoArchiveOlderThanDays}
            onChange={(days) => {
              preferences?.setSessionAutoArchive(
                sessionAutoArchiveEnabled,
                days,
              );
            }}
          />
        </SettingRow>
      </SettingCard>
      <ArchiveManagementSection />
      <LegacyAgentData />
    </>
  );
}

const textInputClass = `${settingsInputClass} font-mono`;

function ToolSettings({ skills }: { readonly skills?: SkillsSettingsView }) {
  const SkillsInstaller = skills?.Installer;
  const SkillsSource = skills?.Source;
  const language = useWorkbenchLanguage();
  const toolPaths = useToolPathSettings();
  const t = createTranslator(language, settingsText);
  return (
    <>
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

        {SkillsSource && <SkillsSource />}
      </SettingCard>

      {SkillsInstaller && <SkillsInstaller />}
    </>
  );
}

const spaced = "flex flex-col gap-5";
export function createProjectSettings(
  LegacyAgentData: ComponentType = LegacyAgentDataSection,
  skillsSettings?: ReadonlySnapshot<{ readonly view?: SkillsSettingsView }>,
): readonly WorkbenchContributions["settings"][] {
  return [
    {
      id: "tools",
      order: 30,
      label: "工具路径",
      Icon: TerminalIcon,
      View: function ToolSettingsView() {
        const skills = useRegisteredSnapshot(skillsSettings, (state) => state?.view);
        return <ToolSettings skills={skills} />;
      },
      layoutClass: spaced,
    },
    {
      id: "session",
      order: 40,
      label: "会话与审批",
      Icon: ShieldCheckIcon,
      View: SessionSettings,
      layoutClass: spaced,
    },
    {
      id: "archive",
      order: 50,
      label: "归档管理",
      Icon: ArchiveIcon,
      View: () => <ArchiveSettings LegacyAgentData={LegacyAgentData} />,
      layoutClass: spaced,
    },
  ];
}
