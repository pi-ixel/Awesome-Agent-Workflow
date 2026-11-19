import { expect, it, vi } from "vitest";
import type { AccountHost } from "../../../src/plugins/host/types.ts";
import type { SsoLoginPollWire } from "../../../src/plugins/host/types.ts";
import { accountStorageKey } from "../../../src/plugins/account/config.ts";
import { createAccount } from "../../../src/plugins/account/identity/account.ts";
import { installDesktopWorkbench } from "../../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";

it("restores the legacy account record and contributes the account views", async () => {
  const user = {
    id: "fixture",
    name: "Example",
    employeeId: "100",
    email: null,
    department: null,
    source: "dev",
    loggedInAt: "2026-01-01T00:00:00Z",
  };
  window.localStorage.setItem(
    accountStorageKey,
    JSON.stringify({ version: 1, user, other: true }),
  );
  const runtime = createTestDesktopRuntime(
    {
      attachPreloading: () => () => {},
      close: () => Promise.resolve(),
    },
    undefined,
    installDesktopWorkbench,
  );
  try {
    const { account, workbench, configuration } = await runtime.ready;
    expect(account.state.getState().currentUser).toEqual(user);
    expect(account.state).not.toHaveProperty("setState");
    expect(account.state.getState()).not.toHaveProperty("loginWithSso");
    expect(workbench.getSnapshot().accessGates.map(({ id }) => id)).toContain(
      "account-login",
    );
    expect(workbench.getSnapshot().sidebarFooters.map(({ id }) => id)).toContain("account-profile");
    account.logout();
    expect(account.state.getState().currentUser).toBeNull();
    expect(configuration.read(accountStorageKey)).toEqual({
      version: 1,
      user: null,
      other: true,
    });
  } finally {
    await runtime.shutdown();
    window.localStorage.removeItem(accountStorageKey);
  }
});

it("isolates a restarted SSO attempt and closes the active login window on disposal", async () => {
  const config = new Map([
    [
      "aaw-desktop.auth.sso-dev-endpoint.v1",
      "https://fixture.invalid/identity",
    ],
    ["aaw-desktop.auth.sso-dev-login-url.v1", "https://fixture.invalid/login"],
  ]);
  const finish: ((wire: SsoLoginPollWire) => void)[] = [];
  const closed: ((id: string) => void)[] = [];
  const host = {
    ssoOpenLogin: vi.fn<AccountHost["ssoOpenLogin"]>(() => Promise.resolve()),
    ssoPollLogin: vi.fn(
      () =>
        new Promise((resolve: (wire: SsoLoginPollWire) => void) =>
          finish.push(resolve),
        ),
    ),
    listenForSsoClose: vi.fn((receive: (id: string) => void) => {
      closed.push(receive);
      return Promise.resolve(() => {});
    }),
    ssoCloseLogin: vi.fn(() => Promise.resolve()),
  } satisfies AccountHost;
  const account = createAccount(host, {
    getItem: (key) => config.get(key) ?? null,
    setItem: (key, value) => {
      config.set(key, value);
    },
  });
  const login = account.loginWithSso;
  const first = login();
  await vi.waitFor(() => expect(host.ssoPollLogin).toHaveBeenCalledOnce());
  const firstId = host.ssoOpenLogin.mock.calls[0]![1];
  closed[0]?.(firstId);
  expect(account.state.getState().ssoPending).toBe(false);
  await expect(first).resolves.toBe(false);
  const second = login();
  await vi.waitFor(() => expect(host.ssoPollLogin).toHaveBeenCalledTimes(2));
  closed[1]?.(firstId);
  const late = {
    windowClosed: false,
    fetched: { status: 200, body: '{"uid":"late"}' },
  };
  finish[0]?.(late);
  expect(host.ssoCloseLogin).toHaveBeenCalledOnce();
  expect(account.state.getState().ssoPending).toBe(true);
  await account.dispose();
  finish[1]?.(late);
  await expect(second).resolves.toBe(false);
  expect(host.ssoCloseLogin).toHaveBeenCalledTimes(2);
  expect(account.state.getState().currentUser).toBeNull();
  expect(config.has(accountStorageKey)).toBe(false);
});
