import type { AccountHost } from "../types.ts";
import type { HostResources } from "../lifecycle/effects.ts";

export function createAccountHost(
  backend: AccountHost,
  resources: HostResources,
): AccountHost {
  const windows = new Map<
    string,
    { opening: Promise<void>; release: ReturnType<HostResources["own"]> }
  >();

  return {
    ssoOpenLogin(loginUrl, attemptId) {
      if (!resources.isActive()) {
        return Promise.reject(new Error("宿主实例正在卸载"));
      }
      const window = windows.get(attemptId) ?? {
        opening: Promise.resolve(),
        release: resources.own(async () => {
          await backend.ssoCloseLogin(attemptId);
          windows.delete(attemptId);
        }),
      };
      windows.set(attemptId, window);
      const previous = window.opening;
      const opening = resources.acquire(async () => {
        await previous;
        return resources.run(() => backend.ssoOpenLogin(loginUrl, attemptId));
      });
      window.opening = opening.catch(() => {});
      return opening;
    },
    ssoPollLogin: (endpoint, attemptId) =>
      resources.run(() => backend.ssoPollLogin(endpoint, attemptId)),
    listenForSsoClose: (receive) =>
      resources.listen(() => backend.listenForSsoClose(receive)),
    async ssoCloseLogin(attemptId) {
      const window = windows.get(attemptId);
      if (!window) return;
      await window.opening;
      await window.release();
    },
  };
}
