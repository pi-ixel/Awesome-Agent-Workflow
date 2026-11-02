/**
 * stores/authStore 测试：SSO 登录成功 / 失败 / 非法契约 / 取消代次、
 * 开发者降级登录（固定 UUID 稳定复用）、持久化与坏数据回落、退出语义。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { demoHost, hostRuntime } from "../../src/core/host";
import {
  getDevUuid,
  parsePersistedAuth,
  useAuthStore,
} from "../../src/stores/authStore";

const storageKey = "aaw-desktop.auth.v1";
const devUuidKey = "aaw-desktop.auth.dev-uuid.v1";

/** 重置登录态到未登录（不动 localStorage——需要现场隔离的用例自己清）。 */
function resetAuthState(): void {
  useAuthStore.setState({
    currentUser: null,
    ssoEndpoint: "",
    ssoPending: false,
    ssoError: null,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  demoHost.reset();
  resetAuthState();
});

describe("SSO 登录", () => {
  it("端点为空：直接报错，不发起请求", async () => {
    const ok = await useAuthStore.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(useAuthStore.getState().ssoError).toContain("接口地址");
    expect(useAuthStore.getState().ssoPending).toBe(false);
  });

  it("2xx + 合法契约：写入当前用户（source=sso）并持久化", async () => {
    useAuthStore.getState().setSsoEndpoint("https://sso.internal/auth");
    demoHost.scriptSsoFetch({
      status: 200,
      body: JSON.stringify({
        userId: "sso-1",
        name: "张三",
        employeeId: "100001",
        email: "z@example.com",
        department: "平台部",
      }),
    });
    const ok = await useAuthStore.getState().loginWithSso();
    expect(ok).toBe(true);
    const user = useAuthStore.getState().currentUser;
    expect(user).toMatchObject({
      id: "sso-1",
      name: "张三",
      employeeId: "100001",
      source: "sso",
    });
    // 持久化里有同一份身份，ssoError 已清空
    const persisted = parsePersistedAuth(
      window.localStorage.getItem(storageKey),
    );
    expect(persisted.user?.id).toBe("sso-1");
    expect(useAuthStore.getState().ssoError).toBeNull();
  });

  it("非 2xx：响应原文进 ssoError，不落身份", async () => {
    useAuthStore.getState().setSsoEndpoint("https://sso.internal/auth");
    demoHost.scriptSsoFetch({ status: 401, body: '{"message":"未授权"}' });
    const ok = await useAuthStore.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(useAuthStore.getState().ssoError).toContain("HTTP 401");
    expect(useAuthStore.getState().ssoError).toContain("未授权");
    expect(useAuthStore.getState().currentUser).toBeNull();
  });

  it("2xx 但契约不合法：解析错误折进 ssoError，不落半截身份", async () => {
    useAuthStore.getState().setSsoEndpoint("https://sso.internal/auth");
    demoHost.scriptSsoFetch({
      status: 200,
      body: JSON.stringify({ code: 0, message: "ok" }),
    });
    const ok = await useAuthStore.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(useAuthStore.getState().ssoError).toContain("无法从 SSO 响应中解析");
    expect(useAuthStore.getState().currentUser).toBeNull();
  });

  it("传输失败（宿主报错）：原因进 ssoError", async () => {
    useAuthStore.getState().setSsoEndpoint("https://sso.internal/auth");
    demoHost.scriptSsoFetch(new Error("network down"));
    const ok = await useAuthStore.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(useAuthStore.getState().ssoError).toContain("network down");
  });

  it("取消后晚到的成功响应按代次丢弃", async () => {
    useAuthStore.getState().setSsoEndpoint("https://sso.internal/auth");
    let resolveLogin!: (wire: { status: number; body: string }) => void;
    const deferred = new Promise<{ status: number; body: string }>(
      (resolve) => {
        resolveLogin = resolve;
      },
    );
    const spy = vi.spyOn(hostRuntime, "ssoLogin").mockReturnValueOnce(deferred);

    const pending = useAuthStore.getState().loginWithSso();
    expect(useAuthStore.getState().ssoPending).toBe(true);
    useAuthStore.getState().cancelSsoLogin();
    expect(useAuthStore.getState().ssoPending).toBe(false);

    resolveLogin({ status: 200, body: JSON.stringify({ userId: "late-1" }) });
    expect(await pending).toBe(false);
    expect(useAuthStore.getState().currentUser).toBeNull();
    spy.mockRestore();
  });
});

describe("开发者降级登录", () => {
  it("手填身份 + 固定 UUID：写入状态并持久化", () => {
    const user = useAuthStore.getState().loginAsDev({
      name: "张三",
      employeeId: "100001",
      email: "z@example.com",
    });
    expect(user).toMatchObject({
      id: getDevUuid(),
      name: "张三",
      employeeId: "100001",
      email: "z@example.com",
      source: "dev",
    });
    const persisted = parsePersistedAuth(
      window.localStorage.getItem(storageKey),
    );
    expect(persisted.user?.source).toBe("dev");
  });

  it("固定 UUID 在退出重登后保持不变", () => {
    const first = useAuthStore.getState().loginAsDev({
      name: "张三",
      employeeId: "100001",
    });
    useAuthStore.getState().logout();
    const second = useAuthStore.getState().loginAsDev({
      name: "张三",
      employeeId: "100001",
    });
    expect(second.id).toBe(first.id);
    // 且与直接读盘的固定 UUID 一致
    expect(second.id).toBe(window.localStorage.getItem(devUuidKey));
  });

  it("姓名 / 工号为空：抛错且不写状态", () => {
    expect(() =>
      useAuthStore.getState().loginAsDev({ name: "  ", employeeId: "1" }),
    ).toThrow(/必填/);
    expect(() =>
      useAuthStore.getState().loginAsDev({ name: "张三", employeeId: "" }),
    ).toThrow(/必填/);
    expect(useAuthStore.getState().currentUser).toBeNull();
  });

  it("getDevUuid：同一 localStorage 下多次读取稳定；坏值自动重建", () => {
    const first = getDevUuid();
    expect(getDevUuid()).toBe(first);
    window.localStorage.setItem(devUuidKey, "not-a-uuid");
    const rebuilt = getDevUuid();
    expect(rebuilt).not.toBe("not-a-uuid");
    expect(getDevUuid()).toBe(rebuilt);
  });
});

describe("持久化与恢复", () => {
  it("退出登录：身份清空，SSO 端点配置与固定 UUID 保留", () => {
    useAuthStore.getState().setSsoEndpoint("https://sso.internal/auth");
    useAuthStore.getState().loginAsDev({ name: "张三", employeeId: "100001" });
    const uuid = getDevUuid();

    useAuthStore.getState().logout();
    expect(useAuthStore.getState().currentUser).toBeNull();
    const persisted = parsePersistedAuth(
      window.localStorage.getItem(storageKey),
    );
    expect(persisted.user).toBeNull();
    expect(persisted.ssoEndpoint).toBe("https://sso.internal/auth");
    expect(window.localStorage.getItem(devUuidKey)).toBe(uuid);
  });

  it("坏持久化数据：整体回落未登录 + 空端点", () => {
    for (const raw of [
      "not json",
      JSON.stringify({ version: 1, user: { id: 42 }, ssoEndpoint: 3 }),
      JSON.stringify(null),
    ]) {
      const parsed = parsePersistedAuth(raw);
      expect(parsed.user).toBeNull();
      expect(parsed.ssoEndpoint).toBe("");
    }
    expect(parsePersistedAuth(null).user).toBeNull();
  });

  it("身份字段缺关键项：该用户记录被丢弃（email 等可选项允许缺失）", () => {
    expect(
      parsePersistedAuth(
        JSON.stringify({
          version: 1,
          user: { name: "张三", source: "dev", loggedInAt: "x" },
          ssoEndpoint: "",
        }),
      ).user,
    ).toBeNull();
    expect(
      parsePersistedAuth(
        JSON.stringify({
          version: 1,
          user: {
            id: "i",
            name: "张三",
            employeeId: "1",
            source: "dev",
            loggedInAt: "x",
          },
          ssoEndpoint: "",
        }),
      ).user,
    ).toMatchObject({ id: "i", email: null });
  });
});
