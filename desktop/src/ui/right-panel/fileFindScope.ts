/** Last explicitly used pane owns find; portal headers carry the same scope. */
let active: string | null = null;
const owners = new Set<string>();
function track(event: Event) {
  const target = event.target;
  active =
    target instanceof Element
      ? (target.closest<HTMLElement>("[data-file-search-scope]")?.dataset
          .fileSearchScope ?? null)
      : null;
}
export function registerFileFind(scope: string) {
  if (owners.size === 0) {
    document.addEventListener("pointerdown", track, true);
    document.addEventListener("focusin", track, true);
  }
  owners.add(scope);
  return () => {
    owners.delete(scope);
    if (active === scope) active = null;
    if (!owners.size) {
      document.removeEventListener("pointerdown", track, true);
      document.removeEventListener("focusin", track, true);
    }
  };
}
export function fileFindOwner(event: KeyboardEvent): string | null {
  const target = event.target;
  const scope =
    target instanceof Element
      ? target.closest<HTMLElement>("[data-file-search-scope]")?.dataset
          .fileSearchScope
      : undefined;
  const owner = scope ?? active;
  return owner && owners.has(owner) ? owner : null;
}
