import { createTestDocuments } from "../helpers/documents.ts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FilePreview } from "../../src/plugins/documents/ui/FilePreview.tsx";
import { MarkdownSourceEditor } from "../../src/plugins/documents/ui/MarkdownSourceEditor.tsx";
import { panelService } from "../../src/plugins/host/filesystem/panelService.ts";



let documents: ReturnType<typeof createTestDocuments>;
beforeEach(() => { documents = createTestDocuments(); });
afterEach(() => {
  documents.dispose();
  vi.restoreAllMocks();
});

it("Markdown source wraps by default and its menu can disable wrapping without replacing the editor", async () => {
  vi.spyOn(panelService, "preview").mockResolvedValue({
    kind: "text",
    content: "# Wrapping\n\nA long paragraph for editing.",
    bytes: 42,
    mime: "text/plain",
  });
  vi.spyOn(panelService, "watch").mockResolvedValue(() => {});
  render(
    <FilePreview
      documents={documents}
      path="D:/wrap/default.md"
      project="D:/wrap"
      onOpen={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "切换到源码" }));
  const editor = screen.getByRole("textbox", { name: "Markdown 源码编辑器" });
  expect(editor).toHaveClass("cm-lineWrapping");
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  const wrap = screen.getByRole("menuitemradio", { name: "自动换行" });
  expect(wrap).toHaveAttribute("aria-checked", "true");
  fireEvent.click(wrap);
  await waitFor(() => expect(editor).not.toHaveClass("cm-lineWrapping"));
  expect(screen.getByRole("textbox", { name: "Markdown 源码编辑器" })).toBe(
    editor,
  );
  expect(editor.textContent).toContain("A long paragraph for editing.");
});

it("reapplies the wrapping preference after a document change and toggles without remounting", () => {
  const onReady = vi.fn();
  const view = render(
    <MarkdownSourceEditor
      editor={documents.editor}
      path="D:/wrap/a.md"
      wrap={false}
      active={false}
      onReady={onReady}
    />,
  );
  expect(
    screen.getByRole("textbox", { name: "Markdown 源码编辑器" }),
  ).not.toHaveClass("cm-lineWrapping");
  view.rerender(
    <MarkdownSourceEditor
      editor={documents.editor}
      path="D:/wrap/b.md"
      wrap={false}
      active={false}
      onReady={onReady}
    />,
  );
  const editor = screen.getByRole("textbox", { name: "Markdown 源码编辑器" });
  expect(editor).not.toHaveClass("cm-lineWrapping");
  view.rerender(
    <MarkdownSourceEditor
      editor={documents.editor}
      path="D:/wrap/b.md"
      wrap
      active={false}
      onReady={onReady}
    />,
  );
  expect(editor).toHaveClass("cm-lineWrapping");
  expect(screen.getByRole("textbox", { name: "Markdown 源码编辑器" })).toBe(
    editor,
  );
});
