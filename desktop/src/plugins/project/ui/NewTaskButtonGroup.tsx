import { useProjectSidebarValue } from "./bindings/projectView.tsx";
/** 展开侧栏的新建入口，保留项目选择行为。 */
import { MessageCirclePlusIcon } from "../../../shared/ui/icons.tsx";
import { focusVisibleRing } from "../../../shared/ui/controls.tsx";

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
        className={`flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface/60 px-2.5 text-ui-base font-medium text-ink transition-colors hover:bg-raised ${focusVisibleRing}`}
      >
        <MessageCirclePlusIcon className="ui-icon-16 shrink-0" />
        <span className="min-w-0 truncate">新建会话</span>
      </button>
    </div>
  );
}

export default NewTaskButtonGroup;
