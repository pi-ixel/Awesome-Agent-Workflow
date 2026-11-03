/**
 * 登录态 store（src/stores）：当前用户身份 + SSO 登录 + 手动身份登录。
 *
 * - SSO 主路径（Issue #247 链路，网关只认 W3 会话 Cookie）：端点与登录页
 *   构建期内置（core/authConfig.ts，不出现在任何界面）。流程编排在本层：
 *   开 **隐藏** 登录窗（有持久 cookie 时一次轮询即无感恢复）→ 轮询宿主
 *   读 cookie 调网关（hostRuntime.ssoPollLogin，纯传输）→ cookie 未落地
 *   则唤起登录窗给用户操作 → 响应契约解析在 core/auth.ts；失败原文折进
 *   ssoError 展示，绝不把半截身份写进状态；用户关登录窗 = 静默取消；
 * - 内置端点为空（本构建未对接内网）时登录界面直接呈现手动身份窗口：
 *   用户只填用户名（展示用）与工号（唯一区分身份）；唯一 ID 由本机按
 *   工号内部分配固定 UUID（不展示）——同一工号永远拿到同一个 ID，保证
 *   自验期间产生的数据有稳定归属；
 * - 持久化手写 localStorage + 逐字段类型守卫（对齐 settingsStore 惯例），
 *   坏数据整体回落未登录态。
 */
import { create } from "zustand";

import {
  describeSsoHttpFailure,
  parseSsoIdentity,
  type SsoFetchWire,
} from "../core/auth.ts";
import { SSO_ENDPOINT, SSO_LOGIN_URL } from "../core/authConfig.ts";
import { hostRuntime } from "../core/host.ts";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("auth");

/** SSO 登录总等待上限（秒）：登录窗可能需要人工介入，不是亚秒级接口。 */
const SSO_TIMEOUT_SECS = 180;

/** 登录轮询间隔（毫秒）：cookie 落地 / 用户完成登录的探测粒度。 */
const SSO_POLL_INTERVAL_MS = 1_500;

/**
 * cookie 已存在但网关仍 401 的容忍次数：cookie 半落地（登录跳转中途）
 * 的竞态窗口，连续 3 次（约 4.5s）还不通过才按失败展示。
 */
const SSO_UNAUTHORIZED_STRIKES = 3;

/** 登录来源：SSO 企业认证 | 手动输入（自验）。 */
export type AuthSource = "sso" | "dev";

/** 当前登录用户（统一形状，登录来源只影响 source 标记）。 */
export interface UserIdentity {
  /**
   * 唯一 ID：SSO 为认证方返回的唯一锚点；手动登录为本机按工号内部分配的
   * 固定 UUID（不展示）。
   */
  readonly id: string;
  /** 用户名（界面展示用）。 */
  readonly name: string;
  /** 工号（唯一区分身份）。 */
  readonly employeeId: string;
  readonly email: string | null;
  readonly department: string | null;
  readonly source: AuthSource;
  /** 登录时间（ISO 8601）。 */
  readonly loggedInAt: string;
}

/** 手动登录入参（表单只收这两项；store 再守一道）。 */
export interface DevIdentityInput {
  /** 用户名（界面展示用）。 */
  readonly name: string;
  /** 工号（唯一区分身份）。 */
  readonly employeeId: string;
}

interface AuthStoreState {
  readonly currentUser: UserIdentity | null;
  /** SSO 认证进行中（登录窗可能需要人工介入，等待可到分钟级）。 */
  readonly ssoPending: boolean;
  /** 最近一次 SSO 登录失败原因（登录界面展示；成功/取消即清空）。 */
  readonly ssoError: string | null;
  /** 发起 SSO 登录；返回是否成功（取消 / 失败均为 false，原因看 ssoError）。 */
  loginWithSso: () => Promise<boolean>;
  /** 放弃进行中的 SSO 认证等待（晚到的结果按代次丢弃）。 */
  cancelSsoLogin: () => void;
  /** 手动身份登录：用户名 + 工号，唯一 ID 本机按工号内部分配。 */
  loginAsDev: (input: DevIdentityInput) => UserIdentity;
  /** 退出登录。 */
  logout: () => void;
}

// ---------------------------------------------------------------------------
// SSO 端点解析（构建期内置；自验通道不出现在 UI）
// ---------------------------------------------------------------------------

