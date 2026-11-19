import type { AccountHost, HostStorage } from "../../host/types.ts";
import type { AccountSnapshot, AuthSource, UserIdentity } from "../types.ts";
import type { AccountService } from "../service.ts";
import type { ConfigurationScope } from "../../configuration/types.ts";
/**
 * 登录态 store（src/stores）：当前用户身份 + SSO 登录 + 手动身份登录。
 *
 * - SSO 主路径（Issue #247 链路，网关只认 W3 会话 Cookie）：端点与登录页
 *   构建期内置（core/authConfig.ts，不出现在任何界面）。流程编排在本层：
 *   开 **隐藏** 登录窗（有持久 cookie 时一次轮询即无感恢复）→ 轮询宿主
 *   通过宿主端口读 cookie 并请求网关 → cookie 未落地
 *   或失效则唤起登录窗给用户操作。交互期间校验失败时继续等待；关窗即取消。
 * - 内置端点为空（本构建未对接内网）时登录界面直接呈现手动身份窗口：
 *   用户只填用户名（展示用）与工号（唯一区分身份）；唯一 ID 由本机按
 *   工号内部分配固定 UUID（不展示）——同一工号永远拿到同一个 ID，保证
 *   自验期间产生的数据有稳定归属；
 * - 持久化手写 localStorage + 逐字段类型守卫（对齐 settingsStore 惯例），
 *   坏数据整体回落未登录态。
 */
import { createStore } from "zustand";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";

import { describeSsoHttpFailure, parseSsoIdentity } from "./identity.ts";
import { SSO_ENDPOINT, SSO_LOGIN_URL } from "../sso/authConfig.ts";
import { createLogger, type Logger } from "../../../shared/logging/logger.ts";
import {
  accountStorageKey,
  SSO_POLL_INTERVAL_MS,
  SSO_TIMEOUT_SECS,
  SSO_HOST_TIMEOUT_MS,
} from "../config.ts";


// ---------------------------------------------------------------------------
// SSO 端点解析（构建期内置；自验通道不出现在 UI）
// ---------------------------------------------------------------------------

/**
 * 自验通道（仅开发自验，见 docs/features/auth-login/README.md）：内置端点为空时，
 * 向 localStorage 写入该 key 可临时指定端点，免重新出包。
 */
const SSO_DEV_ENDPOINT_KEY = "aaw-desktop.auth.sso-dev-endpoint.v1";

/** 自验通道：登录页地址的临时覆盖（与端点 key 平行，内置为空时生效）。 */
const SSO_DEV_LOGIN_URL_KEY = "aaw-desktop.auth.sso-dev-login-url.v1";

