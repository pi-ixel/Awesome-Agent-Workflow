/**
 * 会话内的 AAW 增强面板（右栏抽屉）：把「工作流进度」与「从入口启动」
 * 就地放在产生它们的那个视图里，不必离开对话去项目总览。
 *
 * 定位：AAW 是会话的增强，不是会话的前置条件——面板默认收起，从上下文
 * 条的「SR-xxx · 步骤 n」按钮（或会话头的 AAW 入口）拉出来，看完收起，
 * 对话始终是主体。
 *
 * 两个分段：
 * - 进度：工作流状态（AawStatusPanel，严格只读渲染 + 一键把 done / 放行
 *   命令交给会话执行）；
 * - 启动：入口向导（EntryWizard，三入口 SR / AR / dev 齐备）。首条 prompt
 *   经 onSubmitAawPrompt 走会话发送通路（未连接先连接）。
 */
import { useState } from "react";
import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import {
  focusVisibleRing,
  tabActiveClass,
  tabInactiveClass,
} from "../controls.tsx";
import AawStatusPanel from "../AawStatusPanel.tsx";
import { XIcon } from "../icons.tsx";
import EntryWizard from "../EntryWizard.tsx";
import type { WizardSubmitResult } from "./wizardSubmit.ts";

type AawSegment = "progress" | "launch";

export interface SessionAawPanelProps {
  /** 向导首条 prompt 的发送通路（组装层接 submitWizardPrompt）。 */
  readonly onSubmitAawPrompt: (
    prompt: string,
  ) => Promise<WizardSubmitResult> | WizardSubmitResult;
  /** 面板内的「查看对话」：收起面板回到消息流。 */
  readonly onClose: () => void;
}

export function SessionAawPanel({
  onSubmitAawPrompt,
  onClose,
}: SessionAawPanelProps) {
  // slash 定位入口（/sr /ar /dev）：null = 默认从入口选择起
  const wizardEntry = useWorkbenchUiStore((state) => state.aawWizardEntry);
  const [segment, setSegment] = useState<AawSegment>("progress");
  // 命令类动作（done / 放行）在会话侧执行的入口：直接发一条 prompt，
  // 由 agent 读取并执行，用户不必手动复制粘贴
  const sendCommand = (command: string): void => {
    useSessionStore.getState().sendPrompt(command);
  };

  const segments: ReadonlyArray<{ id: AawSegment; label: string }> = [
    { id: "progress", label: "进度" },
    { id: "launch", label: "启动" },
  ];

  return (
    <aside
      aria-label="AAW 面板"
      className="aaw-panel-in flex w-[22rem] shrink-0 flex-col border-l border-line bg-surface"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-2">
        <div
          role="tablist"
          aria-label="AAW 面板分段"
          className="flex gap-0.5 rounded-md border border-line bg-base p-0.5"
        >
          {segments.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={segment === item.id}
              onClick={() => {
                setSegment(item.id);
              }}
              className={`rounded px-2 py-0.5 text-ui-base transition-colors ${
                segment === item.id ? tabActiveClass : tabInactiveClass
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span aria-hidden={true} className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="收起 AAW 面板"
          title="收起 AAW 面板（回到对话）"
          className={`shrink-0 rounded px-1.5 py-0.5 text-ui-base text-ink-faint transition-colors hover:bg-raised hover:text-ink ${focusVisibleRing}`}
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2.5">
        {segment === "progress" ? (
          <AawStatusPanel onRunCommand={sendCommand} />
        ) : (
          // key 随 slash 定位入口变化重挂：/sr→/ar 切换时表单重开到新入口
          <EntryWizard
            key={wizardEntry ?? "default"}
            hasActiveSession={true}
            onSubmitPrompt={onSubmitAawPrompt}
            initialEntry={wizardEntry ?? undefined}
          />
        )}
      </div>
    </aside>
  );
}

export default SessionAawPanel;
