export const REMOTE_PROJECT_PREFIX = "//aaw-remote/";
const PROJECT_ID_PREFIX = "//aaw-project/";

/** 项目引用包含稳定身份和创建时的主目录，供工作台索引及旧路径接口使用。 */
export function newProjectPath(primary: string): string {
  return `${PROJECT_ID_PREFIX}${crypto.randomUUID()}/${encodeURIComponent(projectFolderPath(primary))}`;
}

export function projectFolderPath(project: string): string {
  if (!project.startsWith(PROJECT_ID_PREFIX)) return project;
  const parts = project.slice(PROJECT_ID_PREFIX.length).split("/");
  if (parts.length !== 2 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(parts[0] ?? "")) return project;
  try {
    const primary = decodeURIComponent(parts[1] ?? "");
    return isAbsolutePath(primary) && !primary.startsWith(PROJECT_ID_PREFIX) ? primary : project;
  } catch {
    return project;
  }
}

export interface ParsedRemoteProjectPath {
  readonly projectId: string;
  readonly remotePath: string;
}

export function isRemoteProjectPath(path: string): boolean {
  return projectFolderPath(path).replaceAll("\\", "/").startsWith(REMOTE_PROJECT_PREFIX);
}

export function formatRemoteProjectPath(
  projectId: string,
  remotePath: string,
): string {
  const id = projectId.trim();
  const normalizedRemote = normalizePath(
    remotePath.trim().startsWith("/") ? remotePath.trim() : `/${remotePath.trim()}`,
  );
  return normalizedRemote === "/"
    ? `${REMOTE_PROJECT_PREFIX}${id}`
    : `${REMOTE_PROJECT_PREFIX}${id}${normalizedRemote}`;
}

export function parseRemoteProjectPath(
  path: string,
): ParsedRemoteProjectPath | null {
  const normalized = normalizePath(projectFolderPath(path));
  if (!normalized.startsWith(REMOTE_PROJECT_PREFIX)) return null;
  const rest = normalized.slice(REMOTE_PROJECT_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    return rest ? { projectId: rest, remotePath: "/" } : null;
  }
  const projectId = rest.slice(0, slash);
  if (!projectId) return null;
  const remotePath = rest.slice(slash) || "/";
  return { projectId, remotePath };
}

/** 将当前远程主机上的绝对路径还原为文档服务的路径身份，拒绝跨主机跳转。 */
export function workspaceTargetPath(project: string, path: string): string | null {
  if (/^https?:\/\//i.test(path)) return path;
  const remote = parseRemoteProjectPath(project);
  const target = parseRemoteProjectPath(path);
  if (target) return target.projectId === remote?.projectId ? path : null;
  if (!remote) return path;
  return path.startsWith("/") ? formatRemoteProjectPath(remote.projectId, path) : null;
}

/** 文件路径身份与聊天链接解析；明确绝对路径可位于项目外，相对路径不得越根。 */
export function normalizePath(path: string): string {
  const value = path.replaceAll("\\", "/");
  const root = value.startsWith("//") ? "//" : value.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of value.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && !parts.at(-1)?.endsWith(":")) parts.pop();
    } else parts.push(part);
  }
  const result = root + parts.join("/");
  return /^[a-z]:$/i.test(result) ? `${result}/` : result || root;
}
export function pathKey(path: string): string {
  const normalized = normalizePath(path);
  // 远程 Linux 项目路径保留大小写语义，仅按项目 ID + POSIX 路径区分。
  if (normalized.startsWith(REMOTE_PROJECT_PREFIX) || normalized.startsWith(PROJECT_ID_PREFIX)) {
    return normalized;
  }
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}
export function isAbsolutePath(path: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/])/i.test(path);
}
export function insidePath(root: string, path: string): boolean {
  const key = pathKey(projectFolderPath(root)).replace(/\/$/, "");
  const target = pathKey(projectFolderPath(path));
  return target === key || target.startsWith(`${key}/`);
}
export function pathName(path: string): string {
  const folder = projectFolderPath(path);
  return normalizePath(folder).split("/").at(-1) || folder;
}
export function parentPath(path: string): string {
  const value = normalizePath(path);
  const index = value.lastIndexOf("/");
  return normalizePath(
    value.slice(0, index + (index === 0 || index === 2 ? 1 : 0)),
  );
}
export interface FileReference {
  path: string;
  line?: number;
}
const fileLineSuffix = /(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)$/;

/** 明确的相对文件目标，保留行号，并拒绝协议、绝对路径和根目录逃逸。 */
export function resolveRelativeFileReference(
  root: string,
  target: string,
): FileReference | null {
  try {
    const decoded = decodeURIComponent(target.trim());
    const path = decoded.replace(fileLineSuffix, "");
    if (
      !path ||
      path.startsWith("#") ||
      isAbsolutePath(path) ||
      /[:\p{Cc}]/u.test(path)
    )
      return null;
    // ./ 防止带冒号行号的裸文件名被识别为 URL scheme。
    return resolveFileReference(root, `./${target.trim()}`);
  } catch {
    return null;
  }
}
export function resolveFileReference(
  root: string,
  href: string,
  base = root,
): FileReference | null {
  let target = href.trim();
  if (!target || target.startsWith("#")) return null;
  try {
    if (/^file:\/\//i.test(target)) {
      const url = new URL(target);
      target =
        `${url.hostname && url.hostname !== "localhost" ? `//${url.hostname}` : ""}${url.pathname}${url.hash}`.replace(
          /^\/([a-z]:\/)/i,
          "$1",
        );
    } else if (/^[a-z][\w+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target))
      return null;
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  const suffix = fileLineSuffix.exec(target);
  const line = suffix ? Number(suffix[1] ?? suffix[2]) : undefined;
  if (suffix) target = target.slice(0, suffix.index);
  const absolute = isAbsolutePath(target);
  const path = normalizePath(absolute ? target : `${projectFolderPath(base)}/${target}`);
  if (!absolute && !insidePath(root, path)) return null;
  return { path, ...(line !== undefined && line > 0 ? { line } : {}) };
}

/**
 * 统一路径分隔符为 `/` 并拼接（仅字符串层面，不代表真实文件系统）。
 * 首段保留绝对路径语义：POSIX 绝对路径（`/home/u/...`）的前导斜杠
 * 不被剥掉——否则拼出的相对路径会把后续文件操作指到进程 cwd 下
 * （非 Windows 平台 Rust 侧 userDataDir 返回的就是 `/` 开头路径）。
 */
export function joinPath(...parts: readonly string[]): string {
  if (parts.length === 0) {
    return "";
  }
  const [first, ...rest] = parts;
  const rawHead = (first ?? "").replace(/\\/g, "/");
  // 先判绝对性再去尾部斜杠：首段恰好是 "/" 时不能丢失绝对语义
  const isAbsolute = rawHead.startsWith("/");
  const head = rawHead.replace(/\/+$/, "");
  const segments = [
    head.replace(/^\/+/, ""),
    ...rest.map((part) => part.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")),
  ].filter((segment) => segment.length > 0);
  return isAbsolute ? `/${segments.join("/")}` : segments.join("/");
}
