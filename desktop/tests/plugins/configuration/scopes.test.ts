import { expect, it } from "vitest";
import { DesktopConfiguration } from "../../../src/plugins/configuration/registry/scopes.ts";

it("隔离同一记录的字段所有权，释放后可重新登记且保留数据", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const configuration = new DesktopConfiguration(storage);
  const appearance = configuration.register("settings", ["theme"]);
  const project = configuration.register("settings", ["approval"]);
  appearance.update({ theme: "warm" });
  project.update({ approval: "ask" });
  expect(configuration.read("settings")).toEqual({
    theme: "warm",
    approval: "ask",
  });
  expect(() => configuration.register("settings", ["theme"])).toThrow(
    "无法注册",
  );
  expect(() => project.update({ theme: "dark" })).toThrow("超出作用域");

  appearance.dispose();
  expect(() => appearance.read()).toThrow("已释放");
  const replacement = configuration.register("settings", ["theme"]);
  expect(replacement.read()).toEqual({ theme: "warm" });
  configuration.dispose();
  expect(() => replacement.read()).toThrow("已释放");
  expect(JSON.parse(values.get("settings")!)).toEqual({
    theme: "warm",
    approval: "ask",
  });
});
