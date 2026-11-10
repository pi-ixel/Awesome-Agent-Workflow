import { icodeSkillInstallation } from "../../src/plugins/agents/enhancements/icode/skillsInstaller.ts";
/**
 * src/stores/skillsStore 测试：扫描清单镜像、安装流程状态流转、
 * 失败路径与在途扫描的过期丢弃。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createDemoHost } from "../../src/plugins/host/adapters/host.ts";
import { createSkillsStore } from "../../src/plugins/skills/sources/store.ts";

const demoHost = createDemoHost();

const sourceDir = "/repo/skills";
const destDir = "/appdata/chrys/skills";

function seedSource(): void {
  for (const name of ["aaw-workflow", "code-check"]) {
    demoHost.addDir(`${sourceDir}/${name}`);
  }
}

let skillsStore: ReturnType<typeof createSkillsStore>["store"];

describe("skillsStore", () => {
  beforeEach(() => {
    demoHost.reset();
    seedSource();
    demoHost.setUserDataDir("chrys", "skills", destDir);
    skillsStore = createSkillsStore(demoHost).store;
  });

  it("rescan 解析目标目录并镜像清单（含已安装检测）", async () => {
    demoHost.addDir(`${destDir}/code-check`);
    await skillsStore.getState().rescan(sourceDir, icodeSkillInstallation);
    const state = skillsStore.getState();
    expect(state.destDir).toBe(destDir);
    expect(state.isScanning).toBe(false);
    expect(
      state.entries.map((entry) => [entry.name, entry.isInstalled]),
    ).toEqual([
      ["aaw-workflow", false],
      ["code-check", true],
    ]);
  });

  it("rescan 源目录缺失时给出错误而不是空清单", async () => {
    await skillsStore.getState().rescan("/missing", icodeSkillInstallation);
    const state = skillsStore.getState();
    expect(state.isScanning).toBe(false);
    expect(state.lastError).toContain("目录不存在");
  });

  it("install 逐项复制、刷新清单并给出汇总", async () => {
    await skillsStore.getState().rescan(sourceDir, icodeSkillInstallation);
    await skillsStore.getState().install(sourceDir, icodeSkillInstallation);
    const state = skillsStore.getState();
    expect(state.isInstalling).toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.lastInstallSummary).toContain("已安装 2 项");
    expect(state.entries.every((entry) => entry.isInstalled)).toBe(true);
    expect(await demoHost.pathExists(`${destDir}/.aaw-target`)).toBe(true);
  });

  it("install 期间进度经归约器推进（领域回调 → store 状态）", async () => {
    // 直接订阅 store：zustand 每次 set 同步通知，进度序列可确定性断言
    const seen: { done: number; total: number }[] = [];
    const unsubscribe = skillsStore.subscribe((state) => {
      if (state.progress !== null) {
        seen.push({ done: state.progress.done, total: state.progress.total });
      }
    });
    await skillsStore.getState().install(sourceDir, icodeSkillInstallation);
    unsubscribe();
    expect(seen.some((p) => p.done === 1 && p.total === 2)).toBe(true);
    expect(seen[seen.length - 1]).toEqual({ done: 2, total: 2 });
    expect(skillsStore.getState().isInstalling).toBe(false);
  });

  it("install 失败：lastError 置位且 isInstalling 复位", async () => {
    await skillsStore.getState().install("/missing", icodeSkillInstallation);
    const state = skillsStore.getState();
    expect(state.isInstalling).toBe(false);
    expect(state.lastError).toContain("目录不存在");
  });

  it("在途扫描过期丢弃：更新的扫描落地后，旧扫描完成不得覆盖（回归：交叠完成旧结果曾覆盖新清单）", async () => {
    // 真实扫描 A（sourceB）在途：同步段执行到首个 await 为止
    const sourceA = "/repo/skills-a";
    const sourceB = "/repo/skills-b";
    demoHost.addDir(`${sourceA}/alpha-skill`);
    demoHost.addDir(`${sourceB}/beta-skill`);
    const inFlight = skillsStore
      .getState()
      .rescan(sourceA, icodeSkillInstallation);
    // 更新的扫描 B 先后启动并完成：推进扫描序列号并落地自己的清单
    await skillsStore.getState().rescan(sourceB, icodeSkillInstallation);
    // 在途扫描 A 随后完成：结果已过期，不得覆盖
    await inFlight;
    expect(skillsStore.getState().entries).toEqual([
      { name: "beta-skill", isInstalled: false },
    ]);
    expect(skillsStore.getState().isScanning).toBe(false);
  });
});
