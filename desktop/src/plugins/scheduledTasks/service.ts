import type { Scheduler } from "./scheduler/state.ts";

declare module "cordis" {
  interface Context {
    scheduledTasks: Omit<Scheduler, "dispose">;
  }
}
