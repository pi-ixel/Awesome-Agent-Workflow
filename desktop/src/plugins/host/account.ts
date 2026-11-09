import type { AccountHost } from "../../contracts/account.ts";
import type { HostResources } from "./effects.ts";

export function createAccountHost(
  backend: AccountHost,
  resources: HostResources,
): AccountHost {
  let release: ReturnType<HostResources["own"]> | undefined;
  let windowTask = Promise.resolve();
  function enqueue(action: () => Promise<void>): Promise<void> {
    const next = windowTask.then(action);
    windowTask = next.catch(() => {});
    return next;
  }

  return {
    ssoOpenLogin: (loginUrl) =>
      resources.acquire(() =>
        enqueue(() =>
          resources.run(() => {
            release ??= resources.own(async () => {
              await backend.ssoCloseLogin();
              release = undefined;
            });
            return backend.ssoOpenLogin(loginUrl);
          }),
        ),
      ),
    ssoPollLogin: (endpoint) =>
      resources.run(() => backend.ssoPollLogin(endpoint)),
    ssoCloseLogin: () => enqueue(() => release?.() ?? Promise.resolve()),
  };
}
