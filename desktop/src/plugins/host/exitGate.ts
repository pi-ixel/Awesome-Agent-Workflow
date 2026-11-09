import type { HostExitGate } from "../../contracts/host.ts";

/** Prevents new native work while this Host closes or hands off an update. */
export function createHostExitGate(): HostExitGate {
  let owner: object | undefined;
  return {
    isExiting: () => owner !== undefined,
    begin() {
      if (owner) return undefined;
      const claim = {};
      owner = claim;
      return () => {
        if (owner === claim) owner = undefined;
      };
    },
  };
}
