import { describe, expect, it, vi } from "vitest";
import {
  createRemoteTerminalResolver,
  isOpenSshAtLeast,
  parseOpenSshVersion,
} from "../../../src/plugins/remoteProject/terminal/remoteTerminal.ts";
import { formatRemoteProjectPath } from "../../../src/shared/panelPaths.ts";
import type { RemoteProjectRecord } from "../../../src/plugins/remoteProject/types.ts";

const record: RemoteProjectRecord = {
  projectId: "rp_term",
  connectionId: "conn-term",
  remoteRoot: "/srv/app",
  workspacePath: formatRemoteProjectPath("rp_term", "/srv/app"),
  agentCwd: "remote-projects/rp_term",
  name: "app",
  createdAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: "2026-01-01T00:00:00Z",
};

describe("Iteration 3: OpenSSH remote terminal resolver & fallback", () => {
  it("正确解析 Windows 与 Linux OpenSSH 版本并比较 >= 8.4", () => {
    const win95 = parseOpenSshVersion("OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2");
    expect(win95).toEqual({ major: 9, minor: 5, raw: "OpenSSH_for_Windows_9.5" });
    expect(isOpenSshAtLeast(win95, 8, 4)).toBe(true);

    const win81 = parseOpenSshVersion("OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2");
    expect(isOpenSshAtLeast(win81, 8, 4)).toBe(false);

    const linux89 = parseOpenSshVersion("OpenSSH_8.9p1 Ubuntu-3ubuntu0.10");
    expect(isOpenSshAtLeast(linux89, 8, 4)).toBe(true);

    expect(parseOpenSshVersion("not openssh")).toBeNull();
  });

  it("OpenSSH >= 8.4 时直接通过 ssh.exe + SSH_ASKPASS 启动远端终端", async () => {
    const notifyWarning = vi.fn();
    const resolver = createRemoteTerminalResolver({
      service: {
        getByPath: (p) => (p === record.workspacePath ? record : null),
        prepareTerminal: vi.fn().mockResolvedValue({
          sshArgs: ["-t", "-p", "22", "alice@10.0.0.1", "cd '/srv/app' && exec ${SHELL:-/bin/sh} -l"],
          env: {
            SSH_ASKPASS: "C:/ops-sidecar.exe",
            SSH_ASKPASS_REQUIRE: "force",
            AAW_ASKPASS_URL: "http://127.0.0.1:50000/project-askpass",
            AAW_ASKPASS_TOKEN: "ask-tok",
          },
          knownHostsPath: "C:/kh",
          authType: "password",
          requiresAskpass: true,
          summary: "alice@10.0.0.1:22",
        }),
      },
      runCommand: vi.fn().mockResolvedValue({
        code: 0,
        stdout: "",
        stderr: "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2",
      }),
      notifyWarning,
    });

    const out = await resolver({ cwd: record.workspacePath, cols: 120, rows: 30 });
    expect(notifyWarning).not.toHaveBeenCalled();
    expect(out.file).toBe("ssh");
    expect(out.args).toContain("alice@10.0.0.1");
    expect(out.env?.["SSH_ASKPASS_REQUIRE"]).toBe("force");
    expect(out.cwd).toBeNull();
  });

  it("OpenSSH 版本低于 8.4 且需要自动填密时，弹出提示并回落到本地终端", async () => {
    const notifyWarning = vi.fn();
    const resolver = createRemoteTerminalResolver({
      service: {
        getByPath: (p) => (p === record.workspacePath ? record : null),
        prepareTerminal: vi.fn().mockResolvedValue({
          sshArgs: ["-t", "alice@10.0.0.1"],
          env: { SSH_ASKPASS_REQUIRE: "force" },
          knownHostsPath: "C:/kh",
          authType: "password",
          requiresAskpass: true,
          summary: "alice@10.0.0.1:22",
        }),
      },
      runCommand: vi.fn().mockResolvedValue({
        code: 0,
        stdout: "",
        stderr: "OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2",
      }),
      notifyWarning,
    });

    const out = await resolver({ cwd: record.workspacePath, cols: 80, rows: 24 });
    expect(notifyWarning).toHaveBeenCalledWith(expect.stringContaining("8.4+"));
    expect(out.file).toBeUndefined();
    expect(out.cwd).toBeNull();
  });

  it("本机未安装 OpenSSH 时弹出提示并回落到本地终端，本地路径请求不受影响", async () => {
    const notifyWarning = vi.fn();
    const resolver = createRemoteTerminalResolver({
      service: {
        getByPath: (p) => (p === record.workspacePath ? record : null),
        prepareTerminal: vi.fn(),
      },
      runCommand: vi.fn().mockRejectedValue(new Error("ENOENT")),
      notifyWarning,
    });

    const localOut = await resolver({ cwd: "D:/dev/local", cols: 80, rows: 24 });
    expect(localOut.cwd).toBe("D:/dev/local");
    expect(notifyWarning).not.toHaveBeenCalled();

    const remoteOut = await resolver({ cwd: record.workspacePath, cols: 80, rows: 24 });
    expect(notifyWarning).toHaveBeenCalledWith(expect.stringContaining("未检测到 OpenSSH"));
    expect(remoteOut.file).toBeUndefined();
    expect(remoteOut.cwd).toBeNull();
  });
});
