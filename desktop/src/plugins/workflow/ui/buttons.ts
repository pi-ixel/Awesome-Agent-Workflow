/**
 * 工作流面板的按钮：直接用应用公共按钮的样式（shared/ui/controls.tsx），
 * 只在这里统一叠加面板里用的尺寸，保证同组按钮同高。
 */
import { btnGhost, btnPrimary, btnSecondary, btnSize } from "../../../shared/ui/controls.tsx";

/** 这一屏唯一的主操作（开始运行、继续运行、去处理）：应用的蓝色主按钮。 */
export const primaryButton = `${btnPrimary} ${btnSize}`;
/** 常规操作。 */
export const secondaryButton = `${btnSecondary} ${btnSize}`;
/** 取消、返回这类弱操作。 */
export const ghostButton = `${btnGhost} ${btnSize}`;
/** 危险操作的尺寸（配合 DangerButton 使用）。 */
export const dangerSize = btnSize;
/** 只有图标的按钮（关闭、更多）。 */
export const iconButton = `${btnGhost} inline-flex size-7 shrink-0 items-center justify-center`;
