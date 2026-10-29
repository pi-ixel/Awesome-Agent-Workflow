import { useMemo, useState, type ReactNode } from "react";
import type { SessionItem } from "../../stores/sessionStore.ts";
import type { ConversationTurn } from "./conversationTurns.ts";
import { groupTurnWork, type TurnUnit } from "./turnGrouping.ts";
import { WorkGroupCard } from "./WorkGroupCard.tsx";
import { useExpansionState } from "./useExpansionState.ts";
import { ChevronRightIcon } from "../icons.tsx";

function WorkGroup({
  unit,
  renderItem,
}: {
  readonly unit: Extract<TurnUnit, { kind: "work" }>;
  readonly renderItem: (item: SessionItem) => ReactNode;
}) {
  const [open, setOpen] = useExpansionState(unit.id);
  return (
    <WorkGroupCard
      unit={unit}
      expanded={open}
      onToggle={() => setOpen(!open)}
      renderItem={renderItem}
    />
  );
}

export function ConversationTurnView({
  turn,
  renderItem,
}: {
  readonly turn: ConversationTurn;
  readonly renderItem: (item: SessionItem) => ReactNode;
}) {
  // A lifecycle transition resets only the outer history. Inner tool choices
  // remain in the session-scoped expansion store even when history unmounts.
  const [choice, setChoice] = useState({ forced: turn.forceOpen, open: false });
  if (choice.forced !== turn.forceOpen) {
    setChoice({ forced: turn.forceOpen, open: false });
  }
  const open =
    turn.forceOpen || (choice.forced === turn.forceOpen && choice.open);
  const units = useMemo(() => groupTurnWork(turn.history), [turn.history]);
  return (
    <div className="group/assistant-turn space-y-5">
      {turn.user && (
        <div data-query-id={turn.user.id}>{renderItem(turn.user)}</div>
      )}
      {units.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={open}
            disabled={turn.forceOpen}
            onClick={() => setChoice({ forced: turn.forceOpen, open: !open })}
            className="group/history flex w-full items-center gap-2 border-b border-line/50 pb-2 text-left text-ui-base text-ink-mute enabled:hover:text-ink"
          >
            <span>{turn.running ? "工作进行中" : "工作过程"}</span>
            {!turn.forceOpen && (
              <ChevronRightIcon
                className={`size-4 transition ${open ? "rotate-90" : "opacity-0 group-hover/history:opacity-100 group-focus-visible/history:opacity-100 [@media(hover:none)]:opacity-100"}`}
              />
            )}
          </button>
          {open && (
            <div className="space-y-4 pt-4">
              {units.map((unit) =>
                unit.kind === "item" ? (
                  <div key={unit.id}>{renderItem(unit.item)}</div>
                ) : (
                  <WorkGroup
                    key={unit.id}
                    unit={unit}
                    renderItem={renderItem}
                  />
                ),
              )}
            </div>
          )}
        </div>
      )}
      {turn.answer && renderItem(turn.answer)}
    </div>
  );
}
