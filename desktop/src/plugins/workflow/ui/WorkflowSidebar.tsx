/**
 * 左侧「工作流」功能区的侧栏（ADR 038）：用 AI 新建，以及预置 / 我的两个分类。
 * 点分类，中间显示这个分类的工作流库。运行不在这里，归右侧的 AAW 标签页。
 */
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { SidebarCreateButton } from "../../../shared/ui/SidebarCreateButton.tsx";
import { SidebarItemTitle } from "../../../shared/ui/SidebarItemTitle.tsx";
import { SparklesIcon } from "../../../shared/ui/icons.tsx";
import type { WorkflowDraft, WorkflowService, WorkflowSummary } from "../types.ts";
import type { LibraryTab, TemplateNavigation } from "./templateNavigation.ts";

export function WorkflowSidebar({ service, navigation, canCompose }: {
  readonly service: WorkflowService;
  readonly navigation: TemplateNavigation;
  /** 能不能用 AI 新建（没有编辑会话能力时不给入口）。 */
  readonly canCompose: boolean;
}) {
  const { tab, route } = useStore(navigation);
  const [items, setItems] = useState<readonly WorkflowSummary[] | null>(null);
  const [drafts, setDrafts] = useState<readonly WorkflowDraft[]>([]);

  useEffect(() => {
    let live = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      service.workflows().then((list) => { if (live && request === generation) setItems(list); }).catch(() => {});
      if (canCompose) service.drafts().then((list) => { if (live && request === generation) setDrafts(list); }).catch(() => {});
    };
    const unsubscribe = service.subscribe((event) => { if (event.type === "library-changed") load(); });
    load();
    return () => {
      live = false;
      unsubscribe();
    };
  }, [service, canCompose, route]);

  const mine = items?.filter((item) => item.origin === "user") ?? [];
  const counts: Record<LibraryTab, number | null> = {
    presets: items ? items.length - mine.length : null,
    // 新建的草稿（或原工作流已不在）在「我的」里单独成卡，一起计数。
    mine: items ? mine.length + drafts.filter((draft) => !draft.base || !mine.some((item) => item.id === draft.base)).length : null,
  };
  const categories: readonly { readonly value: LibraryTab; readonly label: string }[] = [
    { value: "presets", label: "预置" },
    { value: "mine", label: "我的" },
  ];

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 px-2 py-2" aria-label="工作流分类">
      {canCompose && <SidebarCreateButton label="用 AI 新建" Icon={SparklesIcon} onClick={() => navigation.setState({ compose: { kind: "new" } })} />}
      <ul className="min-h-0 overflow-y-auto">
        {categories.map(({ value, label }) => {
          const selected = tab === value;
          return <li key={value}>
            <NavigationRow
              className="min-h-8 w-full items-center gap-2 px-2"
              aria-current={selected || undefined}
              onClick={() => navigation.setState({ tab: value, route: { kind: "library" } })}
            >
              <SidebarItemTitle>{label}</SidebarItemTitle>
              {counts[value] !== null && <span className="shrink-0 text-ui-sm text-ink-mute">{counts[value]}</span>}
            </NavigationRow>
          </li>;
        })}
      </ul>
    </section>
  );
}
