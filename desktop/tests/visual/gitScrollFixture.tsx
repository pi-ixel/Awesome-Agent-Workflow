import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GitReviewDiff } from "../../src/plugins/git/ui/GitReviewDiff.tsx";
import { bindSecondaryWindowAppearance } from "../../src/plugins/workbench/appearance/windowAppearance.ts";
import "../../src/shared/styles/index.css";
if (new URLSearchParams(location.search).has("appearance"))
  bindSecondaryWindowAppearance(document.documentElement);
const long = "abcdefghij".repeat(100) + "SEARCHTARGET";
const model = {
  rows: [
    { kind: "del" as const, text: `-${long}`, old: 1, next: null },
    { kind: "add" as const, text: "+short", old: null, next: 1 },
  ],
  full: false,
};
function Fixture() {
  const [search, setSearch] = useState(false);
  return (
    <div style={{ width: "min(600px, 100%)" }}>
      <button onClick={() => setSearch(true)}>查找末尾</button>
      <GitReviewDiff
        model={model}
        query={search ? "SEARCHTARGET" : ""}
        match={
          search
            ? { key: "x", row: 0, start: 1000, length: 12, side: "old" }
            : undefined
        }
      />
      <GitReviewDiff model={model} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
