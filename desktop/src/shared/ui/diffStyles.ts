const addedEdge = "shadow-[inset_3px_0_0_var(--color-diff-added)]";
const removedEdge = "shadow-[inset_3px_0_0_var(--color-diff-removed)]";
const addedInk = "text-diff-added-ink";
const removedInk = "text-diff-removed-ink";
const neutralInk = "text-ink-subtlest";
const addedGutter = `bg-diff-added-gutter ${addedInk}`;
const removedGutter = `bg-diff-removed-gutter ${removedInk}`;
const context = {
  row: "",
  ink: neutralInk,
  gutter: neutralInk,
  stickyGutter: `bg-base ${neutralInk}`,
};

export const diffAppearance = {
  add: {
    row: `bg-diff-added-row ${addedEdge}`,
    ink: addedInk,
    gutter: addedGutter,
    stickyGutter: `${addedGutter} ${addedEdge}`,
  },
  del: {
    row: `bg-diff-removed-row ${removedEdge}`,
    ink: removedInk,
    gutter: removedGutter,
    stickyGutter: `${removedGutter} ${removedEdge}`,
  },
  context,
  gap: context,
  meta: { ...context, row: "text-ink-mute" },
  missing: {
    ...context,
    row: "bg-raised",
    stickyGutter: `bg-raised ${neutralInk}`,
  },
} as const;

export const diffSurfaceClass = "bg-base font-mono leading-relaxed text-ink";
