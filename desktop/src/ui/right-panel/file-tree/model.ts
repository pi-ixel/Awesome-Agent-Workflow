/**
 * 文件树核心模型（对齐 ZCode workspace-file-tree/model.ts）：
 *
 * - 路径身份：desktop 以 pathKey（Windows 全小写折叠）为 Map 键，node 保留
 *   原始显示路径——ZCode 用规范化路径做键，desktop 需要额外一层大小写折叠；
 * - Git 状态合并优先级 untracked > added > deleted > renamed > modified >
 *   ignored（model.ts:30-37）；目录聚合圆点用 VS Code 语义的另一套优先级
 *   modified > A/D/R/U > ignored（model.ts:39-46）；
 * - deleted 虚拟行：Git 删除的文件不在磁盘上，readdir 补不出来，按父目录
 *   已加载为前提注入虚拟子节点（model.ts:158-208）；
 * - 单子目录链扁平化：目录无直属文件且仅一个子目录时压成一行 a/b
 *   （model.ts:383-461）。
 */
import { normalizePath, pathKey } from "../../../core/panelPaths.ts";
import type { GitChange } from "../../../core/panelService.ts";

export type FileTreeGitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored";

export interface FileTreeNode {
  /** 原始显示路径（保留文件系统大小写）。 */
  path: string;
  /** pathKey 身份（Windows 大小写折叠后的 Map 键）。 */
  key: string;
  name: string;
  directory: boolean;
  symlink: boolean;
  /** 距根的物理深度：根子项为 0。 */
  depth: number;
}

export interface FileTreeRow {
  type: "directory" | "file";
  path: string;
  key: string;
  /** compact 目录链的连接名（a/b/c）；普通行与 name 一致。 */
  name: string;
  depth: number;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** 被压扁进本行的全部目录 key（收起时要逐个移除展开态）。 */
  compactedKeys?: string[];
}

/** Git 变更在文件行上的合并优先级（同文件多记录取高者）。 */
const STATUS_PRIORITY: Record<FileTreeGitStatus, number> = {
  ignored: 0,
  modified: 1,
  renamed: 2,
  deleted: 3,
  added: 4,
  untracked: 5,
};

/** 目录聚合圆点的优先级（VS Code decoration 语义：modified 高于 A/D/R/U）。 */
const DIRECTORY_STATUS_PRIORITY: Record<FileTreeGitStatus, number> = {
  added: 1,
  deleted: 1,
  renamed: 1,
  untracked: 1,
  modified: 2,
  ignored: 3,
};

/** desktop 的 GitChange → ZCode 文件树状态语义。
 *  冲突（UU/AA/DD）在 ZCode 文件树里没有对应状态，按修改呈现。 */
function gitStatusOfChange(change: GitChange): FileTreeGitStatus {
  if (change.source === "untracked") return "untracked";
  if (change.source === "conflict") return "modified";
  switch (change.status) {
    case "新增":
      return "added";
    case "删除":
      return "deleted";
    case "重命名":
    case "复制":
      return "renamed";
    default:
      return "modified"; // 修改 / 类型变化
  }
}

export interface FileTreeDeletedFile {
  path: string;
  key: string;
  name: string;
  parentKey: string;
}

export interface FileTreeGitState {
  /** key = pathKey(绝对路径)。 */
  statusByPath: Map<string, FileTreeGitStatus>;
  /** 需要补虚拟行的 deleted 文件（磁盘上已不存在）。 */
  deletedFiles: FileTreeDeletedFile[];
}

export function buildFileTreeGitState(
  changes: readonly GitChange[],
  repoRoot: string,
): FileTreeGitState {
  const statusByPath = new Map<string, FileTreeGitStatus>();
  const pathByKey = new Map<string, string>();
  for (const change of changes) {
    const path = normalizePath(`${repoRoot}/${change.path}`);
    const key = pathKey(path);
    const status = gitStatusOfChange(change);
    const existing = statusByPath.get(key);
    // 同一文件可能同时有 staged/unstaged 记录：保留优先级更高的状态。
    if (existing && STATUS_PRIORITY[existing] >= STATUS_PRIORITY[status]) continue;
    statusByPath.set(key, status);
    if (!pathByKey.has(key)) pathByKey.set(key, path);
  }
  const deletedFiles: FileTreeDeletedFile[] = [];
  for (const [key, status] of statusByPath) {
    if (status !== "deleted") continue;
    const path = pathByKey.get(key) ?? key;
    deletedFiles.push({
      path,
      key,
      name: path.split("/").at(-1) ?? path,
      parentKey: key.slice(0, Math.max(0, key.lastIndexOf("/"))),
    });
  }
  return { statusByPath, deletedFiles };
}

