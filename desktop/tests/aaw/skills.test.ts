/**
 * src/aaw/skills 领域逻辑测试：清单扫描（已安装检测）、安装/更新
 * （覆盖复制 + .aaw-target 标记）与进度回调，对齐 install.sh 的行为。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createDemoHost } from "../../src/plugins/host/adapters/host.ts";
import {
  aawTargetMarker,
  aawTargetMarkerContent,
  installSkills,
  scanSkills,
  type InstallSkillsProgress,
} from "../../src/plugins/agents/enhancements/icode/skillsInstaller";
import { LogSink } from "../../src/plugins/diagnostics/capture/logSink.ts";

const demoHost = createDemoHost();

const sourceDir = "/repo/skills";
const destDir = "/appdata/chrys/skills";

function seedSource(): void {
  for (const name of ["aaw-workflow", "code-check", "repo-init"]) {
    demoHost.addDir(`${sourceDir}/${name}`);
  }
}

describe("scanSkills", () => {
  beforeEach(() => {
    demoHost.reset();
    seedSource();
    demoHost.setUserDataDir("chrys", "skills", destDir);
  });

  it("列出源目录全部子目录并检测目标侧已安装状态", async () => {
    demoHost.addDir(`${destDir}/aaw-workflow`);
    const entries = await scanSkills(demoHost, sourceDir, destDir);
    expect(entries.map((entry) => entry.name)).toEqual([
      "aaw-workflow",
      "code-check",
      "repo-init",
    ]);
    expect(
      entries.find((entry) => entry.name === "aaw-workflow")?.isInstalled,
    ).toBe(true);
    expect(
      entries.find((entry) => entry.name === "code-check")?.isInstalled,
    ).toBe(false);
  });

  it("源目录不存在时抛错（配错路径应立即可见）", async () => {
    await expect(scanSkills(demoHost, "/missing", destDir)).rejects.toThrow(
      /目录不存在/,
    );
  });
});

describe("installSkills", () => {
  beforeEach(() => {
    demoHost.reset();
    seedSource();
    demoHost.setUserDataDir("chrys", "skills", destDir);
  });

  it("逐项复制到目标目录并写入 .aaw-target 标记（内容 chrys）", async () => {
    await demoHost.writeTextFile(
      `${sourceDir}/repo-init/SKILL.md`,
      "# repo-init",
    );
    const { total } = await installSkills(demoHost, { sourceDir, destDir });
    expect(total).toBe(3);
    for (const name of ["aaw-workflow", "code-check", "repo-init"]) {
      expect(await demoHost.pathExists(`${destDir}/${name}`)).toBe(true);
    }
    expect(await demoHost.readTextFile(`${destDir}/${aawTargetMarker}`)).toBe(
      aawTargetMarkerContent,
    );
    expect(await demoHost.readTextFile(`${destDir}/repo-init/SKILL.md`)).toBe(
      "# repo-init",
    );
  });

  it("覆盖安装：目标侧旧文件被替换", async () => {
    await demoHost.writeTextFile(`${sourceDir}/code-check/SKILL.md`, "new");
    await demoHost.writeTextFile(`${destDir}/code-check/SKILL.md`, "old");
    await installSkills(demoHost, { sourceDir, destDir });
    expect(await demoHost.readTextFile(`${destDir}/code-check/SKILL.md`)).toBe(
      "new",
    );
  });

  it("进度回调单调推进并在收尾达到 done === total", async () => {
    const progressList: InstallSkillsProgress[] = [];
    await installSkills(demoHost, {
      sourceDir,
      destDir,
      onProgress: (progress) => {
        progressList.push(progress);
      },
    });
    const last = progressList[progressList.length - 1];
    expect(last).toEqual({ done: 3, total: 3, current: "repo-init" });
    // 每项技能都有「开始复制」与「复制完成」两次回调
    expect(progressList.length).toBe(1 + 3 * 2);
  });

  it("空源目录抛错", async () => {
    demoHost.addDir("/empty-skills");
    await expect(
      installSkills(demoHost, { sourceDir: "/empty-skills", destDir }),
    ).rejects.toThrow(/源目录为空或不存在/);
  });

  it("安装过程写入 aaw 通道结构化日志", async () => {
    const logs = new LogSink();
    await installSkills(demoHost, { sourceDir, destDir }, logs.createLogger("aaw"));
    expect(
      logs
        .snapshot()
        .some(
          (entry) =>
            entry.channel === "aaw" && entry.message === "AAW skills 安装完成",
        ),
    ).toBe(true);
  });
});
