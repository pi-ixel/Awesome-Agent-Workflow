import { vi } from "vitest";
import { DesktopWorkbench } from "../../src/plugins/workbench/composition/workbench.ts";
import type { WorkbenchLayout } from "../../src/plugins/workbench/types.ts";

const registry = vi.hoisted(() => ({
  owners: new WeakMap<WorkbenchLayout, DesktopWorkbench>(),
  original: undefined as typeof DesktopWorkbench | undefined,
}));

vi.mock(import("../../src/plugins/workbench/composition/workbench.ts"), async (original) => {
  const module = await original();
  registry.original = module.DesktopWorkbench;
  return {
    ...module,
    DesktopWorkbench: class extends module.DesktopWorkbench {
      constructor(...args: ConstructorParameters<typeof module.DesktopWorkbench>) {
        super(...args);
        registry.owners.set(this.service, this);
      }
    },
  };
});

export function workbenchOwner(layout: WorkbenchLayout): DesktopWorkbench {
  const original = registry.original ?? DesktopWorkbench;
  const owner = layout instanceof original ? layout : registry.owners.get(layout);
  if (!owner) throw new Error("A DesktopWorkbench instance is required for a mutable test layout");
  return owner;
}
