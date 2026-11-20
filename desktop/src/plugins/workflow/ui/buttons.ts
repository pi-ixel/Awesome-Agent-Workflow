/**
 * 工作流面板的按钮：直接用应用公共按钮的样式（shared/ui/controls.tsx），
 * 只在这里统一叠加面板里用的尺寸，保证同组按钮同高。
 */
import { btnGhost, btnSize } from "../../../shared/ui/controls.tsx";

/** 取消、返回这类弱操作。 */
export const ghostButton = `${btnGhost} ${btnSize}`;
/** 危险操作的尺寸（配合 DangerButton 使用）。 */
export const dangerSize = btnSize;
/** 只有图标的按钮（关闭、更多）。 */
export const iconButton = `${btnGhost} inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center`;
