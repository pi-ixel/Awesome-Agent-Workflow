import { useEffect, useMemo, useRef } from "react";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { pathKey } from "../../../shared/panelPaths.ts";
import { useStore } from "zustand";
import type { DocumentEditor } from "../types.ts";
export interface MarkdownEditorApi {
  reveal: (line: number) => void;
  search: () => void;
  selection: () => {
    from: number;
    to: number;
    startLine: number;
    endLine: number;
  } | null;
  select: (from: number, to: number) => void;
  range: (from: number, to: number) => Range | null;
}

/** CodeMirror creates its own fold and search hints outside React. */
function connectEditorHints(root: HTMLElement) {
  const translate = () => {
    for (const element of root.querySelectorAll<HTMLElement>("[title]")) {
      const label = element.getAttribute("title");
      if (label) element.dataset.hint = label;
      element.removeAttribute("title");
    }
  };
  translate();
  const observer = new MutationObserver(translate);
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["title"],
  });
  return () => observer.disconnect();
}
const lineNumbers = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged)
        this.decorations = this.build(update.view);
    }
    build(view: EditorView) {
      const lines = new Set<number>();
      for (const range of view.visibleRanges)
        for (let at = range.from; at <= range.to;) {
          const line = view.state.doc.lineAt(at);
          lines.add(line.from);
          at = line.to + 1;
        }
      return Decoration.set(
        [...lines]
          .sort((a, b) => a - b)
          .map((at) =>
            Decoration.line({
              attributes: {
                "data-file-line": String(view.state.doc.lineAt(at).number),
              },
            }).range(at),
          ),
      );
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--color-ink)",
    backgroundColor: "var(--color-base)",
    fontSize: "var(--text-ui-base)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono)",
    lineHeight: "1.75",
  },
  ".cm-content": { caretColor: "var(--color-ink)", padding: "8px 0" },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": {
    backgroundColor: "var(--color-base)",
    color: "var(--color-ink-subtlest)",
    borderRight: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "3ch",
    padding: "0 8px 0 12px",
    fontSize: "var(--text-ui-sm)",
    lineHeight: "calc(var(--text-ui-base) * 1.75)",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-foldGutter": { width: "20px" },
  ".cm-foldGutter .cm-gutterElement": { textAlign: "center" },
  // Opacity keeps the fold target and its width stable while the pointer moves.
  ".cm-foldGutter span[data-hint]": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "16px",
    height: "16px",
    padding: "0",
    borderRadius: "4px",
    verticalAlign: "middle",
    fontSize: "0",
    color: "var(--color-ink-subtle)",
    opacity: "0",
  },
  ".cm-foldGutter span[data-hint]::before": {
    content: '""',
    width: "4px",
    height: "4px",
    borderRight: "1.5px solid currentColor",
    borderBottom: "1.5px solid currentColor",
    transform: "translateY(-1px) rotate(45deg)",
  },
  '.cm-gutters:hover .cm-foldGutter span[data-hint], .cm-foldGutter span[data-hint="展开此处"]':
    { opacity: "1" },
  '.cm-foldGutter span[data-hint="展开此处"]::before': {
    transform: "translateX(-1px) rotate(-45deg)",
  },
  ".cm-foldGutter span[data-hint]:hover": {
    color: "var(--color-ink)",
    backgroundColor: "var(--color-selected)",
  },
  "@media (hover: none)": {
    ".cm-foldGutter span[data-hint]": { opacity: "1" },
  },
  ".cm-cursor": { borderLeftColor: "var(--color-ink)" },
  ".cm-activeLine": {
    backgroundColor: "var(--color-selected)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--color-ink)",
    fontWeight: "500",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--color-selected)" },
  ".cm-panels": {
    color: "var(--color-ink)",
    backgroundColor: "var(--color-surface)",
    borderColor: "var(--color-line)",
  },
  ".cm-textfield": {
    color: "var(--color-ink)",
    backgroundColor: "var(--color-base)",
    borderColor: "var(--color-line)",
  },
  ".cm-button": {
    color: "var(--color-ink)",
    backgroundImage: "none",
    backgroundColor: "var(--color-raised)",
    borderColor: "var(--color-line)",
  },
});
const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, color: "var(--color-accent-ink)", fontWeight: "600" },
    {
      tag: tags.link,
      color: "var(--color-accent-ink)",
      textDecoration: "underline",
    },
    { tag: tags.monospace, color: "var(--color-ok-ink)" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "bold" },
  ]),
);
export function MarkdownSourceEditor({
  editor,
  path,
  wrap,
  active,
  onReady,
}: {
  editor: DocumentEditor;
  path: string;
  wrap: boolean;
  active: boolean;
  onReady: (api: MarkdownEditorApi | null) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    viewRef = useRef<EditorView | null>(null);
  const wrapping = useMemo(() => new Compartment(), []);
  const value = useStore(
    editor.state,
    (state) => state.documents[pathKey(path)]?.text ?? "",
  );
  useEffect(() => {
    const view = new EditorView({
      parent: root.current!,
      state: EditorState.create({
        doc: editor.state.getState().documents[pathKey(path)]?.text ?? "",
        extensions: [
          basicSetup,
          EditorState.phrases.of({
            Find: "查找",
            Replace: "替换",
            next: "下一个",
            previous: "上一个",
            all: "全部",
            "match case": "区分大小写",
            regexp: "正则表达式",
            "by word": "全词匹配",
            replace: "替换",
            "replace all": "全部替换",
            close: "关闭",
            "Fold line": "折叠此处",
            "Unfold line": "展开此处",
          }),
          markdown(),
          highlight,
          editorTheme,
          lineNumbers,
          wrapping.of(EditorView.lineWrapping),
          EditorView.contentAttributes.of({
            "aria-label": "Markdown 源码编辑器",
            "aria-multiline": "true",
          }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                void editor.save(path);
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              editor.edit(path, update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    const disconnectHints = connectEditorHints(view.dom);
    onReady({
      selection: () => {
        const selected = view.state.selection.main;
        return selected.empty
          ? null
          : {
              from: selected.from,
              to: selected.to,
              startLine: view.state.doc.lineAt(selected.from).number,
              endLine: view.state.doc.lineAt(selected.to).number,
            };
      },
      select: (from, to) => {
        view.dispatch({
          selection: { anchor: from, head: to },
          effects: EditorView.scrollIntoView(from, { y: "center" }),
        });
        view.focus();
      },
      range: (from, to) => {
        if (
          !view.visibleRanges.some(
            (range) => from >= range.from && to <= range.to,
          )
        )
          return null;
        try {
          const start = view.domAtPos(from),
            end = view.domAtPos(to),
            range = document.createRange();
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
          return range;
        } catch {
          return null;
        }
      },
      reveal: (line) => {
        const target = view.state.doc.line(
          Math.max(1, Math.min(view.state.doc.lines, line)),
        );
        view.dispatch({
          selection: { anchor: target.from },
          effects: EditorView.scrollIntoView(target.from, { y: "center" }),
        });
        view.focus();
      },
      search: () => {
        view.focus();
        openSearchPanel(view);
      },
    });
    return () => {
      disconnectHints();
      onReady(null);
      viewRef.current = null;
      view.destroy();
    };
  }, [editor, path, onReady, wrapping]);
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
  }, [value]);
  // A new document/view needs the current preference even when wrap itself
  // has not changed. Reconfiguring preserves the editor's selection/undo.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap, wrapping, path, onReady]);
  useEffect(() => {
    if (active) {
      viewRef.current?.requestMeasure();
      viewRef.current?.focus();
    }
  }, [active]);
  return (
    <div
      ref={root}
      className="h-full min-h-0 min-w-0 flex-1 overflow-hidden"
      data-markdown-editor
    />
  );
}
