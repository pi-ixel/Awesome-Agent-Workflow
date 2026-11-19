/**
 * 工作流面板的按钮：直接用应用公共按钮的样式（shared/ui/controls.tsx），
 * 只在这里统一叠加面板里用的尺寸，保证同组按钮同高。
 */
import { btnGhost, btnPrimary, btnSecondary, btnSize, focusVisibleRing } from "../../../shared/ui/controls.tsx";

/** 这一屏唯一的主操作（开始运行、继续运行、去处理）：应用的中性主按钮。 */
export const primaryButton = `${btnPrimary} ${btnSize}`;
/** 常规操作。 */
export const secondaryButton = `${btnSecondary} ${btnSize}`;
/** 工作流卡片上的「运行」：淡绿描边底，在一排中性控件里认得出是「开始」。 */
export const goButton = `press rounded-md border border-ok-line bg-ok-bg/60 font-medium text-ok-ink transition-colors hover:border-ok-ink hover:bg-ok-bg ${focusVisibleRing} ${btnSize}`;
/** 取消、返回这类弱操作。 */
export const ghostButton = `${btnGhost} ${btnSize}`;
/** 危险操作的尺寸（配合 DangerButton 使用）。 */
export const dangerSize = btnSize;
/** 只有图标的按钮（关闭、更多）。 */
export const iconButton = `${btnGhost} inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center`;
