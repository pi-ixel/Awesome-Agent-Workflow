/** Shared modal layout, keyboard ownership and focus management. */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type KeyboardEventHandler,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const ModalDepth = createContext(0);
const activeModals = new Map<symbol, number>();
const backgroundLocks = new Map<HTMLElement, number>();
const focusableSelector =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

const panelSizes = {
  default: "max-h-[85vh] max-w-lg overflow-y-auto rounded-xl",
  settings:
    "flex h-[min(800px,calc(100dvh-32px))] max-w-[960px] min-h-0 flex-col overflow-hidden rounded-3xl",
  form: "flex max-h-[calc(100dvh-32px)] max-w-2xl min-h-0 flex-col overflow-hidden rounded-3xl",
  preview:
    "flex h-[min(1000px,87dvh)] max-w-[1200px] min-h-0 flex-col overflow-hidden rounded-3xl",
  composer:
    "flex max-h-full max-w-[560px] min-h-0 flex-col gap-2.5 overflow-y-auto rounded-[18px] px-4 py-3.5",
  gallery:
    "flex h-full min-h-0 flex-col items-center justify-center gap-4 overflow-hidden p-4 sm:p-8",
} as const;

const centeredScrim = "items-center bg-scrim p-4";
const backdropClasses = {
  default: "items-center bg-overlay-shade/60 p-4",
  settings: centeredScrim,
  form: centeredScrim,
  preview: "items-center bg-overlay-shade/60 p-4 backdrop-blur-sm",
  composer: "items-start bg-base/45 px-4 pt-[clamp(48px,18%,160px)] pb-4 backdrop-blur-[10px]",
  gallery: "items-center bg-overlay-shade/85",
} as const;

interface ModalShellProps {
  readonly label: string;
  readonly role?: "dialog" | "alertdialog";
  readonly descriptionId?: string;
  readonly layer?: "default" | "foreground";
  readonly placement?: "window" | "container";
  readonly size?: keyof typeof panelSizes;
  readonly dismissOnBackdrop?: boolean;
  readonly onDismiss: () => void;
  readonly onPanelKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  readonly children: ReactNode;
}

export function ModalShell({
  label,
  role = "dialog",
  descriptionId,
  layer = "default",
  placement = "window",
  size = "default",
  dismissOnBackdrop = true,
  onDismiss,
  onPanelKeyDown,
  children,
}: ModalShellProps) {
  const depth = useContext(ModalDepth);
  const isLocal = placement === "container";
  const isGallery = size === "gallery";
  const priority = Math.max(
    depth,
    layer === "foreground" ? 100 : isLocal ? 20 : 50,
  );
  const backdrop = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const opener = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const dismiss = useRef(onDismiss);
  const dialogKeyDown = useRef<((event: KeyboardEvent) => void) | null>(null);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const id = Symbol();
    activeModals.set(id, priority);
    const previous = opener.current;
    const isTop = () =>
      [...activeModals.entries()].sort((a, b) => a[1] - b[1]).at(-1)?.[0] ===
      id;
    const controls = () =>
      [
        ...(card.current?.querySelectorAll<HTMLElement>(focusableSelector) ??
          []),
      ].filter(
        (element) =>
          !element.closest('[hidden], [inert], [aria-hidden="true"]'),
      );
    const focusFirst = () => (controls()[0] ?? card.current)?.focus();
    if (isTop() && !card.current?.contains(document.activeElement))
      focusFirst();
    function handleKeyDown(event: KeyboardEvent) {
      if (!isTop() || event.defaultPrevented || event.isComposing) return;
      if (isLocal && !backdrop.current?.contains(document.activeElement))
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss.current();
      } else if (event.key === "Tab") {
        const items = controls();
        const first = items[0];
        const last = items.at(-1);
        if (!first) {
          event.preventDefault();
          card.current?.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first ||
            !card.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !card.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    const inertElements: HTMLElement[] = [];
    const surface = isLocal ? backdrop.current?.parentElement : document.body;
    // 局部弹窗只锁定容器，窗口弹窗锁定整个窗口；独立弹窗层保持可交互。
    if (depth === 0 || isLocal) {
      for (const child of surface?.children ?? []) {
        if (
          child instanceof HTMLElement &&
          !child.hasAttribute("data-modal-layer") &&
          (!child.inert || backgroundLocks.has(child))
        ) {
          backgroundLocks.set(child, (backgroundLocks.get(child) ?? 0) + 1);
          child.inert = true;
          inertElements.push(child);
        }
      }
    }
    dialogKeyDown.current = handleKeyDown;
    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.target === window || event.target === document.body) {
        handleKeyDown(event);
      }
    }
    window.addEventListener("keydown", handleWindowKeyDown, true);
    return () => {
      activeModals.delete(id);
      dialogKeyDown.current = null;
      window.removeEventListener("keydown", handleWindowKeyDown, true);
      for (const element of inertElements) {
        const remaining = (backgroundLocks.get(element) ?? 1) - 1;
        if (remaining > 0) backgroundLocks.set(element, remaining);
        else {
          backgroundLocks.delete(element);
          element.inert = false;
        }
      }
      if (previous?.isConnected && !previous.closest("[inert]"))
        previous.focus();
    };
  }, [depth, isLocal, priority]);

  const content = (
    <ModalDepth.Provider value={priority + 1}>
      <div
        ref={backdrop}
        data-modal-layer={size}
        className={`modal-in inset-0 flex justify-center ${isLocal ? "absolute" : "fixed"} ${backdropClasses[size]}`}
        style={{ zIndex: priority }}
        onMouseDown={(event) => {
          if (!dismissOnBackdrop && event.target === event.currentTarget)
            event.preventDefault();
        }}
        onKeyDown={(event) => dialogKeyDown.current?.(event.nativeEvent)}
        onClick={dismissOnBackdrop ? onDismiss : undefined}
      >
        <div
          ref={card}
          tabIndex={-1}
          role={role}
          aria-modal={isLocal ? undefined : true}
          aria-label={label}
          aria-describedby={descriptionId}
          className={`modal-panel w-full outline-none ${isGallery ? "text-media-ink" : "border border-dialog-line bg-surface text-ink shadow-floating"} ${panelSizes[size]}`}
          onKeyDown={onPanelKeyDown}
          onClick={(event) => {
            event.stopPropagation();
            if (
              isGallery &&
              dismissOnBackdrop &&
              event.target === event.currentTarget
            )
              onDismiss();
          }}
        >
          {children}
        </div>
      </div>
    </ModalDepth.Provider>
  );
  return isLocal ? content : createPortal(content, document.body);
}
