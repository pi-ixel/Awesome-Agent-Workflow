import type {
  NavigationCheck,
  WorkbenchNavigationGuard,
} from "../../contracts/workbench.ts";

export function createNavigationGuard(): WorkbenchNavigationGuard & {
  dispose(): void;
} {
  let active = true;
  let check: NavigationCheck | undefined;
  const guard = (action: () => void, project?: string): boolean => {
    if (!active) return false;
    const current = check;
    return (
      current?.guard(() => {
        if (active && check === current) action();
      }, project) ?? true
    );
  };
  return {
    isActive: () => active,
    pending: () => check?.pending() ?? false,
    async confirm() {
      if (!active) return false;
      const current = check;
      const allowed = current ? await current.confirm() : true;
      return active && check === current && allowed;
    },
    guard,
    run(action) {
      if (guard(action)) action();
    },
    register(next) {
      if (!active || check)
        throw new Error("Workbench navigation check unavailable");
      check = next;
      return () => {
        if (check === next) check = undefined;
      };
    },
    dispose() {
      active = false;
      check = undefined;
    },
  };
}
