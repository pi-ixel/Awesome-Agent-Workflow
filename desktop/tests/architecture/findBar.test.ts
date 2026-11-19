import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Desktop find bar architecture", () => {
  it("uses one find bar for the chat and both document search modes", () => {
    for (const path of [
      "src/plugins/project/conversation/ui/SessionView.tsx",
      "src/plugins/documents/ui/FileDocumentTools.tsx",
    ]) {
      const code = readFileSync(path, "utf8");
      expect(code, path).toContain("shared/ui/controls/FindBar.tsx");
      expect(code, path).toContain("<FindBar");
    }
    const source = readFileSync("src/plugins/documents/ui/MarkdownSourceEditor.tsx", "utf8");
    expect(source).toContain("markdownFindExtension");
    expect(source).not.toContain("openSearchPanel");
  });
});
