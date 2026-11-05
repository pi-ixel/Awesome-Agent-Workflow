import { expect, it } from "vitest";
import { icodeExecutable } from "../../src/agents/icode/launch.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";

it.each([undefined, "", "chrys", "   "])(
  "only the enhancement migrates legacy default %s",
  (value) => {
    const settings = useSettingsStore.getState();
    settings.setAgentSettings("chrys", { executablePath: "" });
    expect(
      icodeExecutable(useSettingsStore.getState(), { chrysCommand: value }),
    ).toBe("icode");
  },
);

it("preserves an explicit legacy path and gives new configuration precedence", () => {
  useSettingsStore.getState().setAgentSettings("chrys", { executablePath: "" });
  expect(
    icodeExecutable(useSettingsStore.getState(), {
      chrysCommand: "X:/old/icode.exe",
    }),
  ).toBe("X:/old/icode.exe");
  useSettingsStore
    .getState()
    .setAgentSettings("chrys", { executablePath: "Y:/new/icode.exe" });
  expect(
    icodeExecutable(useSettingsStore.getState(), {
      chrysCommand: "X:/old/icode.exe",
    }),
  ).toBe("Y:/new/icode.exe");
});
