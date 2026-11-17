import { useProjectSidebarValue } from "./bindings/projectView.tsx";
/** 展开侧栏的新建入口，保留项目选择行为。 */
import { MessageCirclePlusIcon } from "../../../shared/ui/icons.tsx";

export function NewTaskButtonGroup() {
  const toggleAddPanel = useProjectSidebarValue(
    (state) => state.toggleAddPanel,
  );
  return (
    <div role="group">
      <button
        type="button"
        aria-label="新建会话"
        data-hint="新建会话"
        onClick={toggleAddPanel}
        className="group w-full h-10 rounded-xl border border-control-line bg-surface inline-flex shrink-0 items-center justify-center gap-2 overflow-hidden px-2.5 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus-ring cursor-pointer"
      >
        <span className="flex min-w-0 items-center justify-center gap-2 text-ui-base">
          <MessageCirclePlusIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">新建会话</span>
        </span>
      </button>
    </div>
  );
}

export default NewTaskButtonGroup;
