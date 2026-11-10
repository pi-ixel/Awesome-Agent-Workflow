import { beforeEach, expect, it } from "vitest";
import {
  displayTitleOf,
  setManualTitle,
} from "../../src/plugins/project/sessions/sessionTitles.ts";

beforeEach(() => localStorage.clear());

it("isolates identical session IDs and does not attribute legacy titles to another agent", () => {
  setManualTitle("same", "legacy");
  expect(displayTitleOf("same", "native B", "agent-b")).toBe("native B");
  setManualTitle("same", "manual A", "agent-a");
  setManualTitle("same", "manual B", "agent-b");
  expect(displayTitleOf("same", "updated A", "agent-a")).toBe("manual A");
  expect(displayTitleOf("same", "updated B", "agent-b")).toBe("manual B");
  setManualTitle("same", "", "agent-a");
  expect(displayTitleOf("same", "updated A", "agent-a")).toBe("updated A");
  expect(displayTitleOf("same", "updated B", "agent-b")).toBe("manual B");
});
