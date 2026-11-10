import { vi } from "vitest";
import type { createAnnotationDraftStore } from "../../src/plugins/project/composer/annotationDraftStore.ts";
import type { ProjectAnnotationDrafts } from "../../src/plugins/project/service.ts";

type DraftOwner = ReturnType<typeof createAnnotationDraftStore>["service"];

const owners = vi.hoisted(() => new WeakMap<ProjectAnnotationDrafts, DraftOwner>());

vi.mock(import("../../src/plugins/project/composer/annotationDraftStore.ts"), async (original) => {
  const module = await original();
  return {
    ...module,
    createAnnotationDraftStore(...args: Parameters<typeof module.createAnnotationDraftStore>) {
      const owner = module.createAnnotationDraftStore(...args);
      owners.set(owner.composer, owner.service);
      return owner;
    },
  };
});

export function annotationDraftOwner(composer: ProjectAnnotationDrafts): DraftOwner {
  const owner = owners.get(composer);
  if (!owner) throw new Error("Missing Project annotation draft test owner");
  return owner;
}
