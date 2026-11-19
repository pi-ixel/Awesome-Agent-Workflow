import type { Ref } from "react";
import { SkillIcon } from "../../../../shared/ui/icons.tsx";
import {
  skillReferenceKey,
  type SkillReference,
} from "../../composer/skillReferences.ts";

export function SkillReferenceToken({
  reference,
  alignInk = false,
}: {
  readonly reference: SkillReference;
  readonly alignInk?: boolean;
}) {
  return (
    <span
      data-hint={reference.path}
      className="inline-flex shrink-0 items-center gap-1.5 align-middle text-ui-base leading-5"
    >
      <SkillIcon
        className={
          alignInk
            ? "ui-icon-16 -ms-[calc(var(--ui-icon-unit)*2.7333)] shrink-0"
            : "ui-icon-16 shrink-0"
        }
      />
      <span
        className={`bg-linear-to-r from-skill-reference-rose via-skill-reference-pink to-skill-reference-lilac bg-clip-text text-transparent forced-colors:bg-none forced-colors:text-[CanvasText] ${alignInk ? "whitespace-nowrap" : ""}`}
      >
        {reference.name}
      </span>
    </span>
  );
}

export function SkillReferenceTokens({
  references,
  railRef,
}: {
  readonly references: readonly SkillReference[];
  readonly railRef: Ref<HTMLDivElement>;
}) {
  if (!references.length) return null;
  return (
    <div className="pointer-events-none absolute inset-x-[var(--composer-inline-inset)] top-3 z-10">
      <div
        ref={railRef}
        className="pointer-events-auto relative flex w-max max-w-[45%] items-center gap-2 overflow-x-auto [scrollbar-width:none]"
      >
        {references.map((reference) => (
          <SkillReferenceToken
            key={skillReferenceKey(reference)}
            reference={reference}
            alignInk
          />
        ))}
      </div>
    </div>
  );
}
