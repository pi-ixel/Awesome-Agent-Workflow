/**
 * 会话停靠坞（消息流与输入区之间）：问答 / 队列两个面板的统一容器——
 * 同宽对齐、统一留白、固定顺序（问答在上，队列紧挨输入框），各面板
 * 独立条件渲染、互不遮蔽。宽度壳（mx-auto max-w-4xl + 左右 20px 留白）
 * 由本容器独占，成员组件只渲染裸卡片。任务步骤清单在消息流内
 * （PlanCard），不占停靠坞。
 */
import type { ReactNode } from "react";
import { chatWidthClassOf } from "./chatWidth.ts";
import { useProjectPreferences } from "../../ui/preferencesView.tsx";

export function SessionDock({ children }: { readonly children: ReactNode }) {
  const { values: { chatWidth } } = useProjectPreferences();
  const widthClass = chatWidthClassOf(chatWidth);
  return (
    <div
      className="shrink-0"
      style={{ padding: "0 16px" }}
      data-session-dock=""
    >
      <div className={`mx-auto w-full space-y-2 ${widthClass}`}>{children}</div>
    </div>
  );
}
