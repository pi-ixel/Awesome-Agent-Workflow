/**
 * 文件树列表布局模式回归（FileTreeList 静态/虚拟双分支）：
 *
 * - 静态模式（≤100 行，virtual=false）：行不能落在绝对定位包装上——
 *   FileTreeRow 默认 layout="absolute"（绝对定位 + top-0），静态分支若
 *   不显式传 layout="static"，所有行会叠在列表同一位置（视觉坍缩：
 *   只看到第一行、文字互相覆盖、容器高 0）；
 * - 虚拟模式（>100 行）：行保持绝对定位 + translateY(start) 虚拟定位，
 *   容器高度 = totalSize；
 * - ZCode 紧凑规格：行盒 24px（FILE_TREE_ROW_HEIGHT_PX=24）、字号 text-xs、
 *   选中态 = 灰色圆角 pill 底（无描边）、文件行带内联彩色 SVG 图标、
 *   git 状态行尾 24px 字母标记列。
 *
 * jsdom 无真实布局：用类名/内联样式断言定位方式与规格。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FileTreeList } from "../../src/ui/right-panel/file-tree/FileTreeList.tsx";
import { FILE_TREE_ROW_HEIGHT_PX } from "../../src/ui/right-panel/file-tree/constants.ts";
import type { FileTreeRow } from "../../src/ui/right-panel/file-tree/model.ts";
import type { FileTreeRowHandlers } from "../../src/ui/right-panel/file-tree/FileTreeRow.tsx";

function makeRows(count: number): FileTreeRow[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "file" as const,
    path: `/proj/file-${index}.ts`,
    key: `/proj/file-${index}.ts`,
    name: `file-${index}.ts`,
    depth: 0,
    expanded: false,
    loaded: false,
    loading: false,
    error: null,
  }));
}

const handlers: FileTreeRowHandlers = {
  onSelect: () => {},
  onToggleDirectory: () => {},
  onOpenFile: () => {},
  onOpenContextMenu: () => {},
  onKeyDown: () => {},
};

function renderList(
  rows: FileTreeRow[],
  virtual: boolean,
  options?: { selectedKey?: string | null },
): HTMLElement {
  render(
    <FileTreeList
      rootError={null}
      showInitialLoading={false}
      rows={rows}
      virtualItems={[]}
      listRef={() => {}}
      stickyFolderCount={0}
      totalSize={virtual ? rows.length * FILE_TREE_ROW_HEIGHT_PX : 0}
      emptyTitle="当前目录为空。"
      title="proj"
      root="/proj"
      selectedKey={options?.selectedKey ?? null}
      gitStatusByPath={new Map()}
      handlers={handlers}
      virtual={virtual}
    />,
  );
  return screen.getByRole("tree", { name: "proj" });
}

describe("FileTreeList 布局模式", () => {
  it("静态模式：行按文档流纵向排列，不落在绝对定位包装上", () => {
    const tree = renderList(makeRows(3), false);
    // 静态分支：px-1 流式容器承载行（对齐虚拟行包装的水平几何）
    expect(tree.children).toHaveLength(1);
    expect((tree.children[0] as HTMLElement).className).toContain("px-1");
    const rowWrappers = Array.from(
      (tree.children[0] as HTMLElement).children,
    ) as HTMLElement[];
    expect(rowWrappers).toHaveLength(3);
    for (const wrapper of rowWrappers) {
      // layout="absolute" 的包装类：叠在同一位置的坍缩形态
      expect(wrapper.className).not.toContain("absolute");
      expect(wrapper.className).not.toContain("top-0");
      expect(wrapper.style.transform).toBe("");
      expect(wrapper.style.height).toBe("");
    }
  });

  it("虚拟模式：行绝对定位且 translateY 逐行递增 24px", () => {
    const rows = makeRows(3);
    const virtualItems = rows.map((_, index) => ({
      key: `${index}`,
      index,
      start: index * FILE_TREE_ROW_HEIGHT_PX,
      end: (index + 1) * FILE_TREE_ROW_HEIGHT_PX,
      size: FILE_TREE_ROW_HEIGHT_PX,
      lane: 0,
    }));
    render(
      <FileTreeList
        rootError={null}
        showInitialLoading={false}
        rows={rows}
        virtualItems={virtualItems}
        listRef={() => {}}
        stickyFolderCount={0}
        totalSize={rows.length * FILE_TREE_ROW_HEIGHT_PX}
        emptyTitle="当前目录为空。"
        title="proj"
        root="/proj"
        selectedKey={null}
        gitStatusByPath={new Map()}
        handlers={handlers}
        virtual={true}
      />,
    );
    const tree = screen.getByRole("tree", { name: "proj" });
    const rowWrappers = Array.from(tree.children) as HTMLElement[];
    expect(rowWrappers).toHaveLength(3);
    rowWrappers.forEach((wrapper, index) => {
      expect(wrapper.className).toContain("absolute");
      expect(wrapper.style.transform).toBe(
        `translateY(${index * FILE_TREE_ROW_HEIGHT_PX}px)`,
      );
      expect(wrapper.style.height).toBe(`${FILE_TREE_ROW_HEIGHT_PX}px`);
    });
    expect(tree.style.height).toBe(
      `${rows.length * FILE_TREE_ROW_HEIGHT_PX}px`,
    );
  });

  it("紧凑规格：行盒 24px/text-xs、选中态 pill 底无描边、内联彩色图标、状态字母列", () => {
    const gitStatusByPath = new Map([
      ["/proj/file-1.ts", "modified" as const],
    ]);
    render(
      <FileTreeList
        rootError={null}
        showInitialLoading={false}
        rows={makeRows(2)}
        virtualItems={[]}
        listRef={() => {}}
        stickyFolderCount={0}
        totalSize={0}
        emptyTitle="当前目录为空。"
        title="proj"
        root="/proj"
        selectedKey="/proj/file-0.ts"
        gitStatusByPath={gitStatusByPath}
        handlers={handlers}
        virtual={false}
      />,
    );
    const tree = screen.getByRole("tree", { name: "proj" });
    const rows = tree.querySelectorAll('[role="treeitem"]');
    expect(rows).toHaveLength(2);
    // 选中态 = 灰 pill 底，无 border-brand 描边
    const selected = rows[0] as HTMLElement;
    expect(selected.className).toContain("bg-surface-hover");
    expect(selected.className).not.toContain("border-brand");
    expect(selected.className).toContain("h-6");
    expect(selected.className).toContain("text-xs");
    // .ts → 内联 SVG 图标（typescript → code 形状，品牌蓝）
    const icon = selected.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("stroke")).toBe("#3178c6");
    // git 修改行：行名橙色 + 行尾 M 字母固定 24px 列（70% 透明）
    const modified = rows[1] as HTMLElement;
    const indicator = modified.querySelector('[aria-label="修改"]');
    expect(indicator).not.toBeNull();
    expect(indicator!.textContent).toBe("M");
    expect(indicator!.className).toContain("w-6");
    expect(indicator!.className).toContain("text-warn/70");
  });
});
