import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { GitReviewDiff } from "../../../../src/plugins/git/ui/GitReviewDiff.tsx";
const model = {
  rows: [
    { kind: "del" as const, text: "-old", old: 1, next: null },
    { kind: "add" as const, text: "+new", old: null, next: 1 },
  ],
  full: false,
};
it("synchronizes both directions without affecting other diff instances", () => {
  render(
    <>
      <GitReviewDiff model={model} />
      <GitReviewDiff model={model} />
    </>,
  );
  const [first, second] = screen.getAllByLabelText("Git 左右差异");
  fireEvent.click(within(first!).getByRole("button", { name: "换行" }));
  const a = within(first!).getByLabelText("修改前"),
    b = within(first!).getByLabelText("修改后");
  const other = within(second!).getByLabelText("修改前");
  a.scrollLeft = 90;
  fireEvent.scroll(a);
  expect(b.scrollLeft).toBe(90);
  expect(other.scrollLeft).toBe(0);
  a.scrollLeft = 150;
  fireEvent.scroll(b);
  expect(a.scrollLeft).toBe(150);
  fireEvent.scroll(a);
  expect(b.scrollLeft).toBe(150);
  b.scrollLeft = 35;
  fireEvent.scroll(b);
  expect(a.scrollLeft).toBe(35);
});
