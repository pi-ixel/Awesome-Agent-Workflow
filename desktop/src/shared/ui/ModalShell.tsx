/** Shared modal layout, keyboard ownership and focus management. */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const ModalDepth = createContext(0);
const activeModals = new Map<symbol, number>();
const backgroundLocks = new Map<HTMLElement, number>();
const focusableSelector =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface ModalShellProps {
  readonly label: string;
  readonly role?: "dialog" | "alertdialog";
  readonly descriptionId?: string;
  readonly layer?: "default" | "foreground";
  readonly size?: "default" | "settings" | "form";
  readonly dismissOnBackdrop?: boolean;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}

export function ModalShell({
  label,
  role = "dialog",
  descriptionId,
  layer = "default",
  size = "default",
  dismissOnBackdrop = true,
  onDismiss,
  children,
}: ModalShellProps) {
  const depth = useContext(ModalDepth);
  const priority = Math.max(depth, layer === "foreground" ? 100 : 50);
  const card = useRef<HTMLDivElement>(null);
  const opener = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const dismiss = useRef(onDismiss);
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
      if (!isTop() || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
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
    // Portal siblings are the application surface; nested modal portals remain interactive.
    const inertElements: HTMLElement[] = [];
    if (depth === 0) {
      for (const child of document.body.children) {
        if (
          child instanceof HTMLElement &&
          !child.hasAttribute("data-modal-layer") &&
          !child.querySelector("[data-modal-layer]") &&
          (!child.inert || backgroundLocks.has(child))
        ) {
          backgroundLocks.set(child, (backgroundLocks.get(child) ?? 0) + 1);
          child.inert = true;
          inertElements.push(child);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      activeModals.delete(id);
      window.removeEventListener("keydown", handleKeyDown);
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
  }, [depth, priority]);

  return createPortal(
    <ModalDepth.Provider value={priority + 1}>
      <div
        data-modal-layer={size}
        className={`modal-in fixed inset-0 flex items-center justify-center p-4 ${size !== "default" ? "bg-black/25" : "bg-black/60"}`}
        style={{ zIndex: priority }}
        onClick={dismissOnBackdrop ? onDismiss : undefined}
      >
        <div
          ref={card}
          tabIndex={-1}
          role={role}
          aria-modal="true"
          aria-label={label}
          aria-describedby={descriptionId}
          className={`modal-panel w-full border border-dialog-line bg-surface text-ink shadow-floating outline-none ${size === "settings" ? "flex h-[min(800px,calc(100dvh-32px))] max-w-[960px] min-h-0 flex-col overflow-hidden rounded-3xl" : size === "form" ? "flex max-h-[calc(100dvh-32px)] max-w-2xl min-h-0 flex-col overflow-hidden rounded-3xl" : "max-h-[85vh] max-w-lg overflow-y-auto rounded-xl"}`}
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </ModalDepth.Provider>,
    document.body,
  );
}