/** 生效的 SSO 端点：内置配置优先；为空时读自验通道；都空 = 未配置。 */
export function resolveSsoEndpoint(storage: HostStorage): string {
  const builtin = SSO_ENDPOINT.trim();
  if (builtin !== "") {
    return builtin;
  }
  try {
    return (storage.getItem(SSO_DEV_ENDPOINT_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

/** 生效的 SSO 登录页地址：解析规则同端点（内置优先，自验通道兜底）。 */
export function resolveSsoLoginUrl(storage: HostStorage): string {
  const builtin = SSO_LOGIN_URL.trim();
  if (builtin !== "") {
    return builtin;
  }
  try {
    return (storage.getItem(SSO_DEV_LOGIN_URL_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

/** 本构建是否配置了 SSO（决定登录界面是否出现 SSO 入口）。 */
export function isSsoConfigured(storage: HostStorage): boolean {
  return resolveSsoEndpoint(storage) !== "";
}

// ---------------------------------------------------------------------------
// 手动登录的内部唯一 ID：按工号分配本机固定 UUID（不展示）
// ---------------------------------------------------------------------------

const DEV_IDS_KEY = "aaw-desktop.auth.dev-ids.v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 工号 → 固定 UUID（首次分配后持久化，之后同一工号永远同一个 ID）。
 * UUID 不出 UI，工号才是用户感知的身份标识。
 */
export function getDevUuidFor(
  employeeId: string,
  storage: HostStorage,
): string {
  const key = employeeId.trim();
  try {
    const raw = storage.getItem(DEV_IDS_KEY);
    const map =
      raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
    const existing = map[key];
    if (typeof existing === "string" && UUID_PATTERN.test(existing)) {
      return existing;
    }
    const created = crypto.randomUUID();
    map[key] = created;
    storage.setItem(DEV_IDS_KEY, JSON.stringify(map));
    return created;
  } catch {
    // localStorage 不可用（极端环境）：会话内随机兜底，至少能完成自验
    return crypto.randomUUID();
  }
}

// ---------------------------------------------------------------------------
// 持久化（手写 localStorage + 类型守卫）
// ---------------------------------------------------------------------------


interface AuthPersistRecord {
  readonly version: 1;
  readonly user: UserIdentity | null;
}

function isAuthSource(value: unknown): value is AuthSource {
  return value === "sso" || value === "dev";
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** UserIdentity 逐字段守卫：形状不对的持久化值不进状态。 */
function asUserIdentity(raw: unknown): UserIdentity | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const id = record["id"];
  const name = record["name"];
  const employeeId = record["employeeId"];
  const loggedInAt = record["loggedInAt"];
  if (
    typeof id !== "string" ||
    id === "" ||
    typeof name !== "string" ||
    name === "" ||
    typeof employeeId !== "string" ||
    typeof loggedInAt !== "string"
  ) {
    return null;
  }
  if (!isAuthSource(record["source"])) {
    return null;
  }
  return {
    id,
    name,
    employeeId,
    email: asOptionalString(record["email"]),
    department: asOptionalString(record["department"]),
    source: record["source"],
    loggedInAt,
  };
}

/**
 * 解析持久化登录记录（导出供测试直接覆盖坏数据分支）：
 * 非法 JSON / 字段形状不对 → 整体回落未登录。
 */
export function parsePersistedAuth(raw: string | null): {
  user: UserIdentity | null;
} {
  if (raw === null) {
    return { user: null };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { user: null };
    }
    return {
      user: asUserIdentity(
        (parsed as Readonly<Record<string, unknown>>)["user"],
      ),
    };
  } catch {
    return { user: null };
  }
}

function readPersistedAuth(
  storage: HostStorage,
  scope?: ConfigurationScope,
): { user: UserIdentity | null } {
  try {
    return parsePersistedAuth(
      scope ? JSON.stringify(scope.read()) : storage.getItem(accountStorageKey),
    );
  } catch {
    return { user: null };
  }
}

function persistAuth(
  storage: HostStorage,
  scope: ConfigurationScope | undefined,
  user: UserIdentity | null,
  logger: Logger,
): void {
  try {
    const record: AuthPersistRecord = { version: 1, user };
    if (scope) scope.update({ ...record });
    else storage.setItem(accountStorageKey, JSON.stringify(record));
  } catch (error) {
    logger.warn("登录态持久化失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// SSO 请求代次：取消 / 重发后晚到的响应按代次丢弃
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

class SsoHostTimeout extends Error {}

async function waitForSso<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new SsoHostTimeout("SSO 宿主响应超时，请重试")),
        timeoutMs,
      );
      abort = () => reject(new Error("SSO 登录已取消"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      void operation.then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export function createAccount(
  host: AccountHost,
  storage: HostStorage,
  scope?: ConfigurationScope,
  logger = createLogger("auth"),
) {
  let ssoGeneration = 0;
  let ssoAutoAttempted = false;
  let disposed = false;
  let attempt: { id: string; controller: AbortController } | undefined;
  let closeTask = Promise.resolve();
  const closeLoginWindow = (id: string) => {
    const closing = Promise.resolve().then(() => host.ssoCloseLogin(id));
    closeTask = waitForSso(closing, SSO_HOST_TIMEOUT_MS).catch((error: unknown) => {
      logger.warn("SSO 登录窗关闭失败", { error: describeError(error) });
    });
  };
  const initial = readPersistedAuth(storage, scope);
  const state = createStore<AccountSnapshot>(() => ({
    currentUser: initial.user,
    ssoPending: false,
    ssoAttemptId: 0,
    ssoError: null,
  }));
  const { setState: set, getState: get } = state;
  const view = createSnapshotView(state, (snapshot) => snapshot);
  const commands: Pick<
    AccountService,
    "loginWithSso" | "cancelSsoLogin" | "loginAsDev" | "logout"
  > = {
    async loginWithSso() {
      if (disposed) return false;
      const endpoint = resolveSsoEndpoint(storage);
      if (endpoint === "") {
        set({ ssoError: "本构建未配置企业 SSO 登录" });
        return false;
      }
      const loginUrl = resolveSsoLoginUrl(storage);
      if (loginUrl === "") {
        set({ ssoError: "本构建未配置 SSO 登录页地址" });
        return false;
      }
      commands.cancelSsoLogin();
      const generation = ++ssoGeneration;
      const controller = new AbortController();
      const id = crypto.randomUUID();
      attempt = { id, controller };
      const { signal } = controller;
      const deadline = Date.now() + SSO_TIMEOUT_SECS * 1_000;
      const remaining = () => Math.max(0, deadline - Date.now());
      const wait = <T>(operation: Promise<T>) =>
        waitForSso(operation, Math.min(remaining(), SSO_HOST_TIMEOUT_MS), signal);
      let unlisten: (() => void) | undefined;
      let lastError: string | undefined;
      const fail = (error?: string): false => {
        const timeout = `SSO 登录超时（${SSO_TIMEOUT_SECS}s）未完成，请重试或改用手动登录`;
        const message =
          error ?? (lastError ? `${timeout}。最近一次校验：${lastError}` : timeout);
        logger.warn("SSO 登录失败", { error: message });
        set({ ssoError: message });
        return false;
      };
      set({ ssoPending: true, ssoError: null, ssoAttemptId: generation });
      logger.info("发起 SSO 认证");
      try {
        const listening = host.listenForSsoClose((closedId) => {
          if (closedId === id && !signal.aborted) {
            logger.info("SSO 登录窗口已关闭，结束本次认证");
            commands.cancelSsoLogin();
          }
        }).then((stop) => {
          if (signal.aborted) stop();
          else unlisten = stop;
        });
        await wait(listening);
        signal.throwIfAborted();
        await wait(host.ssoOpenLogin(loginUrl, id));
        let windowShown = false;
        while (remaining() > 0) {
          signal.throwIfAborted();
          const poll = await wait(host.ssoPollLogin(endpoint, id)).catch(
            (error: unknown) => {
              if (
                !windowShown ||
                signal.aborted ||
                error instanceof SsoHostTimeout
              ) {
                throw error;
              }
              lastError = describeError(error);
              return null;
            },
          );
          signal.throwIfAborted();
          if (poll?.windowClosed) {
            logger.info("SSO 登录窗口已关闭，结束本次认证");
            return false;
          }
          const wire = poll?.fetched;
          if (wire && wire.status >= 200 && wire.status < 300) {
            let identity: ReturnType<typeof parseSsoIdentity> | undefined;
            try {
              identity = parseSsoIdentity(wire.body);
            } catch (error) {
              if (!windowShown) throw error;
              lastError = describeError(error);
            }
            if (identity) {
              const user: UserIdentity = {
                id: identity.userId,
                name: identity.name,
                employeeId: identity.employeeId ?? "",
                email: identity.email,
                department: identity.department,
                source: "sso",
                loggedInAt: new Date().toISOString(),
              };
              persistAuth(storage, scope, user, logger);
              set({ currentUser: user, ssoPending: false, ssoError: null });
              logger.info("SSO 登录成功", { userId: user.id, name: user.name });
              return true;
            }
          } else if (wire) {
            lastError = describeSsoHttpFailure(wire);
            if (!windowShown && wire.status !== 401) throw new Error(lastError);
          }
          // 没有 Cookie 或已有会话被拒绝时，唤起 W3 窗口让用户完成登录。
          if (!windowShown) {
            await wait(host.ssoOpenLogin(loginUrl, id));
            windowShown = true;
          }
          await sleep(Math.min(remaining(), SSO_POLL_INTERVAL_MS), signal);
        }
        signal.throwIfAborted();
        return fail();
      } catch (error) {
        if (signal.aborted) return false;
        return fail(remaining() > 0 ? describeError(error) : undefined);
      } finally {
        controller.abort();
        unlisten?.();
        if (attempt?.id === id) {
          attempt = undefined;
          closeLoginWindow(id);
          set({ ssoPending: false });
        }
      }
    },

    cancelSsoLogin() {
      if (!get().ssoPending) {
        return;
      }
      const cancelled = attempt;
      attempt = undefined;
      cancelled?.controller.abort();
      if (cancelled) closeLoginWindow(cancelled.id);
      set({ ssoPending: false });
      logger.info("已取消 SSO 认证等待");
    },

    loginAsDev(input) {
      if (disposed) throw new Error("Account service is disposed");
      const name = input.name.trim();
      const employeeId = input.employeeId.trim();
      if (name === "" || employeeId === "") {
        throw new Error("请填写用户名和工号");
      }
      commands.cancelSsoLogin();
      const user: UserIdentity = {
        id: getDevUuidFor(employeeId, storage), // 按工号内部分配，同一工号永远同一个 ID
        name,
        employeeId,
        email: null,
        department: null,
        source: "dev",
        loggedInAt: new Date().toISOString(),
      };
      persistAuth(storage, scope, user, logger);
      set({ currentUser: user, ssoPending: false, ssoError: null });
      logger.info("手动身份登录", { userId: user.id, employeeId });
      return user;
    },

    logout() {
      if (disposed) return;
      commands.cancelSsoLogin();
      persistAuth(storage, scope, null, logger);
      set({ currentUser: null, ssoPending: false, ssoError: null });
      logger.info("已退出登录");
    },
  };
  return {
    state: view.snapshot,
    ...commands,
    isSsoConfigured: () => isSsoConfigured(storage),
    trySsoOnce() {
      if (disposed || ssoAutoAttempted || !isSsoConfigured(storage)) return;
      ssoAutoAttempted = true;
      void commands.loginWithSso();
    },
    async dispose(this: void) {
      if (disposed) return closeTask;
      disposed = true;
      view.dispose();
      commands.cancelSsoLogin();
      state.setState({
        currentUser: null,
        ssoAttemptId: 0,
        ssoPending: false,
        ssoError: null,
      });
      await closeTask;
    },
  } satisfies AccountService & { dispose(this: void): Promise<void> };
}
