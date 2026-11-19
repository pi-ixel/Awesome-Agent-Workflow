/**
 * src/core/host 内存宿主（测试替身）测试：内存文件树、脚本化命令与
 * 路径拼接。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDemoHost,
  createHostRuntime,
  isTauriEnv,
} from "../../../src/plugins/host/adapters/host.ts";

import { joinPath } from "../../../src/shared/panelPaths.ts";

describe("joinPath", () => {
  it("拼接并归一反斜杠与尾部斜杠", () => {
    expect(joinPath("C:/a", "b")).toBe("C:/a/b");
    expect(joinPath("C:\\a\\", "b\\c")).toBe("C:/a/b/c");
    expect(joinPath("", "x")).toBe("x");
  });

  it("保留 POSIX 绝对路径的前导斜杠（不静默改写为相对路径）", () => {
    // 回归：首段的前导斜杠曾被剥掉，非 Windows 平台 Rust 侧
    // chrysSkillsDir 返回的 /home/u/.chrys/skills 拼接后变成相对
    // 进程 cwd 的路径，技能安装落到错误位置
    expect(joinPath("/home/u/.chrys/skills", "my-skill")).toBe(
      "/home/u/.chrys/skills/my-skill",
    );
    expect(joinPath("/", "x")).toBe("/x");
    expect(joinPath("/a/", "/b/c")).toBe("/a/b/c");
    expect(joinPath()).toBe("");
  });
});

describe("demoHost 文件树", () => {
  let host = createDemoHost();

  beforeEach(() => {
    host = createDemoHost();
  });

  it("addDir / writeTextFile / pathExists / readTextFile 基本闭环", async () => {
    host.addDir("/repo/skills/aaw-workflow");
    await host.writeTextFile("/repo/skills/aaw-workflow/SKILL.md", "# AAW");
    expect(await host.pathExists("/repo/skills/aaw-workflow")).toBe(true);
    expect(await host.pathExists("/repo/skills/nope")).toBe(false);
    expect(await host.readTextFile("/repo/skills/aaw-workflow/SKILL.md")).toBe(
      "# AAW",
    );
  });

  it("listDirNames 只列子目录并按名排序", async () => {
    host.addDir("/repo/skills/zz-skill");
    host.addDir("/repo/skills/aa-skill");
    await host.writeTextFile("/repo/skills/README.md", "x");
    expect(await host.listDirNames("/repo/skills")).toEqual([
      "aa-skill",
      "zz-skill",
    ]);
  });

  it("listDirNames 对不存在目录抛错", async () => {
    await expect(host.listDirNames("/missing")).rejects.toThrow(/目录不存在/);
  });

  it("copyDir 整树复制并覆盖目标（先删后拷）", async () => {
    host.addDir("/src/skill/scripts");
    await host.writeTextFile("/src/skill/SKILL.md", "v2");
    // 目标侧预置旧内容（含目标侧才会有的多余文件），复制后应消失
    await host.writeTextFile("/dst/skill/SKILL.md", "v1");
    await host.writeTextFile("/dst/skill/stale.txt", "旧文件");

    await host.copyDir("/src/skill", "/dst/skill");

    expect(await host.readTextFile("/dst/skill/SKILL.md")).toBe("v2");
    expect(await host.pathExists("/dst/skill/scripts")).toBe(true);
    expect(await host.pathExists("/dst/skill/stale.txt")).toBe(false);
  });

  it("chrysSkillsDir 可设置并读回", async () => {
    host.setUserDataDir("chrys", "skills", "/virtual/chrys-skills");
    expect(await host.userDataDir("chrys", "skills")).toBe("/virtual/chrys-skills");
  });

  it("runCommand 命中脚本返回预置结果，未脚本化给出错误", async () => {
    host.scriptCommand("chrys.exe", ["--version"], {
      code: 0,
      stdout: "0.25.1\n",
      stderr: "",
    });
    const ok = await host.runCommand("chrys.exe", ["--version"]);
    expect(ok).toEqual({ code: 0, stdout: "0.25.1\n", stderr: "" });

    const miss = await host.runCommand("chrys.exe", ["acp"]);
    expect(miss.code).not.toBe(0);
    expect(miss.stderr).toContain("未脚本化");
  });

  it("reset 清空文件树与脚本", async () => {
    host.addDir("/x");
    host.scriptCommand("p", [], { code: 0, stdout: "", stderr: "" });
    host.reset();
    expect(await host.pathExists("/x")).toBe(false);
    const miss = await host.runCommand("p", []);
    expect(miss.code).not.toBe(0);
  });
});

describe("Host 后端工厂", () => {
  it("vitest（非 Tauri WebView）环境每次创建内存宿主", () => {
    expect(isTauriEnv()).toBe(false);
    const backend = createHostRuntime();
    expect(backend.kind).toBe("demo");
    expect(createHostRuntime()).not.toBe(backend);
  });
});
