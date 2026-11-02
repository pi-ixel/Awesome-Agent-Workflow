/**
 * stores/authStore 测试：SSO 登录成功 / 失败 / 非法契约 / 取消代次、
 * 手动身份登录（用户名 + 工号，内部按工号固定 UUID）、持久化与坏数据
 * 回落、退出语义。端点来源为构建期内置 + 自验通道（localStorage key）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { demoHost, hostRuntime } from "../../src/core/host";
import {
  getDevUuidFor,
  isSsoConfigured,
  parsePersistedAuth,
  resolveSsoEndpoint,
  useAuthStore,
} from "../../src/stores/authStore";

const storageKey = "aaw-desktop.auth.v1";
const devIdsKey = "aaw-desktop.auth.dev-ids.v1";
const ssoDevEndpointKey = "aaw-desktop.auth.sso-dev-endpoint.v1";

/** 重置登录态到未登录（不动 localStorage——需要现场隔离的用例自己清）。 */
function resetAuthState(): void {
  useAuthStore.setState({
    currentUser: null,
    ssoPending: false,
    ssoError: null,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  demoHost.reset();
  resetAuthState();
});

describe("SSO 端点解析", () => {
  it("内置端点为空且无自验通道：未配置；写入自验通道后生效", () => {
    expect(resolveSsoEndpoint()).toBe("");
    expect(isSsoConfigured()).toBe(false);
    window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
    expect(resolveSsoEndpoint()).toBe("https://sso.internal/auth");
    expect(isSsoConfigured()).toBe(true);
  });
});

describe("SSO 登录", () => {
  it("端点未配置：直接报错，不发起请求", async () => {
    const ok = await useAuthStore.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(useAuthStore.getState().ssoError).toContain("未配置");
    expect(useAuthStore.getState().ssoPending).toBe(false);
  });

  it("2xx + 合法契约：写入当前用户（source=sso）并持久化", async () => {
    window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
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
    const persisted = parsePersistedAuth(
      window.localStorage.getItem(storageKey),
    );
    expect(persisted.user?.id).toBe("sso-1");
    expect(useAuthStore.getState().ssoError).toBeNull();
  });

  it("非 2xx：响应原文进 ssoError，不落身份", async () => {
    window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
    demoHost.scriptSsoFetch({ status: 401, body: '{"message":"未授权"}' });
    const ok = await useAuthStore.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(useAuthStore.getState().ssoError).toContain("HTTP 401");
    expect(useAuthStore.getState().ssoError).toContain("未授权");
    expect(useAuthStore.getState().currentUser).toBeNull();
  });

  it("2xx 但契约不合法：解析错误折进 ssoError，不落半截身份", async () => {
    window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
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
    window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
    demoHost.scriptSsoFetch(new Error("network down"));
    const ok = await useAuthStore.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(useAuthStore.getState().ssoError).toContain("network down");
  });

  it("取消后晚到的成功响应按代次丢弃", async () => {
    window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
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

describe("手动身份登录", () => {
  it("用户名 + 工号即可登录：唯一 ID 为内部按工号分配的固定 UUID", () => {
    const user = useAuthStore.getState().loginAsDev({
      name: "张三",
      employeeId: "100001",
    });
    expect(user).toMatchObject({
      id: getDevUuidFor("100001"),
      name: "张三",
      employeeId: "100001",
      email: null,
      source: "dev",
    });
    const persisted = parsePersistedAuth(
      window.localStorage.getItem(storageKey),
    );
    expect(persisted.user?.source).toBe("dev");
  });

  it("同一工号永远同一个内部 ID；不同工号互不相同", () => {
    const first = useAuthStore.getState().loginAsDev({
      name: "张三",
      employeeId: "100001",
    });
    useAuthStore.getState().logout();
    const again = useAuthStore.getState().loginAsDev({
      name: "张三",
      employeeId: "100001",
    });
    expect(again.id).toBe(first.id);

    const other = useAuthStore.getState().loginAsDev({
      name: "李四",
      employeeId: "200002",
    });
    expect(other.id).not.toBe(first.id);
    // 映射落盘：key 里有两条
    const map = JSON.parse(
      window.localStorage.getItem(devIdsKey) ?? "{}",
    ) as Record<string, string>;
    expect(Object.keys(map).sort()).toEqual(["100001", "200002"]);
  });

  it("用户名 / 工号为空：抛错且不写状态", () => {
    expect(() =>
      useAuthStore.getState().loginAsDev({ name: "  ", employeeId: "1" }),
    ).toThrow(/请填写用户名和工号/);
    expect(() =>
      useAuthStore.getState().loginAsDev({ name: "张三", employeeId: "" }),
    ).toThrow(/请填写用户名和工号/);
    expect(useAuthStore.getState().currentUser).toBeNull();
  });

  it("getDevUuidFor：同一工号多次读取稳定；坏值自动重建", () => {
    const first = getDevUuidFor("100001");
    expect(getDevUuidFor("100001")).toBe(first);
    window.localStorage.setItem(devIdsKey, JSON.stringify({ "100001": "bad" }));
    const rebuilt = getDevUuidFor("100001");
    expect(rebuilt).not.toBe("bad");
    expect(getDevUuidFor("100001")).toBe(rebuilt);
  });
});

describe("持久化与恢复", () => {
  it("退出登录：身份清空，内部 ID 映射保留", () => {
    useAuthStore.getState().loginAsDev({ name: "张三", employeeId: "100001" });
    const uuid = getDevUuidFor("100001");

    useAuthStore.getState().logout();
    expect(useAuthStore.getState().currentUser).toBeNull();
    const persisted = parsePersistedAuth(
      window.localStorage.getItem(storageKey),
    );
    expect(persisted.user).toBeNull();
    expect(getDevUuidFor("100001")).toBe(uuid);
  });

  it("坏持久化数据：整体回落未登录；旧格式多余字段被忽略", () => {
    for (const raw of [
      "not json",
      JSON.stringify({ version: 1, user: { id: 42 } }),
      JSON.stringify(null),
    ]) {
      expect(parsePersistedAuth(raw).user).toBeNull();
    }
    expect(parsePersistedAuth(null).user).toBeNull();
    // 旧持久化（含已废弃的 ssoEndpoint 字段）：user 部分照常解析
    expect(
      parsePersistedAuth(
        JSON.stringify({
          version: 1,
          ssoEndpoint: "https://old.example.com",
          user: {
            id: "i",
            name: "张三",
            employeeId: "1",
            source: "dev",
            loggedInAt: "x",
          },
        }),
      ).user,
    ).toMatchObject({ id: "i", email: null });
  });

  it("身份字段缺关键项：该用户记录被丢弃（email 等可选项允许缺失）", () => {
    expect(
      parsePersistedAuth(
        JSON.stringify({
          version: 1,
          user: { name: "张三", source: "dev", loggedInAt: "x" },
        }),
      ).user,
    ).toBeNull();
  });
});
