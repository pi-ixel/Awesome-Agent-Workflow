import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type {
  DiffOrigin,
  DiffSide,
  DocumentAnnotation,
} from "../annotations/types.ts";
import {
  diffAnnotationRanges,
  diffRangeLabel,
  isSameDiffOrigin,
  readDiffSelection,
  type DiffQuote,
} from "../annotations/diffSelection.ts";
import { pathKey, pathName, resolveFileReference } from "../panelPaths.ts";
import {
  AnnotationPopover,
  annotationSelectionAnchor,
  type AnnotationAnchor,
} from "./AnnotationPopover.tsx";
import { IconButton } from "./IconButton.tsx";
import { PlusIcon } from "./icons.tsx";

export interface DiffAnnotationBinding<T extends object> {
  readonly editor: {
    readonly current: (project: string) => T | undefined;
    readonly subscribeTarget: (listener: () => void) => () => void;
    readonly subscribeDrafts: (listener: () => void) => () => void;
    readonly read: (target: T) => readonly DocumentAnnotation[];
    readonly ensure: (target: T) => void;
    readonly upsert: (
      target: T,
      annotation: DocumentAnnotation,
    ) => string | null;
    readonly remove: (target: T, id: string) => boolean;
    readonly followPromotion: (
      target: T,
      listener: (target: T) => void,
    ) => () => void;
  };
  readonly project: string;
  readonly origin: DiffOrigin;
  readonly oldPath?: string;
  readonly revision: () => Promise<string>;
}

export function DiffLineNumber({
  line,
  side,
  fragment,
  text,
  onAdd,
  className,
}: {
  readonly line: number | null | undefined;
  readonly side: DiffSide;
  readonly fragment?: number;
  readonly text?: string;
  readonly onAdd?: (quote: DiffQuote, anchor: DOMRect) => void;
  readonly className: string;
}) {
  return (
    <span className={`group/diff-gutter ${className}`}>
      {line}
      {line != null && onAdd && (
        <IconButton
          iconSize="compact"
          appearance="toolbar"
          aria-label={`批注${diffRangeLabel({ side, first: line, last: line, fragment })}`}
          className="absolute top-1/2 left-0 z-[2] flex -translate-y-1/2 items-center justify-center rounded-control bg-surface text-ink-mute opacity-0 transition-opacity hover:bg-raised hover:text-ink group-hover/diff-gutter:opacity-100 focus-visible:opacity-100"
          onClick={(event) =>
            onAdd(
              {
                side,
                first: line,
                last: line,
                fragment,
                quote: text || "\n",
                offset: 0,
              },
              event.currentTarget.getBoundingClientRect(),
            )
          }
        >
          <PlusIcon />
        </IconButton>
      )}
    </span>
  );
}

const noSubscription = () => () => {};
const emptyAnnotations: readonly DocumentAnnotation[] = [];

interface Draft<T extends object> {
  readonly id: string;
  readonly quote: DiffQuote;
  readonly target: T;
  readonly binding: DiffAnnotationBinding<T>;
  readonly anchor: AnnotationAnchor;
  readonly isOpen: boolean;
  readonly annotation?: DocumentAnnotation;
}

