import { useState, type ReactNode } from "react";
import {
  ContextMenu,
  type ContextMenuItemSpec,
  type ContextMenuSearch,
  type MenuPlacement,
} from "../../../../shared/ui/ContextMenu.tsx";
import { ActionButton } from "../../../../shared/ui/controls.tsx";
import { ChevronDownIcon } from "../../../../shared/ui/icons.tsx";

/** 信息流的审批和模型入口。业务选择项使用共享菜单的单选语义。 */
export function StatusChipMenu({
  label,
  title,
  menuLabel,
  warning = false,
  entries,
  header,
  search,
}: {
  readonly label: ReactNode;
  readonly title: string;
  readonly menuLabel: string;
  readonly warning?: boolean;
  readonly entries: readonly ContextMenuItemSpec[];
  readonly header?: ReactNode;
  readonly search?: ContextMenuSearch;
}) {
  const [menu, setMenu] = useState<{
    placement: MenuPlacement;
    trigger: HTMLButtonElement;
  } | null>(null);
  return (
    <div className="relative shrink-0">
      <ActionButton
        tone="ghost"
        aria-haspopup={search ? "dialog" : "menu"}
        aria-expanded={menu !== null}
        aria-label={menuLabel}
        data-hint={title}
        onClick={(event) => {
          if (menu) {
            setMenu(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({
            placement: { x: rect.left, y: rect.top - 6, side: "top" },
            trigger: event.currentTarget,
          });
        }}
        className={`flex min-h-7 items-center gap-1 rounded-control px-1.5 py-1 text-ui-base font-normal ${
          warning ? "text-warn-ink! hover:text-warn-ink!" : "text-ink"
        }`}
      >
        {label}
        <ChevronDownIcon className="ui-icon-14 shrink-0 opacity-70" />
      </ActionButton>
      {menu && (
        <ContextMenu
          entries={entries}
          header={header}
          search={search}
          placement={menu.placement}
          label={menuLabel}
          trigger={menu.trigger}
          variant="selection"
          closing={false}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  );
}
