import { expect, it } from "vitest";
import { icodeExecutable } from "../../src/plugins/agents/enhancements/icode/launch.ts";
import { createTestAgentConfiguration } from "../helpers/agentConfiguration.ts";

it.each([undefined, "", "chrys", "   "])(
  "only the enhancement migrates legacy default %s",
  (value) => {
    const configuration = createTestAgentConfiguration();
    const settings = configuration.getState();
    settings.setAgentSettings("chrys", { executablePath: "" });
    expect(
      icodeExecutable(configuration.getState(), { chrysCommand: value }),
    ).toBe("icode");
  },
);

it("preserves an explicit legacy path and gives new configuration precedence", () => {
  const configuration = createTestAgentConfiguration();
  configuration.getState().setAgentSettings("chrys", { executablePath: "" });
  expect(
    icodeExecutable(configuration.getState(), {
      chrysCommand: "X:/old/icode.exe",
    }),
  ).toBe("X:/old/icode.exe");
  configuration
    .getState()
    .setAgentSettings("chrys", { executablePath: "Y:/new/icode.exe" });
  expect(
    icodeExecutable(configuration.getState(), {
      chrysCommand: "X:/old/icode.exe",
    }),
  ).toBe("Y:/new/icode.exe");
});
