import type { BrowserElement } from "../../src/contracts/browser/types.ts";

export const browserElement: BrowserElement = {
  referenceId: "element-1",
  sessionId: "session-a",
  tabId: "tab-1",
  tabGeneration: 1,
  url: "https://local.test/fixture",
  role: "button",
  selector: "#target",
  xpath: "/html/body/button[1]",
  text: "点击验证",
  rect: { x: 12, y: 24, width: 96, height: 32 },
  style: { display: "block", position: "static", visibility: "visible" },
  framePath: [],
};
