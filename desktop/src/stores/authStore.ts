/**
 * 登录态 store（src/stores）：当前用户身份 + SSO 登录 + 开发者降级登录。
 *
 * - SSO 主路径：调 hostRuntime.ssoLogin（src-tauri auth_sso.rs 纯传输），
 *   响应契约解析在 core/auth.ts；非 2xx / 解析失败都折成 ssoError 文案，
 *   由登录界面展示，绝不把半截身份写进状态；
 * - 降级路径（对接内网前的功能自验）：开发者手填姓名 + 工号，唯一 ID 用
 *   本机固定 UUID（首次生成后持久化，之后每次降级登录复用同一个值，
 *   logout 不回收）——保证自验期间产生的数据有稳定归属；
 * - 持久化手写 localStorage + 逐字段类型守卫（对齐 settingsStore 惯例，
 *   不用 persist 中间件），坏数据整体回落未登录态。
 */
import { create } from "zustand";

import { describeSsoHttpFailure, parseSsoIdentity } from "../core/auth.ts";
import { hostRuntime } from "../core/host.ts";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("auth");

/** SSO 认证请求超时（秒）：认证页可能需要人工介入，不是亚秒级接口。 */
const SSO_TIMEOUT_SECS = 180;

/** 登录来源：SSO 企业认证 | 开发者降级（自验）。 */
export type AuthSource = "sso" | "dev";

/** 当前登录用户（统一形状，登录来源只影响 source 标记）。 */
export interface UserIdentity {
  /** 唯一 ID：SSO 为认证方返回的唯一锚点；降级为本机固定 UUID。 */
  readonly id: string;
  readonly name: string;
  readonly employeeId: string;
  readonly email: string | null;
  readonly department: string | null;
  readonly source: AuthSource;
  /** 登录时间（ISO 8601）。 */
  readonly loggedInAt: string;
}

/** 降级登录入参（表单必填项；store 再守一道）。 */
export interface DevIdentityInput {
  readonly name: string;
  readonly employeeId: string;
  readonly email?: string;
}

interface AuthStoreState {
  readonly currentUser: UserIdentity | null;
  /** SSO 认证接口地址（本机配置，随登录态一起持久化）。 */
  readonly ssoEndpoint: string;
  /** SSO 认证进行中（服务端弹认证页，可能等待到分钟级）。 */
  readonly ssoPending: boolean;
  /** 最近一次 SSO 登录失败原因（登录界面展示；成功/取消即清空）。 */
  readonly ssoError: string | null;
  setSsoEndpoint: (endpoint: string) => void;
  /** 发起 SSO 登录；返回是否成功（取消 / 失败均为 false，原因看 ssoError）。 */
  loginWithSso: () => Promise<boolean>;
  /** 放弃进行中的 SSO 认证等待（晚到的结果按代次丢弃）。 */
  cancelSsoLogin: () => void;
  /** 开发者降级登录：手填身份 + 本机固定 UUID。 */
  loginAsDev: (input: DevIdentityInput) => UserIdentity;
  /** 退出登录（保留 SSO 端点配置与固定 UUID）。 */
  logout: () => void;
}

// ---------------------------------------------------------------------------
// 持久化（手写 localStorage + 类型守卫）
// ---------------------------------------------------------------------------

const STORAGE_KEY = "aaw-desktop.auth.v1";
/** 本机固定 UUID：独立于登录态持久化，logout / 换身份不回收。 */
const DEV_UUID_KEY = "aaw-desktop.auth.dev-uuid.v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AuthPersistRecord {
  readonly version: 1;
  readonly user: UserIdentity | null;
  readonly ssoEndpoint: string;
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
 * 非法 JSON / 字段形状不对 → 整体回落未登录 + 空端点配置。
 */
