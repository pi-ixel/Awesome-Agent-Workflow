/**
 * 工具插件的文件端口：把 `HostService` 收窄成 `runtime/` 里那组纯函数要的样子。
 *
 * 为什么单独一层：`runtime/project.ts`、`runtime/backup.ts` 都是可以单测的纯
 * 逻辑，它们不该知道 Tauri、也不该知道 Cordis；测试里塞一个内存实现即可。
 */
import type { HostService } from "../../host/service.ts";
import type { ToolProjectIO } from "./project.ts";

export function hostToolIO(host: HostService): ToolProjectIO {
  return {
    userDataDir: (namespace, directory) => host.skills.userDataDir(namespace, directory),
    pathExists: (path) => host.skills.pathExists(path),
    listDirNames: (path) => host.skills.listDirNames(path),
    readTextFile: (path) => host.archives.readTextFile(path),
    writeTextFile: (path, contents) => host.skills.writeTextFile(path, contents),
    movePath: (from, to) => host.skills.moveToolPath(from, to),
    ...(host.skills.dropToolStaging
      ? { dropStaging: (path) => host.skills.dropToolStaging!(path) }
      : {}),
    ...(host.skills.writeBinaryFile
      ? { writeBinaryFile: (path, base64) => host.skills.writeBinaryFile!(path, base64) }
      : {}),
    ...(host.skills.readBinaryFile
      ? { readBinaryFile: (path, limit) => host.skills.readBinaryFile!(path, limit) }
      : {}),
    ...(host.skills.listToolFiles
      ? { listFiles: (root, limit) => host.skills.listToolFiles!(root, limit) }
      : {}),
    // 开发指导正文：桌面宿主才提供；缺省时 AGENTS.md 退回编译模板。
    ...(host.skills.readGuideDoc ? { readGuideDoc: () => host.skills.readGuideDoc!() } : {}),
  };
}

/** 内存实现：测试与"没有宿主"的预览环境共用。 */
export function memoryToolIO(seed: Readonly<Record<string, string>> = {}): ToolProjectIO & {
  readonly files: Map<string, string>;
} {
  const files = new Map(Object.entries(seed));
  const dirs = new Set<string>();
  const parentOf = (path: string) => path.replace(/[\\/][^\\/]+$/, "");
  return {
    files,
    userDataDir: (namespace, directory) => Promise.resolve(`${namespace}/${directory}`),
    pathExists: (path) => Promise.resolve(files.has(path) || dirs.has(path)),
    listDirNames: (path) => Promise.resolve([...dirs]
      .filter((dir) => parentOf(dir) === path)
      .map((dir) => dir.replace(/^.*[\\/]/, ""))),
    readTextFile: (path) => {
      const text = files.get(path);
      return text === undefined
        ? Promise.reject(new Error(`文件不存在：${path}`))
        : Promise.resolve(text);
    },
    writeTextFile: (path, contents) => {
      files.set(path, contents);
      let child = path;
      for (let dir = parentOf(child); dir && dir !== child; dir = parentOf(child)) {
        dirs.add(dir);
        child = dir;
      }
      return Promise.resolve();
    },
    movePath: (from, to) => {
      const text = files.get(from);
      if (text !== undefined) {
        files.delete(from);
        files.set(to, text);
        return Promise.resolve();
      }
      const moved = [...files].filter(([path]) => path.startsWith(`${from}/`));
      if (!moved.length && !dirs.has(from)) return Promise.reject(new Error(`路径不存在：${from}`));
      for (const [path, value] of moved) {
        files.delete(path);
        files.set(`${to}${path.slice(from.length)}`, value);
      }
      for (const dir of [...dirs]) {
        if (dir !== from && !dir.startsWith(`${from}/`)) continue;
        dirs.delete(dir);
        dirs.add(`${to}${dir.slice(from.length)}`);
      }
      return Promise.resolve();
    },
    dropStaging: (path) => {
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      }
      for (const dir of [...dirs]) {
        if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
      }
      return Promise.resolve();
    },
  };
}
