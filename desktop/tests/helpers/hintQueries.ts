import { buildQueries, queryHelpers } from "@testing-library/react";

const [queryByHint, getAllByHint, getByHint, , findByHint] = buildQueries(
  (container: HTMLElement, text: string | RegExp) =>
    queryHelpers.queryAllByAttribute("data-hint", container, text),
  (_, text) => `Found multiple elements with hint ${text}`,
  (_, text) => `Unable to find an element with hint ${text}`,
);

export { getAllByHint, getByHint, queryByHint, findByHint };
