import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  searchPanelOpen,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

// Keep CodeMirror's document search, highlighting and edits. FileDocumentTools
// renders the controls in a single overlay, including when switching views.
const searchEngine = search({
  createPanel: () => {
    const dom = document.createElement("div");
    dom.className = "aaw-markdown-find-anchor";
    dom.hidden = true;
    return { dom };
  },
});

type QueryOptions = Pick<SearchQuery, "regexp" | "wholeWord" | "caseSensitive" | "replace">;
export type MarkdownFindOption = Exclude<keyof QueryOptions, "replace">;

function createMarkdownFind(view: EditorView) {
  const listeners = new Set<() => void>();
  let disposed = false;
  let matches: { from: number; to: number }[] = [];
  let snapshot = { query: getSearchQuery(view.state), matchCount: 0, activeIndex: -1 };

  function setQuery(patch: Partial<QueryOptions> & { search?: string }) {
    if (disposed) return;
    const current = getSearchQuery(view.state);
    const query = new SearchQuery({ ...current, ...patch });
    if (!query.eq(current))
      view.dispatch({ effects: setSearchQuery.of(query) });
  }

  function update({ state, startState, docChanged, selectionSet }: ViewUpdate) {
    const query = getSearchQuery(state);
    const open = searchPanelOpen(state);
    const wasOpen = searchPanelOpen(startState);
    const previous = snapshot.query;
    if (open && (docChanged || !wasOpen || query.search !== previous.search ||
      query.regexp !== previous.regexp || query.caseSensitive !== previous.caseSensitive ||
      query.wholeWord !== previous.wholeWord)) {
      matches = [];
      if (query.valid) {
        const cursor = query.getCursor(state);
        for (let match = cursor.next(); !match.done; match = cursor.next())
          matches.push(match.value);
      }
    } else if (!open && wasOpen) {
      matches = [];
    }
    if (query === previous && !docChanged && !selectionSet && open === wasOpen) return;
    const selection = state.selection.main;
    snapshot = {
      query,
      matchCount: matches.length,
      activeIndex: matches.findIndex(({ from, to }) => from === selection.from && to === selection.to),
    };
    for (const listener of listeners) listener();
  }

  return {
    update,
    getSnapshot: () => snapshot,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    show(text: string) {
      if (disposed) return;
      // Native opening can seed from the editor selection. Apply the shared
      // input afterwards so its value wins when the user switches views.
      if (!searchPanelOpen(view.state)) openSearchPanel(view);
      setQuery({ search: text });
    },
    close() {
      if (!disposed) closeSearchPanel(view);
    },
    focus() {
      if (!disposed) view.focus();
    },
    selectedText() {
      const { from, to } = view.state.selection.main;
      return to - from <= 100 ? view.state.sliceDoc(from, to).replaceAll("\n", "\\n") : "";
    },
    setQuery,
    move(direction: number) {
      if (!disposed) (direction < 0 ? findPrevious : findNext)(view);
    },
    replace(all: boolean) {
      if (!disposed) (all ? replaceAll : replaceNext)(view);
    },
    selectAll(this: void) {
      if (!disposed && selectMatches(view)) view.focus();
    },
    destroy() {
      disposed = true;
      listeners.clear();
    },
  };
}

export type MarkdownFind = ReturnType<typeof createMarkdownFind>;
export const markdownFindView = ViewPlugin.define(createMarkdownFind);
export const markdownFindExtension = [searchEngine, markdownFindView];
