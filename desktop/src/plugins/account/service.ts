import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { AccountSnapshot, DevIdentityInput, UserIdentity } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    account: AccountService;
  }
}

export interface AccountService {
  readonly state: ReadonlySnapshot<AccountSnapshot>;
  isSsoConfigured(): boolean;
  trySsoOnce(): void;
  loginWithSso(this: void): Promise<boolean>;
  cancelSsoLogin(this: void): void;
  loginAsDev(this: void, input: DevIdentityInput): UserIdentity;
  logout(this: void): void;
}
