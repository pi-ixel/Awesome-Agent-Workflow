/** 文件树几何与节流常量（对齐 ZCode workspace-file-tree/constants.ts）。 */
export const FILE_TREE_ROW_HEIGHT_PX = 24;
export const FILE_TREE_ROW_GAP_PX = 0;
/** 虚拟行高：ZCode estimateSize=28、overscan=12（WorkspaceFileTree.tsx:191-196）。 */
export const FILE_TREE_VIRTUAL_ROW_HEIGHT_PX =
  FILE_TREE_ROW_HEIGHT_PX + FILE_TREE_ROW_GAP_PX;
/** 目录并发读取上限（沿用 desktop 既有 4；ZCode 刷新批为 2）。 */
export const FILE_TREE_READ_CONCURRENCY = 4;
/** 手动/watcher 刷新的目录批刷新并发（ZCode constants.ts WATCH_REFRESH_CONCURRENCY）。 */
export const FILE_TREE_REFRESH_CONCURRENCY = 2;
/** 目录深度上限（沿用 desktop 既有 32）。 */
export const FILE_TREE_DEPTH_LIMIT = 32;

/** 虚拟列表吸顶遮罩的 CSS 变量（ZCode WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY），
 *  由原生 scroll 回调直接写值，与浏览器滚动同步绘制。 */
export const FILE_TREE_MASK_OFFSET_PROPERTY =
  "--workspace-file-tree-mask-offset";

/** 拖拽自定义 MIME（ZCode WORKSPACE_FILE_DRAG_MIME 的 desktop 命名）。 */
export const FILE_TREE_DRAG_MIME = "application/x-aaw-workspace-file";

/** 列表顶部吸顶遮罩：只隐藏视口顶部的吸顶高度（transparent→hiddenHeight），
 *  不改变列表布局与滚动范围；位置随 scrollTop 平移（ZCode
 *  WorkspaceFileTreeList.tsx:25-50）。 */
export function getFileTreeListMaskStyle(
  stickyFolderCount: number,
): Record<string, string> | undefined {
  if (stickyFolderCount === 0) return undefined;
  const hiddenHeight = stickyFolderCount * FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
  const maskImage = `linear-gradient(to bottom, transparent 0 ${hiddenHeight}px, black ${hiddenHeight}px)`;
  const maskPosition = `0 var(${FILE_TREE_MASK_OFFSET_PROPERTY})`;
  const maskSize = `100% calc(100% - var(${FILE_TREE_MASK_OFFSET_PROPERTY}))`;
  return {
    WebkitMaskImage: maskImage,
    maskImage,
    WebkitMaskPosition: maskPosition,
    maskPosition,
    WebkitMaskSize: maskSize,
    maskSize,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  };
}
