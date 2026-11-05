import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  fileHeadings,
  fileTextRanges,
} from "../../src/ui/right-panel/fileDocumentIndex.ts";
import { fileFindOwner } from "../../src/ui/right-panel/fileFindScope.ts";
import { FileDocumentTools } from "../../src/ui/right-panel/FileDocumentTools.tsx";

describe("file outline and find", () => {
  it("resizes the outline live and preserves the last move even if release precedes the frame", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    localStorage.setItem("aaw:document-outline-width", "208");
    const toolbar = document.createElement("div");
    document.body.append(toolbar);
    const view = render(
      <FileDocumentTools
        toolbar={toolbar}
        scope="resize"
        path="a.md"
        text="# A"
        markdown
        source={false}
        reveal={vi.fn()}
      >
        <h1>A</h1>
      </FileDocumentTools>,
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: "大纲" }));
      const divider = screen.getByRole("separator", { name: "调整大纲宽度" });
      Object.defineProperties(divider, {
        setPointerCapture: { value: vi.fn() },
        hasPointerCapture: { value: () => false },
      });
      fireEvent.pointerDown(divider, { button: 0, clientX: 208 });
      fireEvent.pointerMove(divider, { clientX: 300 });
      await waitFor(() =>
        expect(divider).toHaveAttribute("aria-valuenow", "300"),
      );
      // jsdom does not resolve nested CSS clamp/min/max; live geometry is
      // covered by the real-browser resize probe.
      expect(localStorage.getItem("aaw:document-outline-width")).toBe("208");
      fireEvent.pointerMove(divider, { clientX: 340 });
      fireEvent.pointerUp(divider, { clientX: 340 });
      expect(divider).toHaveAttribute("aria-valuenow", "340");
      expect(localStorage.getItem("aaw:document-outline-width")).toBe("340");
    } finally {
      view.unmount();
      toolbar.remove();
      localStorage.removeItem("aaw:document-outline-width");
      vi.unstubAllGlobals();
    }
  });
  it("parses headings with source lines, excluding fenced code and retaining duplicate titles", () => {
    expect(
      fileHeadings("# A\n\n```md\n# fake\n```\n\n## **A**\n\nSetext\n---"),
    ).toEqual([
      { title: "A", level: 1, line: 1 },
      { title: "A", level: 2, line: 7 },
      { title: "Setext", level: 2, line: 9 },
    ]);
  });
  it("matches across inline formatting, but not across paragraphs or source line numbers", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p>Hello <strong>WORLD</strong></p><p>next</p><div aria-label="文件源码"><span>123</span><code>actual</code></div>';
    expect(
      fileTextRanges(root, "hello world").map((r) => r.toString()),
    ).toEqual(["Hello WORLD"]);
    expect(fileTextRanges(root, "WORLDnext")).toHaveLength(0);
    expect(fileTextRanges(root, "123")).toHaveLength(0);
  });
  it("routes Ctrl+F to the last file pane including its portal header, and supports next/Escape", async () => {
    const reveal = vi.fn();
    const view = render(
      <>
        <button data-file-search-scope="file-a">文件顶栏</button>
        <button>会话区</button>
        <FileDocumentTools
          scope="file-a"
          path="demo.md"
          text="# A"
          markdown
          source={false}
          reveal={reveal}
        >
          <div>
            <h1>A</h1>
            <p>hello hello</p>
          </div>
        </FileDocumentTools>
      </>,
    );
    fireEvent.pointerDown(screen.getByText("文件顶栏"));
    expect(fileFindOwner(new KeyboardEvent("keydown"))).toBe("file-a");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(reveal).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);
    fireEvent.change(screen.getByLabelText("搜索当前文件"), {
      target: { value: "hello" },
    });
    await waitFor(() => expect(screen.getByText("1/2")).toBeInTheDocument());
    fireEvent.keyDown(screen.getByLabelText("搜索当前文件"), { key: "Enter" });
    expect(screen.getByText("2/2")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText("会话区"));
    expect(fileFindOwner(new KeyboardEvent("keydown"))).toBeNull();
    act(() => view.unmount());
  });
});

import { FilePreview as FileViewer } from "../../src/ui/right-panel/FilePreview.tsx";
import { panelService } from "../../src/core/panelService.ts";
// Rendering/searching >1000 jsdom rows can exceed 5s on the shared Windows
// runner. Keep the assertions and their normal async waits; allow DOM setup time.
it("searches beyond the initial 1000 source lines and clears search when changing files", async () => {
  const preview = vi.spyOn(panelService, "preview").mockResolvedValue({
    kind: "text",
    mime: "text/plain",
    bytes: 5600,
    content: Array.from({ length: 1100 }, (_, i) =>
      i === 1099 ? "unique-last-line" : "line",
    ).join("\n"),
  });
  const view = render(
    <FileViewer path="D:/a/a.txt" project="D:/a" onOpen={() => {}} />,
  );
  try {
    await screen.findByRole("button", { name: "搜索文件" });
    expect(screen.queryByText("unique-last-line")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "搜索文件" }));
    fireEvent.change(screen.getByLabelText("搜索当前文件"), {
      target: { value: "unique-last-line" },
    });
    await waitFor(() => expect(screen.getByText("1/1")).toBeInTheDocument());
    expect(screen.getByText("unique-last-line")).toBeInTheDocument();
    view.rerender(
      <FileViewer path="D:/a/b.txt" project="D:/a" onOpen={() => {}} />,
    );
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "搜索文件" }));
    expect(screen.getByLabelText("搜索当前文件")).toHaveValue("");
  } finally {
    view.unmount();
    preview.mockRestore();
  }
}, 15_000);

it("uses icon-only toolbar controls and a two-level outline with independent folding", () => {
  const toolbar = document.createElement("div");
  document.body.append(toolbar);
  const view = render(
    <FileDocumentTools
      toolbar={toolbar}
      scope="outline-test"
      path="a.md"
      text={"# Root\n## Child\n### Deep\n# Other"}
      markdown
      source={false}
      reveal={vi.fn()}
    >
      <div>
        <h1>Root</h1>
      </div>
    </FileDocumentTools>,
  );
  try {
    const toggle = screen.getByRole("button", { name: "大纲" });
    expect(toggle.textContent).toBe("");
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(toolbar.contains(toggle)).toBe(true);
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Child" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Deep" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(screen.getByRole("button", { name: "Deep" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部折叠" }));
    expect(
      screen.queryByRole("button", { name: "Child" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Root" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开 Root" }));
    expect(screen.getByRole("button", { name: "Child" })).toBeInTheDocument();
  } finally {
    view.unmount();
    toolbar.remove();
  }
});
