import { useState } from "react";
import { createRoot } from "react-dom/client";
import { bindSecondaryWindowAppearance } from "../../src/plugins/workbench/appearance/windowAppearance.ts";
import {
  TreeBranch,
  treeChevronClass,
  treeRowEnterClass,
} from "../../src/shared/ui/TreeMotion.tsx";
import { FileTreeList } from "../../src/plugins/documents/ui/file-tree/FileTreeList.tsx";
import type { FileTreeRow } from "../../src/plugins/documents/ui/file-tree/model.ts";
import "../../src/shared/styles/index.css";
function Fixture() {
  const [open, setOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const folder: FileTreeRow = {
    type: "directory",
    path: "/root/docs",
    key: "/root/docs",
    name: "docs",
    depth: 0,
    expanded: folderOpen,
    loaded: true,
    loading: false,
    error: null,
  };
  const file: FileTreeRow = {
    ...folder,
    type: "file",
    path: "/root/docs/test.ts",
    key: "/root/docs/test.ts",
    name: "test.ts",
    depth: 1,
    expanded: false,
  };
  const handlers = {
    onSelect: () => {},
    onToggleDirectory: () => setFolderOpen((value) => !value),
    onOpenFile: () => {},
    onOpenContextMenu: () => {},
  };
  return (
    <div>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        目录{" "}
        <span className={`${treeChevronClass} ${open ? "rotate-90" : ""}`}>
          ›
        </span>
      </button>
      <TreeBranch open={open}>
        <div style={{ height: 120 }}>子节点</div>
      </TreeBranch>
      <div className={treeRowEnterClass}>文件行</div>
      <FileTreeList
        rootError={null}
        showInitialLoading={false}
        rows={folderOpen ? [folder, file] : [folder]}
        virtualItems={[]}
        listRef={() => {}}
        stickyFolderCount={0}
        totalSize={0}
        emptyTitle="空"
        title="文件"
        root="/root"
        selectedKey={null}
        gitStatusByPath={new Map()}
        handlers={handlers}
        virtual={false}
      />
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
const params = new URLSearchParams(location.search);
if (params.has("sessions")) {
  bindSecondaryWindowAppearance(document.documentElement);
  const { renderProjectTree } = await import("./projectTreeFixture.tsx");
  renderProjectTree(root, { running: params.has("running") });
} else {
  root.render(<Fixture />);
}
