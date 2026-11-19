import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const exec = promisify(execFile);

async function waitForVite(port: number): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("VITE_START_FAILED");
}

function pluginNames(config: { plugins?: unknown[] }): string[] {
  return (config.plugins ?? []).flatMap((plugin) => {
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
      return [];
    }
    return "name" in plugin && typeof plugin.name === "string"
      ? [plugin.name]
      : [];
  });
}

describe("TD-014 Vite 开发刷新治理", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("TD-014-U01 只作用于 Tauri 原生开发", async () => {
    vi.stubEnv("AAW_DEV_BRIDGE", "");
    vi.stubEnv("TAURI_DEV_HOST", "");
    const tauri = (await import("../../../../vite.config.ts")).default;
    expect(pluginNames(tauri)).toContain("aaw-disable-dev-client");

    vi.stubEnv("AAW_DEV_BRIDGE", "1");
    vi.resetModules();
    const web = (await import("../../../../vite.config.ts")).default;
    expect(pluginNames(web)).not.toContain("aaw-disable-dev-client");
  });

  it("TD-014-B01 客户端保留模块能力但不再自动刷新", async () => {
    const port = 14622;
    const child = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"],
      { cwd: process.cwd(), stdio: "ignore" },
    );
    try {
      await waitForVite(port);
      const response = await fetch(`http://localhost:${port}/@vite/client`);
      const source = await response.text();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(source).not.toContain("location.reload()");
      expect(source).toContain("createHotContext");
    } finally {
      if (child.pid) {
        await exec("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(
          () => undefined,
        );
      }
    }
  }, 30000);
});
