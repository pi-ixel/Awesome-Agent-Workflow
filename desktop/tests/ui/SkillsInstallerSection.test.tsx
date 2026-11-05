/**
 * src/ui/SkillsInstallerSection 测试：挂载自动检测、清单与已安装标记、
 * 覆盖确认流程、安装进度与结果反馈。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import SkillsInstallerSection from "../../src/ui/SkillsInstallerSection";
import { demoHost } from "../../src/core/host";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useSkillsStore } from "../../src/stores/skillsStore";

const sourceDir = "/repo/skills";
const destDir = "/appdata/chrys/skills";

function seedStore(): void {
  useSkillsStore.setState({
    destDir: null,
    entries: [],
    isScanning: false,
    isInstalling: false,
    progress: null,
    lastError: null,
    lastInstallSummary: null,
  });
}

function seedFs(withPreinstalled: boolean): void {
  demoHost.reset();
  demoHost.setUserDataDir("chrys", "skills", destDir);
  for (const name of ["aaw-workflow", "code-check"]) {
    demoHost.addDir(`${sourceDir}/${name}`);
  }
  if (withPreinstalled) {
    demoHost.addDir(`${destDir}/aaw-workflow`);
  }
}

describe("SkillsInstallerSection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useSettingsStore.getState().setSkillsSourceDir(sourceDir);
    seedStore();
  });

  it("挂载即自动检测：展示清单、已安装计数与目标目录", async () => {
    seedFs(true);
    render(<SkillsInstallerSection />);
    expect(await screen.findByText("aaw-workflow")).toBeInTheDocument();
    expect(screen.getByText("code-check")).toBeInTheDocument();
    expect(
      screen.getByText("共 2 项 skills · 已安装 1 项"),
    ).toBeInTheDocument();
    // aaw-workflow 行内带「已安装」标记，code-check 带「未安装」
    const list = screen.getByTestId("skills-list");
    expect(list.textContent).toContain("已安装");
    expect(list.textContent).toContain("未安装");
    expect(screen.getByText(destDir)).toBeInTheDocument();
  });

  it("无已装项时点击安装直接执行并给出汇总", async () => {
    seedFs(false);
    render(<SkillsInstallerSection />);
    await screen.findByText("code-check");
    await userEvent.click(
      screen.getByRole("button", { name: "安装 / 更新 AAW skills" }),
    );
    expect(await screen.findByText(/已安装 2 项 skills/)).toBeInTheDocument();
    expect(await demoHost.pathExists(`${destDir}/.aaw-target`)).toBe(true);
  });

  it("已有同名 skills 时先弹覆盖确认，确认后才安装", async () => {
    seedFs(true);
    render(<SkillsInstallerSection />);
    await screen.findByText("aaw-workflow");
    await userEvent.click(
      screen.getByRole("button", { name: "安装 / 更新 AAW skills" }),
    );
    // 确认条出现且尚未复制
    const confirm = screen.getByRole("alertdialog", { name: "覆盖确认" });
    expect(confirm.textContent).toContain("1 项同名");
    expect(await demoHost.pathExists(`${destDir}/code-check`)).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "确认覆盖安装" }));
    expect(await screen.findByText(/已安装 2 项 skills/)).toBeInTheDocument();
    expect(await demoHost.pathExists(`${destDir}/code-check`)).toBe(true);
  });

  it("覆盖确认可取消（不执行复制）", async () => {
    seedFs(true);
    render(<SkillsInstallerSection />);
    await screen.findByText("aaw-workflow");
    await userEvent.click(
      screen.getByRole("button", { name: "安装 / 更新 AAW skills" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(
      screen.queryByRole("alertdialog", { name: "覆盖确认" }),
    ).not.toBeInTheDocument();
    expect(await demoHost.pathExists(`${destDir}/code-check`)).toBe(false);
  });

  it("源目录缺失时展示扫描错误", async () => {
    seedFs(false);
    useSettingsStore.getState().setSkillsSourceDir("/missing");
    render(<SkillsInstallerSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/目录不存在/);
  });
});
