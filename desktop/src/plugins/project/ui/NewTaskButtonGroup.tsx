import { useProjectSidebarValue } from "./bindings/projectView.tsx";
/**
 * 顶部新建会话行（ZCode NewTaskButtonGroup 同名同形）：全宽 h-8 圆角行，
 * 图标 +「新建会话」文字，悬停 bg-surface-hover。住在左栏拖拽带之下、
 * 树区之上（ZCode ProjectSidebarNavigation 的同位）——侧栏收起后的全局
 * 新建入口由顶栏左端承接（ContextBar 的收起态新建钮，ZCode
 * DesktopTopOverlay 的强制显示位），本行是展开态的主入口。
 *
 * class 串逐字对齐 ZCode NewTaskButtonGroup.tsx:32-36（hover:bg-surface-hover；
 * 无任何文字颜色类——文字恒为继承的全前景色，hover 只加底色）；
 * ZCode 行尾的快捷键 span 省略——desktop 无快捷键注册表，无对应能力。
 */
import { MessageCirclePlusIcon } from "../../../shared/ui/icons.tsx";

export function NewTaskButtonGroup() {
  const toggleAddPanel = useProjectSidebarValue((state) => state.toggleAddPanel);
  return (
    <div role="group">
      <button
        type="button"
        aria-label="新建会话"
        data-hint="新建会话"
        onClick={toggleAddPanel}
        className="group w-full h-8 rounded-lg inline-flex shrink-0 items-center justify-stretch gap-2 overflow-hidden pl-2.5 pr-2.5 hover:bg-surface-hover active:translate-y-0 cursor-pointer"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-ui-base">
          <MessageCirclePlusIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">新建会话</span>
        </span>
      </button>
    </div>
  );
}

export default NewTaskButtonGroup;
