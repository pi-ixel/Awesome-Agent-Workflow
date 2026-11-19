import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { TreeBranch } from "../../src/shared/ui/TreeMotion.tsx";
it("keeps closing children inert and supports rapid reversal", async () => {
  function Fixture() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(!open)}>切换</button>
        <TreeBranch open={open}>
          <button>子节点</button>
        </TreeBranch>
      </>
    );
  }
  render(<Fixture />);
  const toggle = screen.getByText("切换");
  const child = screen.getByText("子节点");
  await userEvent.click(toggle);
  expect(child.closest("[inert]")).not.toBeNull();
  await userEvent.click(toggle);
  expect(screen.getByRole("button", { name: "子节点" })).toBe(child);
  await userEvent.click(toggle);
  await waitFor(() => expect(child).not.toBeInTheDocument());
});
