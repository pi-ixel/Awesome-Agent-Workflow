import { useProjectSidebarValue } from "./bindings/projectView.tsx";
/** 展开侧栏的新建入口，保留项目选择行为。 */
import { MessageCirclePlusIcon } from "../../../shared/ui/icons.tsx";
import { SidebarCreateButton } from "../../../shared/ui/SidebarCreateButton.tsx";

export function NewTaskButtonGroup() {
  const toggleAddPanel = useProjectSidebarValue(
    (state) => state.toggleAddPanel,
  );
  return (
    <div role="group">
      <SidebarCreateButton label="新建会话" Icon={MessageCirclePlusIcon} onClick={toggleAddPanel} />
    </div>
  );
}

export default NewTaskButtonGroup;
