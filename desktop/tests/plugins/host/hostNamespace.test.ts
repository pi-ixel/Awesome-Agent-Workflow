import { createDemoHost } from "../../../src/plugins/host/adapters/host.ts";
import { expect, it } from "vitest";

it("resolves independent agent data directories without vendor methods", async () => {
  const host = createDemoHost();
  expect(host).not.toHaveProperty("chrysSkillsDir");
  expect(host).not.toHaveProperty("chrysSessionsDir");
  await expect(host.userDataDir("alpha", "sessions")).resolves.toBe(
    "%APPDATA%/alpha/sessions",
  );
  host.setUserDataDir("alpha", "sessions", "X:/custom");
  await expect(host.userDataDir("alpha", "sessions")).resolves.toBe(
    "X:/custom",
  );
  await expect(host.userDataDir("beta", "sessions")).resolves.toBe(
    "%APPDATA%/beta/sessions",
  );
  host.reset();
  await expect(host.userDataDir("alpha", "sessions")).resolves.toBe(
    "%APPDATA%/alpha/sessions",
  );
});

it.each(["", "..", "../escape", "C:/absolute", "a\\b", ".hidden"])(
  "rejects invalid namespace or directory: %s",
  async (value) => {
    const host = createDemoHost();
    await expect(host.userDataDir(value, "sessions")).rejects.toThrow();
    await expect(host.userDataDir("alpha", value)).rejects.toThrow();
  },
);
