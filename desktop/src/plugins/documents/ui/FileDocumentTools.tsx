import { UiIcon } from "../../../shared/ui/UiIcon.tsx";
import { CollapsibleTreePane, TreeBranch, treeChevronClass } from "../../../shared/ui/TreeMotion.tsx";
import type { DocumentsService } from "../service.ts";
import { webviewStorage } from "../../host/service.ts";
import type { MarkdownEditorApi } from "./MarkdownSourceEditor.tsx";
import { FileAnnotations } from "./FileAnnotations.tsx";
import { createPortal } from "react-dom";
import { SearchIcon, ChevronRightIcon, EllipsisIcon } from "../../../shared/ui/icons.tsx";
import { FindBar, findActionClass, findFieldClass } from "../../../shared/ui/controls/FindBar.tsx";
import { ContextMenu } from "../../../shared/ui/ContextMenu.tsx";
import { useMenuController } from "./file-tree/menuController.ts";
import type { MarkdownFindOption } from "./markdownFind.ts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useFrameTask } from "../../../shared/ui/controls/useFrameTask.ts";
import { fileHeadings, fileTextRanges } from "./fileDocumentIndex.ts";

const OUTLINE_WIDTH_KEY = "aaw:document-outline-width";
const DEFAULT_OUTLINE_WIDTH = 208;
const noFindSubscription = () => () => {};
const noFindSnapshot = () => null;
const markdownFindOptions: readonly { key: MarkdownFindOption; label: string }[] = [
  { key: "caseSensitive", label: "区分大小写" },
  { key: "regexp", label: "正则表达式" },
  { key: "wholeWord", label: "全词匹配" },
];
// The percentage resolves against the split row; the width follows outer pane
// resizing without observer-backed React state or inherited CSS variables.
function outlineWidthStyle(width: number) {
  const max = "max(100px, min(560px, 60cqw, calc(100cqw - 200px)))";
  return `clamp(min(144px, ${max}), ${width}px, ${max})`;
}
function readOutlineWidth() {
  try {
    const stored = Number(webviewStorage.getItem(OUTLINE_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= 100 && stored <= 560)
      return stored;
  } catch {
    // Storage may be unavailable; resizing still works for this open document.
  }
  return DEFAULT_OUTLINE_WIDTH;
}

export function FileDocumentTools({
  documents,
  editor,
  toolbar,
  project,
  scope,
  path,
  text,
  markdown,
  source,
  reveal,
  children,
}: {
  documents: DocumentsService;
  editor?: MarkdownEditorApi | null;
  toolbar?: HTMLElement | null;
  project?: string;
  scope: string;
  path: string;
  text: string;
  markdown: boolean;
  source: boolean;
  reveal: (line: number) => void;
  children: ReactNode;
}) {
  const [outline, setOutline] = useState(false);
  const [outlineMounted, setOutlineMounted] = useState(false);
  if (outline && !outlineMounted) setOutlineMounted(true);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [section, setSection] = useState(0);
  const [preferredWidth, setPreferredWidth] = useState(readOutlineWidth);
  const [resizingOutline, setResizingOutline] = useState(false);
  const splitRow = useRef<HTMLDivElement>(null);
  const outlineColumn = useRef<HTMLDivElement>(null);
  const outlineSeparator = useRef<HTMLDivElement>(null);
  const resizeFrame = useFrameTask();
  const outlineDrag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
    min: number;
    max: number;
  } | null>(null);
  // CSS clamps against the enclosing pane in real time. Reading its width and
  // setting React state from ResizeObserver would rerender the entire outline
  // on every outer-pane resize. Measure only when an interaction starts.
  const outlineBounds = () => {
    const rowWidth = splitRow.current?.clientWidth ?? 0;
    const max = rowWidth
      ? Math.max(100, Math.min(560, Math.floor(rowWidth * 0.6), rowWidth - 200))
      : 560;
    return { min: Math.min(144, max), max };
  };
  const clampOutlineWidth = (width: number) => {
    const { min, max } = outlineBounds();
    return Math.round(Math.max(min, Math.min(max, width)));
  };
  const persistOutlineWidth = (width: number) => {
    try {
      webviewStorage.setItem(OUTLINE_WIDTH_KEY, String(width));
    } catch {
      // A disabled preference store must not prevent resizing.
    }
  };
  const finishOutlineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = outlineDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    outlineDrag.current = null;
    resizeFrame.flush();
    setResizingOutline(false);
    setPreferredWidth(drag.width);
    persistOutlineWidth(drag.width);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  useEffect(() => {
    const nav = outlineColumn.current;
    if (!outline || !nav || typeof ResizeObserver === "undefined") return;
    // Keep assistive technology in sync with CSS clamping, without reconciling
    // hundreds of outline rows when an enclosing pane changes width.
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        outlineSeparator.current?.setAttribute(
          "aria-valuenow",
          String(Math.round(entry.contentRect.width)),
        );
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, [outline]);
  const content = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const { menu, open: openMenu, dismiss: dismissMenu } = useMenuController();
  const editorFind = editor?.find;
  const editorMatches = useSyncExternalStore(
    editorFind?.subscribe ?? noFindSubscription,
    editorFind?.getSnapshot ?? noFindSnapshot,
  );
  const headings = useMemo(
    () => (markdown ? fileHeadings(text) : []),
    [text, markdown],
  );
  const { tree, roots } = useMemo(() => {
    const stack: number[] = [];
    const roots: number[] = [];
    const children = headings.map((): number[] => []);
    const tree = headings.map((heading, i) => {
      while (stack.length && headings[stack.at(-1)!]!.level >= heading.level)
        stack.pop();
      const ancestors = [...stack];
      const parent = stack.at(-1);
      (parent === undefined ? roots : children[parent]!).push(i);
      stack.push(i);
      return {
        ...heading,
        ancestors,
        depth: ancestors.length,
        children: children[i]!,
      };
    });
    return { tree, roots };
  }, [headings]);
  const [expanded, setExpanded] = useState<ReadonlySet<number> | null>(null);
  const isExpanded = (i: number) =>
    expanded ? expanded.has(i) : tree[i]?.depth === 0;
  const toggle = (i: number) =>
    setExpanded((current) => {
      const next = new Set(
        current ?? tree.flatMap((node, j) => (node.depth === 0 ? [j] : [])),
      );
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const branches = tree.flatMap((node, index) => node.children.length ? [index] : []);
  const allExpanded = branches.length > 0 && branches.every(isExpanded);
  const toggleAllLabel = allExpanded ? "全部折叠" : "全部展开";
  const iconButton =
    "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink";
  const name = `file-find-${scope.replace(/[^a-z0-9]/gi, "")}`;
  useEffect(() => documents.fileFind.register(scope), [documents, scope]);
  const openFind = useCallback(() => {
    if (!open) {
      const selected = editorFind?.selectedText();
      if (selected) setQuery(selected);
      if (!editorFind) reveal(Number.MAX_SAFE_INTEGER);
      setOpen(true);
    }
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [editorFind, open, reveal]);
  const closeFind = useCallback(() => {
    setOpen(false);
    if (editorFind) editorFind.focus();
    else searchButton.current?.focus();
  }, [editorFind]);
  const move = useCallback((direction: number) => {
    if (editorFind) editorFind.move(direction);
    else setIndex((i) =>
      ranges.length ? (i + direction + ranges.length) % ranges.length : 0,
    );
  }, [editorFind, ranges.length]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (documents.fileFind.owner(event) !== scope) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        openFind();
      } else if (open && event.key === "Escape" && !menu && !event.isComposing) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeFind();
      } else if ((event.key === "F3" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g")) &&
        (open || editorFind)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (open || editorMatches?.query.valid) move(event.shiftKey ? -1 : 1);
        else openFind();
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [documents, scope, open, openFind, closeFind, editorFind, editorMatches?.query.valid, menu, move]);
  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open, source]);
  useEffect(() => {
    if (open) editorFind?.show(query);
    else editorFind?.close();
  }, [editorFind, open, query]);
  useEffect(() => () => editorFind?.close(), [editorFind]);
  useEffect(() => {
    const root = content.current;
    if (!root || !open || editor) return;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setRanges(fileTextRanges(root, query));
        setIndex(0);
      }, 100);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [open, query, source, text, editor]);
  useEffect(() => {
    const registry = CSS.highlights;
    if (!registry || typeof Highlight === "undefined") return;
    if (open && !editorFind) {
      registry.set(name, new Highlight(...ranges));
      registry.set(
        `${name}-active`,
        new Highlight(...(ranges[index] ? [ranges[index]] : [])),
      );
    }
    return () => {
      registry.delete(name);
      registry.delete(`${name}-active`);
    };
  }, [ranges, index, name, open, editorFind]);
  useEffect(() => {
    if (open && !editorFind)
      ranges[index]?.startContainer.parentElement?.scrollIntoView?.({
        block: "center",
      });
  }, [ranges, index, open, editorFind]);
  useEffect(() => {
    const root = content.current;
    if (!root || !outline) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const targets = source
          ? headings.map((h) =>
              root.querySelector(`[data-file-line="${h.line}"]`),
            )
          : Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"));
        const top = root.getBoundingClientRect().top + 32;
        let current = 0;
        targets.forEach((element, i) => {
          if (element && element.getBoundingClientRect().top <= top)
            current = i;
        });
        setSection(current);
      });
    };
    root.addEventListener("scroll", update, true);
    update();
    return () => {
      root.removeEventListener("scroll", update, true);
      cancelAnimationFrame(frame);
    };
  }, [outline, source, headings]);
  function jump(i: number) {
    const heading = headings[i];
    if (!heading) return;
    if (editor) {
      editor.reveal(heading.line);
      return;
    }
    if (source) reveal(heading.line);
    requestAnimationFrame(() => {
      const root = content.current;
      const element = source
        ? root?.querySelector(`[data-file-line="${heading.line}"]`)
        : root?.querySelectorAll("h1,h2,h3,h4,h5,h6")[i];
      element?.scrollIntoView?.({ block: "start" });
      setSection(i);
    });
  }
  function renderBranch(i: number) {
    const heading = tree[i]!;
    const expanded = isExpanded(i);
    const active = section === i ||
      (tree[section]?.ancestors.includes(i) && !expanded);
    const hasChildren = heading.children.length > 0;
    const branchId = `outline-${scope}-${i}`;
    return (
      <div key={`${heading.line}-${i}`}>
        <div
          className={`flex items-center rounded ${active ? "bg-selected text-ink" : "text-ink-soft hover:bg-surface-hover"}`}
          style={{ paddingLeft: `${heading.depth * 10}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              className="flex min-h-5 min-w-5 shrink-0 items-center justify-center rounded hover:bg-hover"
              aria-label={`${expanded ? "折叠" : "展开"} ${heading.title}`}
              aria-expanded={expanded}
              aria-controls={branchId}
              onClick={() => toggle(i)}
            >
              <ChevronRightIcon className={`ui-icon-12 ${treeChevronClass} ${expanded ? "rotate-90" : ""}`} />
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <button
            type="button"
            data-hint={heading.title}
            aria-current={section === i ? "location" : undefined}
            className={`min-w-0 flex-1 truncate py-1.5 pr-2 text-left ${heading.level === 1 ? "text-ui-base font-semibold" : heading.level === 2 ? "text-ui-caption font-medium" : "text-ui-sm font-normal"}`}
            onClick={() => jump(i)}
          >
            {heading.title}
          </button>
        </div>
        {hasChildren && (
          <TreeBranch id={branchId} open={expanded}>
            {heading.children.map(renderBranch)}
          </TreeBranch>
        )}
      </div>
    );
  }
  const matchCount = editorFind ? editorMatches?.matchCount ?? 0 : ranges.length;
  const activeIndex = editorFind ? editorMatches?.activeIndex ?? -1 : ranges.length ? index : -1;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-file-search-scope={scope}
    >
      <style>{`::highlight(${name}) { background: #fde68a; color: #1f2937; } ::highlight(${name}-active) { background: #fb923c; color: #1f2937; }`}</style>
      {toolbar
        ? createPortal(
            <>
              {markdown && (
                <button
                  type="button"
                  aria-label="大纲"
                  data-hint="大纲"
                  aria-expanded={outline}
                  className={`${iconButton} ${outline ? "bg-selected text-ink" : ""}`}
                  onClick={() => setOutline((v) => !v)}
                >
                  <UiIcon
                    className="ui-icon-14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  >
                    <path d="M4 5h16M8 12h12M8 19h12M4 10v9" />
                  </UiIcon>
                </button>
              )}
              <button
                ref={searchButton}
                type="button"
                aria-label="搜索文件"
                data-hint="搜索文件（Ctrl+F）"
                className={`${iconButton} ${open ? "bg-selected text-ink" : ""}`}
                onClick={openFind}
              >
                <SearchIcon className="ui-icon-14" />
              </button>
            </>,
            toolbar,
          )
        : null}
      {project && (
        <FileAnnotations
          documents={documents}
          root={content}
          project={project}
          path={path}
          text={text}
          source={source}
          instance={scope}
          reveal={reveal}
          sourceEditor={editor}
        />
      )}
      <div
        ref={splitRow}
        className={`@container flex min-h-0 min-w-0 flex-1 ${resizingOutline ? "select-none" : ""}`}
      >
        <CollapsibleTreePane
          paneRef={outlineColumn}
          open={outline}
          width={outlineWidthStyle(preferredWidth)}
          resizing={resizingOutline}
          scope={scope}
        >
          {outlineMounted && <nav
            aria-label="文件大纲"
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-2">
              <span className="text-xs font-medium text-ink-soft">大纲</span>
              {branches.length > 0 && (
                <button
                  type="button"
                  aria-label={toggleAllLabel}
                  data-hint={toggleAllLabel}
                  className={iconButton}
                  onClick={() => setExpanded(new Set(allExpanded ? [] : branches))}
                >
                  <UiIcon
                    className="ui-icon-14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={allExpanded ? "m8 3 4 4 4-4M8 21l4-4 4 4M5 12h14" : "m8 7 4-4 4 4M8 17l4 4 4-4M5 12h14"} />
                  </UiIcon>
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              {!headings.length && (
                <p className="p-2 text-xs text-ink-soft">暂无章节</p>
              )}
              {roots.map(renderBranch)}
            </div>
          </nav>}
        </CollapsibleTreePane>
        {outline && (
          <div
            ref={outlineSeparator}
            role="separator"
            aria-label="调整大纲宽度"
            aria-orientation="vertical"
            aria-valuemin={100}
            aria-valuemax={560}
            aria-valuenow={preferredWidth}
            tabIndex={0}
            data-hint="拖拽调整大纲宽度，双击恢复默认"
            className={`group relative w-px shrink-0 touch-none bg-line outline-none before:absolute before:inset-y-0 before:-left-1 before:w-[9px] before:cursor-col-resize before:content-[''] after:pointer-events-none after:absolute after:inset-y-2 after:-left-px after:w-0.5 after:rounded-full after:bg-ink-subtlest/50 after:opacity-0 hover:after:opacity-100 focus-visible:after:opacity-100 ${resizingOutline ? "cursor-col-resize after:opacity-100" : ""}`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              const bounds = outlineBounds();
              const width =
                outlineColumn.current?.clientWidth ||
                clampOutlineWidth(preferredWidth);
              outlineDrag.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: width,
                width,
                ...bounds,
              };
              setResizingOutline(true);
            }}
            onPointerMove={(event) => {
              const drag = outlineDrag.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              const width = Math.round(
                Math.max(
                  drag.min,
                  Math.min(
                    drag.max,
                    drag.startWidth + event.clientX - drag.startX,
                  ),
                ),
              );
              drag.width = width;
              const separator = event.currentTarget;
              resizeFrame.schedule(() => {
                if (outlineColumn.current)
                  outlineColumn.current.style.width = outlineWidthStyle(width);
                separator.setAttribute("aria-valuenow", String(width));
              });
            }}
            onPointerUp={finishOutlineResize}
            onPointerCancel={finishOutlineResize}
            onLostPointerCapture={finishOutlineResize}
            onDoubleClick={() => {
              setPreferredWidth(DEFAULT_OUTLINE_WIDTH);
              persistOutlineWidth(DEFAULT_OUTLINE_WIDTH);
            }}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const { min, max } = outlineBounds();
              const width =
                outlineColumn.current?.clientWidth || preferredWidth;
              const next =
                event.key === "Home"
                  ? min
                  : event.key === "End"
                    ? max
                    : clampOutlineWidth(
                        width + (event.key === "ArrowRight" ? 16 : -16),
                      );
              setPreferredWidth(next);
              persistOutlineWidth(next);
            }}
          />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div ref={content} className="flex min-h-0 min-w-0 flex-1 flex-col">
            {children}
          </div>
          {open && (
            <FindBar
              label="文件查找"
              placeholder="搜索当前文件"
              query={query}
              matchCount={matchCount}
              activeIndex={activeIndex}
              onQueryChange={setQuery}
              onPrevious={() => move(-1)}
              onNext={() => move(1)}
              onClose={closeFind}
              inputRef={input}
              enterNavigates
              actions={editorFind && editorMatches && (
                <div className="flex shrink-0 items-center gap-0.5 border-l border-line pl-1.5">
                  <button
                    type="button"
                    aria-expanded={replaceOpen}
                    className={`${findActionClass} px-1.5 text-ui-caption`}
                    onClick={() => setReplaceOpen((expanded) => !expanded)}
                  >
                    替换
                  </button>
                  <button
                    type="button"
                    aria-label="更多查找选项"
                    data-hint="更多查找选项"
                    aria-haspopup="menu"
                    aria-expanded={!!menu && !menu.closing}
                    className={findActionClass}
                    onClick={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect();
                      openMenu("markdown-find", "更多查找选项", [
                        ...markdownFindOptions.map(({ key, label }) => ({
                          id: key,
                          label,
                          checked: editorMatches.query[key],
                          onSelect: () => editorFind.setQuery({ [key]: !editorMatches.query[key] }),
                        })),
                        { type: "separator" },
                        { id: "select-matches", label: "选中全部匹配", disabled: !matchCount, onSelect: editorFind.selectAll },
                      ], { x: bounds.right, y: bounds.bottom, side: "bottom", align: "end" });
                    }}
                  >
                    <EllipsisIcon className="ui-icon-14" />
                  </button>
                </div>
              )}
            >
              {editorFind && editorMatches && replaceOpen && (
                <div className="flex min-h-9 items-center gap-1.5 border-t border-line px-2">
                  <input
                    aria-label="替换为"
                    placeholder="替换为"
                    className={findFieldClass}
                    value={editorMatches.query.replace}
                    onChange={(event) => editorFind.setQuery({ replace: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.nativeEvent.isComposing || !matchCount) return;
                      event.preventDefault();
                      editorFind.replace(false);
                    }}
                  />
                  <button type="button" disabled={!matchCount} className={`${findActionClass} px-1.5 text-ui-caption`}
                    onClick={() => editorFind.replace(false)}>
                    替换当前
                  </button>
                  <button type="button" disabled={!matchCount} className={`${findActionClass} px-1.5 text-ui-caption`}
                    onClick={() => editorFind.replace(true)}>
                    全部替换
                  </button>
                </div>
              )}
            </FindBar>
          )}
        </div>
      </div>
      {open && editorFind && menu && (
        <ContextMenu entries={menu.entries} placement={menu.placement} label={menu.label}
          closing={menu.closing} onDismiss={dismissMenu} />
      )}
    </div>
  );
}
