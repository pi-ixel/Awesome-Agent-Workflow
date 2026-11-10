export interface FileEntry {
  path: string;
  name: string;
  directory: boolean;
  symlink: boolean;
}

export interface DirectoryResult {
  entries: FileEntry[];
  truncated: boolean;
}

export interface FilePreview {
  kind: "image" | "text";
  content: string;
  mime: string;
  bytes: number;
}

export interface WatchPath {
  path: string;
  recursive: boolean;
}

export interface DocumentFileHost {
  openInFileManager(path: string, mode: "directory" | "file"): Promise<void>;
  assetUrl(this: void, path: string): string | undefined;
  stat(path: string): Promise<FileEntry>;
  directory(path: string): Promise<DirectoryResult>;
  preview(path: string): Promise<FilePreview>;
  listWorkspaceFiles(path: string): Promise<readonly string[] | null>;
  saveMarkdown(
    path: string,
    expected: string,
    contents: string,
    force: boolean,
  ): Promise<void>;
  watch(
    paths: WatchPath[],
    changed: () => void,
    failed: (error: string) => void,
  ): Promise<() => void>;
}

export type GitSource =
  "staged" | "unstaged" | "untracked" | "conflict" | "branch";

export interface GitChange {
  path: string;
  oldPath: string | null;
  source: GitSource;
  status: string;
  added?: number;
  removed?: number;
  statsUnavailable?: boolean;
}

export interface GitSnapshot {
  repoRoot: string | null;
  branch: string;
  changes: GitChange[];
  watchPaths: string[];
  watchWarning?: string | null;
  upstream?: string | null;
  branchChanges?: GitChange[];
  branchError?: string | null;
  statsWarning?: string | null;
}

export interface GitDiff {
  patch: string;
  notice: string | null;
  beforeContent?: string | null;
  afterContent?: string | null;
}

export interface GitHost {
  status: (project: string) => Promise<GitSnapshot>;
  diff(project: string, change: GitChange): Promise<GitDiff>;
  watch(
    paths: WatchPath[],
    changed: () => void,
    failed: (error: string) => void,
  ): Promise<() => void>;
}