export function useDiffAnnotation<T extends object>(
  root: RefObject<HTMLElement | null>,
  binding?: DiffAnnotationBinding<T>,
) {
  const [draft, setDraft] = useState<Draft<T>>();
  const highlightName = `diff-annotation-${useId().replace(/[^a-z0-9]/gi, "")}`;
  const editor = binding?.editor;
  const readTarget = () => binding && editor?.current(binding.project);
  const target = useSyncExternalStore(
    editor?.subscribeTarget ?? noSubscription,
    readTarget,
    readTarget,
  );
  const readAnnotations = () =>
    target ? (editor?.read(target) ?? emptyAnnotations) : emptyAnnotations;
  const annotations = useSyncExternalStore(
    editor?.subscribeDrafts ?? noSubscription,
    readAnnotations,
    readAnnotations,
  );
  useEffect(() => {
    if (target) editor?.ensure(target);
  }, [editor, target]);
  useEffect(() => {
    if (!draft) return;
    return draft.binding.editor.followPromotion(draft.target, (target) => {
      setDraft((current) =>
        current === draft ? { ...current, target } : current,
      );
    });
  }, [draft]);

  useEffect(() => {
    const element = root.current;
    if (!element || !binding) return;
    const selectionChanged = () => {
      const selection = window.getSelection();
      const valid =
        !!selection?.rangeCount &&
        !selection.isCollapsed &&
        element.contains(selection.getRangeAt(0).commonAncestorContainer);
      if (!valid)
        setDraft((current) => (current?.isOpen ? current : undefined));
    };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !element.contains(target) &&
        !target.closest("[data-annotation-overlay]")
      )
        setDraft((current) => (current?.isOpen ? current : undefined));
    };
    document.addEventListener("selectionchange", selectionChanged);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("selectionchange", selectionChanged);
      document.removeEventListener("pointerdown", outside);
    };
  }, [binding, root]);

  useEffect(() => {
    const element = root.current;
    if (!element || !binding || !target) return;
    const items = annotations.filter(
      (item) =>
        pathKey(item.project) === pathKey(binding.project) &&
        isSameDiffOrigin(item.diff, binding.origin),
    );
    if (!items.length) return;
    let active = true;
    let frame = 0;
    let hits: { annotation: DocumentAnnotation; range: Range }[] = [];
    let observer: MutationObserver | undefined;
    const click = (event: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      const hit = hits.find(({ range }) =>
        Array.from(range.getClientRects()).some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        ),
      );
      if (!hit?.annotation.diff) return;
      const annotation = hit.annotation;
      setDraft({
        id: annotation.id,
        annotation,
        binding,
        target,
        isOpen: true,
        quote: {
          ...hit.annotation.diff,
          quote: annotation.quote,
          offset: annotation.offset,
        },
        anchor: { x: event.clientX, bottom: event.clientY },
      });
    };
    void binding
      .revision()
      .then((revision) => {
        if (!active) return;
        const matched = items.filter((item) => item.revision === revision);
        if (!matched.length) return;
        const paint = () => {
          hits = matched.flatMap((annotation) =>
            diffAnnotationRanges(element, annotation).map((range) => ({
              annotation,
              range,
            })),
          );
          if (
            typeof CSS !== "undefined" &&
            CSS.highlights &&
            typeof Highlight !== "undefined"
          ) {
            const highlight = new Highlight(...hits.map(({ range }) => range));
            highlight.priority = -1;
            CSS.highlights.set(highlightName, highlight);
          }
        };
        observer = new MutationObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(paint);
        });
        observer.observe(element, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        element.addEventListener("click", click);
        paint();
      })
      .catch(() => {});
    return () => {
      active = false;
      observer?.disconnect();
      element.removeEventListener("click", click);
      cancelAnimationFrame(frame);
      if (typeof CSS !== "undefined") CSS.highlights?.delete(highlightName);
    };
  }, [annotations, binding, highlightName, root, target]);

  const openDraft = (
    quote: DiffQuote,
    anchor: AnnotationAnchor,
    isOpen: boolean,
  ) => {
    const target = readTarget();
    if (binding && target)
      setDraft({
        id: crypto.randomUUID(),
        quote,
        target,
        binding,
        isOpen,
        anchor,
      });
  };
  function capture(event: { readonly target: EventTarget | null }) {
    if (
      !(event.target instanceof Node) ||
      !root.current?.contains(event.target)
    )
      return;
    const selection = window.getSelection();
    const quote = root.current && readDiffSelection(root.current, selection);
    if (!quote || !selection || !root.current || !quote.quote.trim()) {
      setDraft((current) => (current?.isOpen ? current : undefined));
      return;
    }
    openDraft(quote, annotationSelectionAnchor(selection.getRangeAt(0)), false);
  }
  return {
    add:
      binding &&
      ((quote: DiffQuote, anchor: DOMRect) =>
        openDraft(quote, { x: anchor.left, bottom: anchor.bottom }, true)),
    handlers: binding ? { onPointerUp: capture, onKeyUp: capture } : {},
    root,
    highlightName,
    draft,
    open: () => setDraft((current) => current && { ...current, isOpen: true }),
    close: (id: string) =>
      setDraft((current) => (current?.id === id ? undefined : current)),
  };
}

export function DiffAnnotationActions<T extends object>({
  state,
}: {
  readonly state: ReturnType<typeof useDiffAnnotation<T>>;
}) {
  return (
    <>
      <style>{`::highlight(${state.highlightName}) { background: color-mix(in srgb, var(--color-annotation-underline) 22%, transparent); text-decoration: underline var(--color-annotation-underline); }`}</style>
      {state.draft && (
        <DiffAnnotationForm
          key={state.draft.id}
          state={state}
          draft={state.draft}
        />
      )}
    </>
  );
}

function DiffAnnotationForm<T extends object>({
  state,
  draft,
}: {
  readonly state: ReturnType<typeof useDiffAnnotation<T>>;
  readonly draft: Draft<T>;
}) {
  const [comment, setComment] = useState(draft.annotation?.comment ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const opened = useRef(draft);
  useEffect(() => {
    opened.current = draft;
  }, [draft]);
  const { binding } = draft;
  const { quote, offset, side, first, last, fragment } = draft.quote;
  const relativePath =
    side === "old"
      ? (binding.oldPath ?? binding.origin.file)
      : binding.origin.file;
  const close = () => state.close(draft.id);
  async function save() {
    if (isSaving) return;
    setSaving(true);
    try {
      const reference = resolveFileReference(binding.origin.root, relativePath);
      if (!reference) {
        setError("无法定位批注对应的文件");
        return;
      }
      const annotation = draft.annotation ?? {
        id: draft.id,
        project: binding.project,
        path: reference.path,
        source: true,
        quote,
        prefix: "",
        suffix: "",
        offset,
        revision: await binding.revision(),
        ...(fragment ? {} : { startLine: first, endLine: last }),
        diff: { ...binding.origin, side, first, last, fragment },
      };
      const failure = binding.editor.upsert(opened.current.target, {
        ...annotation,
        comment: comment.trim(),
      });
      if (failure) setError(failure);
      else {
        close();
        window.getSelection()?.removeAllRanges();
      }
    } catch {
      setError("无法保存差异批注，请重试");
    } finally {
      setSaving(false);
    }
  }
  return (
    <AnnotationPopover
      root={state.root}
      anchor={draft.anchor}
      file={pathName(relativePath)}
      location={diffRangeLabel(draft.quote)}
      quote={quote}
      comment={comment}
      error={error}
      isSaving={isSaving}
      onOpen={draft.isOpen ? undefined : state.open}
      onComment={setComment}
      onSave={() => void save()}
      onClose={close}
      onRemove={
        draft.annotation
          ? () => {
              if (binding.editor.remove(draft.target, draft.id)) close();
              else setError("无法删除批注，请重试");
            }
          : undefined
      }
    />
  );
}
