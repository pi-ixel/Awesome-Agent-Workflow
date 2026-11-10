/** Portal headers and file panes share a focus scope within this Documents instance. */
export function createFileFind(ownerDocument: Document | undefined) {
  let active: string | null = null;
  let disposed = false;
  const owners = new Set<string>();

  const scopeOf = (target: EventTarget | null): string | undefined =>
    target instanceof Element
      ? target.closest<HTMLElement>("[data-file-search-scope]")?.dataset
          .fileSearchScope
      : undefined;
  const track = (event: Event) => {
    active = scopeOf(event.target) ?? null;
  };
  const unlisten = () => {
    ownerDocument?.removeEventListener("pointerdown", track, true);
    ownerDocument?.removeEventListener("focusin", track, true);
  };

  return {
    register(scope: string) {
      if (disposed || !ownerDocument) return () => {};
      if (owners.size === 0) {
        ownerDocument.addEventListener("pointerdown", track, true);
        ownerDocument.addEventListener("focusin", track, true);
      }
      owners.add(scope);
      return () => {
        if (!owners.delete(scope)) return;
        if (active === scope) active = null;
        if (!owners.size) unlisten();
      };
    },
    owner(event: KeyboardEvent): string | null {
      if (disposed || !ownerDocument) return null;
      const scope = scopeOf(event.target) ?? active;
      return scope && owners.has(scope) ? scope : null;
    },
    dispose(this: void) {
      disposed = true;
      active = null;
      owners.clear();
      unlisten();
    },
  };
}
