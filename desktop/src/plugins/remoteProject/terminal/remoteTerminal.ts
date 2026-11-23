import type {
  CommandResult,
  PtySpawnOptions,
  RemoteTerminalResolver,
} from "../../host/types.ts";
import { parseRemoteProjectPath } from "../../../shared/panelPaths.ts";
import { describeUnknownError } from "../../../shared/errors.ts";
import type { RemoteProjectService } from "../service.ts";

export interface OpenSshVersion {
  readonly major: number;
  readonly minor: number;
  readonly raw: string;
}

/** 解析 `ssh -V` 输出中的 OpenSSH 版本号（例如 `OpenSSH_for_Windows_9.5p2` 或 `OpenSSH_8.9p1`）。 */
export function parseOpenSshVersion(output: string): OpenSshVersion | null {
  const match = /OpenSSH(?:_for_Windows)?[_-](\d+)\.(\d+)/i.exec(output);
  if (!match) return null;
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor, raw: match[0] };
}

export function isOpenSshAtLeast(
  version: OpenSshVersion | null,
  minMajor: number,
  minMinor: number,
): boolean {
  if (!version) return false;
  return (
    version.major > minMajor ||
    (version.major === minMajor && version.minor >= minMinor)
  );
}

export function createRemoteTerminalResolver({
  service,
  runCommand,
  notifyWarning,
}: {
  readonly service: Pick<RemoteProjectService, "getByPath" | "prepareTerminal">;
  readonly runCommand: (
    program: string,
    args: readonly string[],
  ) => Promise<CommandResult>;
  readonly notifyWarning: (message: string) => void;
}): RemoteTerminalResolver {
  let cachedVersion: Promise<OpenSshVersion | null> | null = null;

  const detectOpenSsh = (): Promise<OpenSshVersion | null> => {
    if (!cachedVersion) {
      cachedVersion = runCommand("ssh", ["-V"])
        .then((res) => parseOpenSshVersion(`${res.stdout}\n${res.stderr}`))
        .catch(() => null);
    }
    return cachedVersion;
  };

  return async (request: PtySpawnOptions): Promise<PtySpawnOptions> => {
    if (!request.cwd) return request;
    const parsed = parseRemoteProjectPath(request.cwd);
    if (!parsed) return request;

    const fallbackLocal = (reason: string): PtySpawnOptions => {
      notifyWarning(`${reason}，已回落为本地终端`);
      return { ...request, cwd: null };
    };

    const record = service.getByPath(request.cwd);
    if (!record) {
      return fallbackLocal("未找到对应的远程项目绑定记录");
    }

    const version = await detectOpenSsh();
    if (!version) {
      return fallbackLocal("本机未检测到 OpenSSH（ssh 命令不可用）");
    }

    let prep;
    try {
      prep = await service.prepareTerminal(record.connectionId, record.remoteRoot);
    } catch (error) {
      return fallbackLocal(`无法准备远端 SSH 终端：${describeUnknownError(error)}`);
    }

    if (prep.requiresAskpass && !isOpenSshAtLeast(version, 8, 4)) {
      return fallbackLocal(
        `本机 OpenSSH 版本过低（${version.raw}，自动填密需要 OpenSSH 8.4+）`,
      );
    }

    return {
      ...request,
      file: "ssh",
      args: prep.sshArgs,
      env: { ...(request.env ?? {}), ...prep.env },
      cwd: null,
    };
  };
}