export function parsePersistedAuth(raw: string | null): {
  user: UserIdentity | null;
  ssoEndpoint: string;
} {
  if (raw === null) {
    return { user: null, ssoEndpoint: "" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { user: null, ssoEndpoint: "" };
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    const endpoint = record["ssoEndpoint"];
    return {
      user: asUserIdentity(record["user"]),
      ssoEndpoint: typeof endpoint === "string" ? endpoint : "",
    };
  } catch {
    return { user: null, ssoEndpoint: "" };
  }
}

function readPersistedAuth(): {
  user: UserIdentity | null;
  ssoEndpoint: string;
} {
  try {
    return parsePersistedAuth(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { user: null, ssoEndpoint: "" };
  }
}

function persistAuth(user: UserIdentity | null, ssoEndpoint: string): void {
  try {
    const record: AuthPersistRecord = { version: 1, user, ssoEndpoint };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    logger.warn("登录态持久化失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 本机固定 UUID（降级登录唯一 ID）：首次调用生成并落盘，之后永远复用。
 * 独立 storage key——清登录态、换身份都不回收，保证自验数据归属稳定。
 */
export function getDevUuid(): string {
  try {
    const existing = window.localStorage.getItem(DEV_UUID_KEY);
    if (existing !== null && UUID_PATTERN.test(existing)) {
      return existing;
    }
    const created = crypto.randomUUID();
    window.localStorage.setItem(DEV_UUID_KEY, created);
    return created;
  } catch {
    // localStorage 不可用（极端环境）：会话内随机兜底，至少能完成自验
    return crypto.randomUUID();
  }
}

// ---------------------------------------------------------------------------
// SSO 请求代次：取消 / 重发后晚到的响应按代次丢弃
// ---------------------------------------------------------------------------

let ssoGeneration = 0;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const initial = readPersistedAuth();

export const useAuthStore = create<AuthStoreState>()((set, get) => ({
  currentUser: initial.user,
  ssoEndpoint: initial.ssoEndpoint,
  ssoPending: false,
  ssoError: null,

  setSsoEndpoint(endpoint) {
    set({ ssoEndpoint: endpoint });
    persistAuth(get().currentUser, endpoint);
  },

  async loginWithSso() {
    const endpoint = get().ssoEndpoint.trim();
    if (endpoint === "") {
      set({ ssoError: "请先填写企业 SSO 认证接口地址" });
      return false;
    }
    const generation = ++ssoGeneration;
    set({ ssoPending: true, ssoError: null });
    logger.info("发起 SSO 认证", { endpoint });
    try {
      const wire = await hostRuntime.ssoLogin({
        endpoint,
        timeoutSecs: SSO_TIMEOUT_SECS,
      });
      if (generation !== ssoGeneration) {
        return false; // 已取消或被新请求取代：晚到结果丢弃
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
      persistAuth(user, get().ssoEndpoint);
      set({ currentUser: user, ssoPending: false, ssoError: null });
      logger.info("SSO 登录成功", { userId: user.id, name: user.name });
      return true;
    } catch (error) {
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
    logger.info("已取消 SSO 认证等待");
  },

  loginAsDev(input) {
    const name = input.name.trim();
    const employeeId = input.employeeId.trim();
    if (name === "" || employeeId === "") {
      throw new Error("姓名与工号为必填项");
    }
    const user: UserIdentity = {
      id: getDevUuid(), // 固定 UUID：首次生成后永久复用
      name,
      employeeId,
      email: input.email?.trim() || null,
      department: null,
      source: "dev",
      loggedInAt: new Date().toISOString(),
    };
    persistAuth(user, get().ssoEndpoint);
    set({ currentUser: user, ssoPending: false, ssoError: null });
    logger.info("开发者降级登录", { userId: user.id, name: user.name });
    return user;
  },

  logout() {
    // 保留 ssoEndpoint 与固定 UUID：退出只是清身份，不丢本机配置
    persistAuth(null, get().ssoEndpoint);
    set({ currentUser: null, ssoPending: false, ssoError: null });
    logger.info("已退出登录");
  },
}));