export function getFileGitStatus(
  statusByPath: ReadonlyMap<string, FileTreeGitStatus>,
  key: string,
): FileTreeGitStatus | null {
  return statusByPath.get(key) ?? null;
}

/** 目录子树的聚合状态，按目录优先级排序（descendant 圆点/目录名取 [0]）。 */
export function getDirectoryGitStatuses(
  statusByPath: ReadonlyMap<string, FileTreeGitStatus>,
  directoryKey: string,
): FileTreeGitStatus[] {
  const prefix = `${directoryKey}/`;
  const statuses = new Set<FileTreeGitStatus>();
  for (const [path, status] of statusByPath) {
    if (path.startsWith(prefix)) statuses.add(status);
  }
  return [...statuses].sort(
    (left, right) =>
      DIRECTORY_STATUS_PRIORITY[right] - DIRECTORY_STATUS_PRIORITY[left],
  );
}

export function isFileTreeKeyInside(key: string, rootKey: string): boolean {
  return key === rootKey || key.startsWith(`${rootKey}/`);
}

/** key 相对根的物理深度（根为 0，根子项为 1）。 */
export function getChildDepth(rootKey: string, key: string): number {
  if (!isFileTreeKeyInside(key, rootKey) || key === rootKey) return 0;
  return key.slice(rootKey.length + 1).split("/").filter(Boolean).length;
}

export function getRelativePath(root: string, path: string): string {
  const base = normalizePath(root).replace(/\/+$/, "");
  const target = normalizePath(path);
  if (target === base) return ".";
  const prefix = `${base}/`;
  return target.startsWith(prefix)
    ? target.slice(prefix.length)
    : (target.split("/").at(-1) ?? target);
}

/** 祖先目录链（不含自身；输入按文件语义，末段不算目录）。 */
export function getAncestorDirectories(
  root: string,
  path: string,
): { path: string; key: string }[] {
  const base = normalizePath(root).replace(/\/+$/, "");
  const target = normalizePath(path);
  if (target === base || !target.startsWith(`${base}/`)) return [];
  const segments = target.slice(base.length + 1).split("/").filter(Boolean);
  if (segments.length <= 1) return [];
  const ancestors: { path: string; key: string }[] = [];
  let current = base;
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    ancestors.push({ path: current, key: pathKey(current) });
  }
  return ancestors;
}

