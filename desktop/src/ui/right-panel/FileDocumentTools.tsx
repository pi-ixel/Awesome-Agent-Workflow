import { createPortal } from "react-dom";
import { SearchIcon, ChevronRightIcon, ChevronDownIcon } from "../icons.tsx";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fileFindOwner, registerFileFind } from "./fileFindScope.ts";
import { fileHeadings, fileTextRanges } from "./fileDocumentIndex.ts";

export function FileDocumentTools({
  toolbar,
  scope,
  path,
  text,
  markdown,
  source,
  reveal,
  children,
}: {
  toolbar?: HTMLElement | null;
  scope: string;
  path: string;
  text: string;
  markdown: boolean;
  source: boolean;
  reveal: (line: number) => void;
  children: ReactNode;
}) {
  const [outline, setOutline] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [section, setSection] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const headings = useMemo(
    () => (markdown ? fileHeadings(text) : []),
    [text, markdown],
  );
  const tree = useMemo(() => {
    const stack: number[] = [];
    return headings.map((heading, i) => {
      while (stack.length && headings[stack.at(-1)!]!.level >= heading.level)
        stack.pop();
      const ancestors = [...stack];
      stack.push(i);
      return {
        ...heading,
        ancestors,
        depth: ancestors.length,
        branch: (headings[i + 1]?.level ?? 0) > heading.level,
      };
    });
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
  const iconButton =
    "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink";
  const name = `file-find-${scope.replace(/[^a-z0-9]/gi, "")}`;
  useEffect(() => registerFileFind(scope), [scope]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (fileFindOwner(event) !== scope) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        reveal(Number.MAX_SAFE_INTEGER);
        setOpen(true);
        input.current?.focus();
        input.current?.select();
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [scope, open, reveal]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    const root = content.current;
    if (!root || !open) return;
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
  }, [open, query, source, text]);
  useEffect(() => {
    const registry = CSS.highlights;
    if (!registry || typeof Highlight === "undefined") return;
    if (open) {
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
  }, [ranges, index, name, open]);
  useEffect(() => {
    if (open)
      ranges[index]?.startContainer.parentElement?.scrollIntoView?.({
        block: "center",
      });
  }, [ranges, index, open]);
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
  const move = (direction: number) =>
    setIndex((i) =>
      ranges.length ? (i + direction + ranges.length) % ranges.length : 0,
    );
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
                  title="大纲"
                  aria-expanded={outline}
                  className={`${iconButton} ${outline ? "bg-selected text-ink" : ""}`}
                  onClick={() => setOutline((v) => !v)}
                >
                  <svg
                    className="size-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  >
                    <path d="M4 5h16M8 12h12M8 19h12M4 10v9" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                aria-label="搜索文件"
                title="搜索文件（Ctrl+F）"
                className={`${iconButton} ${open ? "bg-selected text-ink" : ""}`}
                onClick={() => {
                  reveal(Number.MAX_SAFE_INTEGER);
                  setOpen(true);
                  input.current?.focus();
                }}
              >
                <SearchIcon className="size-3.5" />
              </button>
            </>,
            toolbar,
          )
        : null}
      {open && (
        <div
          role="search"
          aria-label={`搜索文件：${path}`}
          className="flex flex-wrap items-center gap-2 border-b border-line p-2 text-xs"
        >
          <span className="max-w-40 truncate" title={path}>
            {path.split(/[\\/]/).at(-1)}
          </span>
          <input
            ref={input}
            aria-label="搜索当前文件"
            placeholder="搜索当前文件"
            value={query}
            className="min-w-20 flex-1 bg-surface px-2 py-1"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                move(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <span aria-live="polite">
            {ranges.length ? index + 1 : 0}/{ranges.length}
          </span>
          <button
            aria-label="上一个匹配"
            disabled={!ranges.length}
            onClick={() => move(-1)}
          >
            ↑
          </button>
          <button
            aria-label="下一个匹配"
            disabled={!ranges.length}
            onClick={() => move(1)}
          >
            ↓
          </button>
          <button aria-label="关闭文件搜索" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {outline && (
          <nav
            aria-label="文件大纲"
            className="flex w-52 max-w-[45%] shrink-0 flex-col border-r border-line"
          >
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-2">
              <span className="text-xs font-medium text-ink-soft">大纲</span>
              <div className="flex items-center">
                <button
                  type="button"
                  aria-label="全部展开"
                  title="全部展开"
                  className={iconButton}
                  onClick={() => setExpanded(new Set(tree.map((_, i) => i)))}
                >
                  <svg
                    className="size-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m8 7 4-4 4 4M8 17l4 4 4-4M5 12h14" />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label="全部折叠"
                  title="全部折叠"
                  className={iconButton}
                  onClick={() => setExpanded(new Set())}
                >
                  <svg
                    className="size-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m8 3 4 4 4-4M8 21l4-4 4 4M5 12h14" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              {!headings.length && (
                <p className="p-2 text-xs text-ink-soft">暂无章节</p>
              )}
              {tree.map((h, i) => {
                if (h.ancestors.some((parent) => !isExpanded(parent)))
                  return null;
                const active =
                  section === i ||
                  (tree[section]?.ancestors.includes(i) && !isExpanded(i));
                return (
                  <div
                    key={`${h.line}-${i}`}
                    className={`flex items-center rounded ${active ? "bg-selected text-ink" : "text-ink-soft hover:bg-surface-hover"}`}
                    style={{ paddingLeft: `${h.depth * 10}px` }}
                  >
                    {h.branch ? (
                      <button
                        type="button"
                        className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-hover"
                        aria-label={`${isExpanded(i) ? "折叠" : "展开"} ${h.title}`}
                        aria-expanded={isExpanded(i)}
                        onClick={() => toggle(i)}
                      >
                        {isExpanded(i) ? (
                          <ChevronDownIcon className="size-3" />
                        ) : (
                          <ChevronRightIcon className="size-3" />
                        )}
                      </button>
                    ) : (
                      <span className="w-5 shrink-0" />
                    )}
                    <button
                      type="button"
                      title={h.title}
                      aria-current={section === i ? "location" : undefined}
                      className={`min-w-0 flex-1 truncate py-1.5 pr-2 text-left ${h.level === 1 ? "text-[14px] font-semibold" : h.level === 2 ? "text-[13px] font-medium" : "text-[12px] font-normal"}`}
                      onClick={() => jump(i)}
                    >
                      {h.title}
                    </button>
                  </div>
                );
              })}
            </div>
          </nav>
        )}
        <div ref={content} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}