/**
 * 自验通道（仅开发自验，见 docs/auth-login/README.md）：内置端点为空时，
 * 向 localStorage 写入该 key 可临时指定端点，免重新出包。
 */
const SSO_DEV_ENDPOINT_KEY = "aaw-desktop.auth.sso-dev-endpoint.v1";

/** 自验通道：登录页地址的临时覆盖（与端点 key 平行，内置为空时生效）。 */
const SSO_DEV_LOGIN_URL_KEY = "aaw-desktop.auth.sso-dev-login-url.v1";

/** 生效的 SSO 端点：内置配置优先；为空时读自验通道；都空 = 未配置。 */
export function resolveSsoEndpoint(): string {
  const builtin = SSO_ENDPOINT.trim();
  if (builtin !== "") {
    return builtin;
  }
  try {
    return (window.localStorage.getItem(SSO_DEV_ENDPOINT_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

/** 生效的 SSO 登录页地址：解析规则同端点（内置优先，自验通道兜底）。 */
export function resolveSsoLoginUrl(): string {
  const builtin = SSO_LOGIN_URL.trim();
  if (builtin !== "") {
    return builtin;
  }
  try {
    return (window.localStorage.getItem(SSO_DEV_LOGIN_URL_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

/** 本构建是否配置了 SSO（决定登录界面是否出现 SSO 入口）。 */
export function isSsoConfigured(): boolean {
  return resolveSsoEndpoint() !== "";
}

// SSO 自动尝试每进程只发一次（失败后留在手动入口，不循环重试）
let ssoAutoAttempted = false;

/** 进入登录界面时是否应自动发起一次 SSO 尝试（取走即记，幂等）。 */
export function shouldAttemptSsoOnce(): boolean {
  if (ssoAutoAttempted) {
    return false;
  }
  ssoAutoAttempted = true;
  return true;
}

/** 测试隔离：重置「每进程一次」的自动尝试标记。 */
export function resetSsoAutoAttemptForTests(): void {
  ssoAutoAttempted = false;
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
export function getDevUuidFor(employeeId: string): string {
  const key = employeeId.trim();
  try {
    const raw = window.localStorage.getItem(DEV_IDS_KEY);
    const map =
      raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
    const existing = map[key];
    if (typeof existing === "string" && UUID_PATTERN.test(existing)) {
      return existing;
    }
    const created = crypto.randomUUID();
    map[key] = created;
    window.localStorage.setItem(DEV_IDS_KEY, JSON.stringify(map));
    return created;
  } catch {
    // localStorage 不可用（极端环境）：会话内随机兜底，至少能完成自验
    return crypto.randomUUID();
  }
}

// ---------------------------------------------------------------------------
// 持久化（手写 localStorage + 类型守卫）
// ---------------------------------------------------------------------------

const STORAGE_KEY = "aaw-desktop.auth.v1";

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

function readPersistedAuth(): { user: UserIdentity | null } {
  try {
    return parsePersistedAuth(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { user: null };
  }
}

function persistAuth(user: UserIdentity | null): void {
  try {
    const record: AuthPersistRecord = { version: 1, user };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    logger.warn("登录态持久化失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// SSO 请求代次：取消 / 重发后晚到的响应按代次丢弃
// ---------------------------------------------------------------------------

let ssoGeneration = 0;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const initial = readPersistedAuth();

export const useAuthStore = create<AuthStoreState>()((set, get) => ({
  currentUser: initial.user,
  ssoPending: false,
  ssoError: null,

  async loginWithSso() {
    const endpoint = resolveSsoEndpoint();
    if (endpoint === "") {
      set({ ssoError: "本构建未配置企业 SSO 登录" });
      return false;
    }
    const loginUrl = resolveSsoLoginUrl();
    if (loginUrl === "") {
      set({ ssoError: "本构建未配置 SSO 登录页地址" });
      return false;
    }
    const generation = ++ssoGeneration;
    set({ ssoPending: true, ssoError: null });
    logger.info("发起 SSO 认证");
    // 收尾关窗（成功 / 失败 / 取消 / 异常统一执行；失败只记日志不打断）
    const closeLoginWindow = (): void => {
      hostRuntime.ssoCloseLogin().catch((error) => {
        logger.warn("SSO 登录窗关闭失败", { error: describeError(error) });
      });
    };
    try {
      // 开隐藏登录窗：已有持久 cookie 时一次轮询即成功，全程无窗口闪烁
      await hostRuntime.ssoOpenLogin(loginUrl);
      const deadline = Date.now() + SSO_TIMEOUT_SECS * 1_000;
      let windowShown = false;
      let unauthorizedStrikes = 0;
      let wire: SsoFetchWire | null = null;
      let cancelled = false;
      while (Date.now() < deadline) {
        if (generation !== ssoGeneration) {
          closeLoginWindow();
          return false; // 已取消或被新请求取代：晚到结果丢弃
        }
        const poll = await hostRuntime.ssoPollLogin(endpoint);
        if (generation !== ssoGeneration) {
          closeLoginWindow();
          return false;
        }
        if (poll.windowClosed) {
          cancelled = true; // 用户关登录窗 = 放弃：静默回手动入口，不报错
          break;
        }
        if (poll.fetched === null) {
          // cookie 还没落地：首次等待时唤起登录窗给用户操作（幂等）
          if (!windowShown) {
            windowShown = true;
            await hostRuntime.ssoOpenLogin(loginUrl);
          }
        } else if (poll.fetched.status >= 200 && poll.fetched.status < 300) {
          wire = poll.fetched;
          break;
        } else if (poll.fetched.status === 401) {
          // cookie 已存在但网关不认：半落地竞态，容忍几次后按失败展示
          unauthorizedStrikes += 1;
          if (unauthorizedStrikes >= SSO_UNAUTHORIZED_STRIKES) {
            wire = poll.fetched;
            break;
          }
        } else {
          wire = poll.fetched; // 其它非 2xx（网关异常等）：立即按失败展示
          break;
        }
        await sleep(SSO_POLL_INTERVAL_MS);
      }
      closeLoginWindow();
      if (generation !== ssoGeneration) {
        return false;
      }
      if (cancelled) {
        set({ ssoPending: false });
        logger.info("SSO 登录窗口被用户关闭，已放弃本次认证");
        return false;
      }
      if (wire === null) {
        set({
          ssoPending: false,
          ssoError: `SSO 登录超时（${SSO_TIMEOUT_SECS}s）未完成，请重试或改用手动登录`,
        });
        return false;
      }
      if (wire.status < 200 || wire.status >= 300) {
        const message = describeSsoHttpFailure(wire);
        logger.warn("SSO 认证接口返回非 2xx", { status: wire.status });
        set({ ssoPending: false, ssoError: message });
        return false;
      }
      // 契约解析（可能抛错，统一折进 ssoError）
      const identity = parseSsoIdentity(wire.body);
      const user: UserIdentity = {
        id: identity.userId,
        name: identity.name,
        employeeId: identity.employeeId ?? "",
        email: identity.email,
        department: identity.department,
        source: "sso",
        loggedInAt: new Date().toISOString(),
      };
      persistAuth(user);
      set({ currentUser: user, ssoPending: false, ssoError: null });
      logger.info("SSO 登录成功", { userId: user.id, name: user.name });
      return true;
    } catch (error) {
      closeLoginWindow();
      if (generation !== ssoGeneration) {
        return false;
      }
      const message = describeError(error);
      logger.warn("SSO 登录失败", { error: message });
      set({ ssoPending: false, ssoError: message });
      return false;
    }
  },

  cancelSsoLogin() {
    if (!get().ssoPending) {
      return;
    }
    ssoGeneration += 1; // 晚到的响应按代次丢弃
    set({ ssoPending: false });
    // 取消等待的同时撤下登录窗（用户视角：界面与窗口一起回到未登录态）
    hostRuntime.ssoCloseLogin().catch((error) => {
      logger.warn("SSO 登录窗关闭失败", { error: describeError(error) });
    });
    logger.info("已取消 SSO 认证等待");
  },

  loginAsDev(input) {
    const name = input.name.trim();
    const employeeId = input.employeeId.trim();
    if (name === "" || employeeId === "") {
      throw new Error("请填写用户名和工号");
    }
    const user: UserIdentity = {
      id: getDevUuidFor(employeeId), // 按工号内部分配，同一工号永远同一个 ID
      name,
      employeeId,
      email: null,
      department: null,
      source: "dev",
      loggedInAt: new Date().toISOString(),
    };
    persistAuth(user);
    set({ currentUser: user, ssoPending: false, ssoError: null });
    logger.info("手动身份登录", { userId: user.id, employeeId });
    return user;
  },

  logout() {
    persistAuth(null);
    set({ currentUser: null, ssoPending: false, ssoError: null });
    logger.info("已退出登录");
  },
}));
