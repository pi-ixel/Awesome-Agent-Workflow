import type { SessionItem } from "../types.ts";
export type TurnUnit =
  | {
      readonly kind: "item";
      readonly id: string;
      readonly item: SessionItem;
    }
  | {
      readonly kind: "work";
      readonly id: string;
      readonly items: readonly SessionItem[];
    };

export function groupTurnWork(
  items: readonly SessionItem[],
): readonly TurnUnit[] {
  const units: TurnUnit[] = [];
  let run: SessionItem[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    units.push({ kind: "work", id: `work-${run[0]!.id}`, items: run });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "thought" || item.kind === "tool") {
      run.push(item);
    } else {
      flushRun();
      units.push({ kind: "item", id: item.id, item });
    }
  }
  flushRun();
  return units;
}