/** Rust readdir 已按「目录在前、小写名称序」排序；仅注入虚拟行后需要重排。 */
function sortEntries(entries: FileTreeNode[]): FileTreeNode[] {
  return entries.sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/** deleted 文件不在磁盘上，readdir 补不出行——在父目录已加载的前提下注入虚拟节点。 */
function withDeletedRows(
  rootKey: string,
  childrenByKey: ReadonlyMap<string, FileTreeNode[]>,
  deletedFiles: readonly FileTreeDeletedFile[],
): Map<string, FileTreeNode[]> {
  if (deletedFiles.length === 0) {
    return childrenByKey instanceof Map
      ? (childrenByKey as Map<string, FileTreeNode[]>)
      : new Map<string, FileTreeNode[]>(childrenByKey);
  }
  let next: Map<string, FileTreeNode[]> | null = null;
  for (const file of deletedFiles) {
    if (!file.parentKey || !isFileTreeKeyInside(file.parentKey, rootKey)) {
      continue;
    }
    const children = (next ?? childrenByKey).get(file.parentKey);
    if (!children) continue;
    if (children.some((child) => child.key === file.key)) continue;
    const merged = sortEntries([
      ...children,
      {
        path: file.path,
        key: file.key,
        name: file.name,
        directory: false,
        symlink: false,
        // 与 readdir 加载的子节点同层：父目录自身的物理子深度
        // （根子项为 0，与 loadDirectory(root, 0) 一致）。
        depth: getChildDepth(rootKey, file.parentKey),
      },
    ]);
    next ??= new Map(childrenByKey);
    next.set(file.parentKey, merged);
  }
  return next ?? new Map<string, FileTreeNode[]>(childrenByKey);
}

export function flattenFileTreeRows(params: {
  rootKey: string;
  childrenByKey: ReadonlyMap<string, FileTreeNode[]>;
  expandedKeys: ReadonlySet<string>;
  loadedKeys: ReadonlySet<string>;
  loadingKeys: ReadonlySet<string>;
  errorByKey: ReadonlyMap<string, string>;
  deletedFiles?: readonly FileTreeDeletedFile[];
}): FileTreeRow[] {
  const childrenMap = withDeletedRows(
    params.rootKey,
    params.childrenByKey,
    params.deletedFiles ?? [],
  );
  const rows: FileTreeRow[] = [];

  /** 单子目录链压扁（flattenEmptyDirectories）；软链目录不参与，防符号环。 */
  function compactDirectoryNode(node: FileTreeNode): {
    node: FileTreeNode;
    compactedKeys?: string[];
    childDepthOffset: number;
  } {
    if (!node.directory || node.symlink) {
      return { node, childDepthOffset: 0 };
    }
    const chain = [node];
    let current = node;
    while (
      params.loadedKeys.has(current.key) &&
      !params.loadingKeys.has(current.key) &&
      !params.errorByKey.has(current.key)
    ) {
      const siblings = childrenMap.get(current.key) ?? [];
      const first = siblings[0];
      const only =
        siblings.length === 1 &&
        first !== undefined &&
        first.directory &&
        !first.symlink
          ? first
          : null;
      // 自引用（如测试 mock 或异常文件系统）直接断链，避免死循环。
      if (!only || only.key === current.key) break;
      current = only;
      chain.push(current);
    }
    if (chain.length === 1) {
      return { node, childDepthOffset: 0 };
    }
    return {
      node: {
        ...current,
        depth: node.depth,
        name: chain.map((entry) => entry.name).join("/"),
      },
      compactedKeys: chain.map((entry) => entry.key),
      childDepthOffset: current.depth - node.depth,
    };
  }

  function visit(directoryKey: string, depthOffset = 0): void {
    const entries = childrenMap.get(directoryKey) ?? [];
    for (const child of entries) {
      const compacted = compactDirectoryNode({
        ...child,
        depth: child.depth - depthOffset,
      });
      const representedKeys = compacted.compactedKeys ?? [compacted.node.key];
      const expanded = representedKeys.some((key) =>
        params.expandedKeys.has(key),
      );
      rows.push({
        type: compacted.node.directory ? "directory" : "file",
        path: compacted.node.path,
        key: compacted.node.key,
        name: compacted.node.name,
        depth: compacted.node.depth,
        expanded,
        loaded: params.loadedKeys.has(compacted.node.key),
        loading: params.loadingKeys.has(compacted.node.key),
        error: params.errorByKey.get(compacted.node.key) ?? null,
        ...(compacted.compactedKeys
          ? { compactedKeys: compacted.compactedKeys }
          : {}),
      });
      if (compacted.node.directory && expanded) {
        visit(compacted.node.key, depthOffset + compacted.childDepthOffset);
      }
    }
  }

  visit(params.rootKey);
  return rows;
}

/** 「仅显示变更」过滤：有 Git 状态的行 + 有后代变更的目录（model.ts:324-336）。 */
export function filterChangedRows(
  rows: readonly FileTreeRow[],
  statusByPath: ReadonlyMap<string, FileTreeGitStatus>,
): FileTreeRow[] {
  return rows.filter((row) => {
    const status = statusByPath.get(row.key);
    if (status && status !== "ignored") return true;
    return (
      row.type === "directory" &&
      getDirectoryGitStatuses(statusByPath, row.key).length > 0
    );
  });
}
