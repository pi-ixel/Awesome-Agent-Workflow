import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const conversation = "src/plugins/project/conversation/ui/";

describe("shared Desktop hint motion", () => {
  it("routes rich cards and plain text hints through one controlled surface", () => {
    for (const path of [
      "AnnotationSummary.tsx",
      "ChatInput.tsx",
      "ConversationNavigator.tsx",
      "InputStatusBar.tsx",
      "SessionPerformanceBadge.tsx",
      "StatusTaskProgress.tsx",
      "TurnUsageBadge.tsx",
    ]
      .map((file) => conversation + file)
      .concat(
        "src/shared/ui/controls/HintTooltip.tsx",
        "src/plugins/diagnostics/ui/DiagnosticsWindow.tsx",
        "src/plugins/updates/ui/UpdateReleaseNotes.tsx",
        "src/plugins/workbench/ui/right-panel/TabOverviewPopover.tsx",
      )) {
      const code = readFileSync(path, "utf8");
      expect(code, path).toMatch(/<HintSurface\b[^>]*\bopen=/);
      expect(code, path).not.toMatch(/["'`]hint-surface\b/);
    }
  });

  it.each([
    ["ConversationNavigator.tsx", '"left"'],
    ["InputStatusBar.tsx", '"bottom"'],
    ["SessionPerformanceBadge.tsx", '"bottom"'],
    ["StatusTaskProgress.tsx", "{position.unfoldFrom}"],
    ["TurnUsageBadge.tsx", '"bottom"'],
  ])("lets %s select the shared unfolding edge", (file, edge) => {
    const code = readFileSync(conversation + file, "utf8");
    expect(code.match(/<HintSurface\b[^>]+>/)?.[0]).toContain(
      `unfoldFrom=${edge}`,
    );
  });

  it("keeps text and shortcut hints on the default fade", () => {
    for (const path of [
      conversation + "ChatInput.tsx",
      "src/shared/ui/controls/HintTooltip.tsx",
    ]) {
      const code = readFileSync(path, "utf8");
      expect(code, path).not.toContain("unfoldFrom");
    }
  });

  it.each([
    "InputStatusBar.tsx",
    "SessionPerformanceBadge.tsx",
    "TurnUsageBadge.tsx",
  ])("renders the metrics of %s with the shared counter", (file) => {
    const code = readFileSync(conversation + file, "utf8");
    expect(code).toContain("shared/ui/controls/HintNumber.tsx");
    expect(code).toContain("<HintNumber value=");
  });
});
