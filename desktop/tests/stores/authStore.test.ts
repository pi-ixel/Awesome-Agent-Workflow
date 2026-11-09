/**
 * stores/authStore 测试：SSO 登录轮询编排（成功 / 失败 / 非法契约 /
 * 唤起登录窗 / 用户关窗静默取消 / 401 三振 / 取消代次）、手动身份登录
 * （用户名 + 工号，内部按工号固定 UUID）、持久化与坏数据回落、退出语义。
 *
 * authConfig 统一 mock 为空（未对接构建）：SSO 端点与登录页都走自验通道
 * （localStorage key）布置，保持「未配置」分支可测。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 构建期内置配置置空：让「未配置」与自验通道分支在本测试文件可控
vi.mock("../../src/plugins/account/authConfig", () => ({
  SSO_ENDPOINT: "",
  SSO_LOGIN_URL: "",
}));

import type { SsoLoginPollWire } from "../../src/contracts/sso.ts";
import { createDemoHost } from "../../src/plugins/host/host";
import {
  getDevUuidFor,
  isSsoConfigured,
  parsePersistedAuth,
  resolveSsoEndpoint,
  resolveSsoLoginUrl,
  createAccount,
} from "../../src/plugins/account/service.ts";

import { webviewStorage } from "../../src/plugins/host/storage.ts";

const demoHost = createDemoHost();
let account: ReturnType<typeof createAccount>;
const storageKey = "aaw-desktop.auth.v1";
const devIdsKey = "aaw-desktop.auth.dev-ids.v1";
const ssoDevEndpointKey = "aaw-desktop.auth.sso-dev-endpoint.v1";
const ssoDevLoginUrlKey = "aaw-desktop.auth.sso-dev-login-url.v1";

/** 布置自验通道：网关端点 + 登录页（两者都生效才可发起登录）。 */
function enableDevSso(): void {
  window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
  window.localStorage.setItem(
    ssoDevLoginUrlKey,
    "https://login.internal/login1",
  );
}

/** 一次「已带 cookie 调过网关」的轮询结果。 */
function fetchedWire(status: number, body: string): SsoLoginPollWire {
  return { windowClosed: false, fetched: { status, body } };
}

/** 重置登录态到未登录（不动 localStorage——需要现场隔离的用例自己清）。 */
function resetAuthState(): void {
  account.state.setState({
    currentUser: null,
    ssoPending: false,
    ssoError: null,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  demoHost.reset();
  account = createAccount(demoHost, webviewStorage);
  resetAuthState();
});

afterEach(() => account.dispose());

describe("SSO 端点解析", () => {
  it("内置端点为空且无自验通道：未配置；写入自验通道后生效", () => {
    expect(resolveSsoEndpoint(webviewStorage)).toBe("");
    expect(isSsoConfigured(webviewStorage)).toBe(false);
    window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
    expect(resolveSsoEndpoint(webviewStorage)).toBe("https://sso.internal/auth");
    expect(isSsoConfigured(webviewStorage)).toBe(true);
  });

  it("登录页地址解析：与端点平行的自验通道独立生效", () => {
    expect(resolveSsoLoginUrl(webviewStorage)).toBe("");
    window.localStorage.setItem(
      ssoDevLoginUrlKey,
      "https://login.internal/login1",
    );
    expect(resolveSsoLoginUrl(webviewStorage)).toBe("https://login.internal/login1");
  });
});

describe("SSO 登录", () => {
  it("端点未配置：直接报错，不发起请求", async () => {
    const ok = await account.state.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(account.state.getState().ssoError).toContain("未配置");
    expect(account.state.getState().ssoPending).toBe(false);
  });

  it("端点已配置但登录页未配置：报错且不开窗", async () => {
    window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
    const openSpy = vi.spyOn(demoHost, "ssoOpenLogin");
    const ok = await account.state.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(account.state.getState().ssoError).toContain("登录页");
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("2xx + 合法契约：写入当前用户（source=sso）并持久化；首询即成功不唤起登录窗", async () => {
    enableDevSso();
    demoHost.scriptSsoLoginPoll([
      fetchedWire(
        200,
        JSON.stringify({
          userId: "sso-1",
          name: "张三",
          employeeId: "100001",
          email: "z@example.com",
          department: "平台部",
        }),
      ),
    ]);
    const openSpy = vi.spyOn(demoHost, "ssoOpenLogin");
    const ok = await account.state.getState().loginWithSso();
    expect(ok).toBe(true);
    const user = account.state.getState().currentUser;
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
    expect(account.state.getState().ssoError).toBeNull();
    // 隐藏窗开了 1 次（静默探测）；首询即拿到 200，无需唤起第二次
    expect(openSpy).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
  });

  it("cookie 未落地 → 唤起登录窗 → 落地后成功（轮询间隔由假时钟推进）", async () => {
    vi.useFakeTimers();
    try {
      enableDevSso();
      demoHost.scriptSsoLoginPoll([
        { windowClosed: false, fetched: null },
        fetchedWire(
          200,
          JSON.stringify({ uid: "a00012345", givenName: "张三" }),
        ),
      ]);
      const openSpy = vi.spyOn(demoHost, "ssoOpenLogin");
      const pending = account.state.getState().loginWithSso();
      await vi.advanceTimersByTimeAsync(2_000); // 越过一个轮询间隔
      expect(await pending).toBe(true);
      expect(account.state.getState().currentUser).toMatchObject({
        id: "a00012345",
        name: "张三",
      });
      // 第 1 次开隐藏窗 + 第 2 次唤起显示
      expect(openSpy).toHaveBeenCalledTimes(2);
      openSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("用户关闭登录窗：静默取消（无 ssoError），身份不落地", async () => {
    enableDevSso();
    demoHost.scriptSsoLoginPoll([{ windowClosed: true, fetched: null }]);
    const ok = await account.state.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(account.state.getState().ssoPending).toBe(false);
    expect(account.state.getState().ssoError).toBeNull();
    expect(account.state.getState().currentUser).toBeNull();
  });

  it("cookie 存在但网关 401：三振后按失败展示（容忍竞态窗口）", async () => {
    vi.useFakeTimers();
    try {
      enableDevSso();
      demoHost.scriptSsoLoginPoll([
        fetchedWire(401, ""),
        fetchedWire(401, ""),
        fetchedWire(401, ""),
      ]);
      const pending = account.state.getState().loginWithSso();
      await vi.advanceTimersByTimeAsync(5_000); // 两个轮询间隔（三振前两次各睡 1.5s）
      expect(await pending).toBe(false);
      expect(account.state.getState().ssoError).toContain("HTTP 401");
      expect(account.state.getState().currentUser).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("非 401 的非 2xx：立即按失败展示，不轮询重试", async () => {
    enableDevSso();
    demoHost.scriptSsoLoginPoll([fetchedWire(500, '{"message":"boom"}')]);
    const ok = await account.state.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(account.state.getState().ssoError).toContain("HTTP 500");
    expect(account.state.getState().ssoError).toContain("boom");
    expect(account.state.getState().currentUser).toBeNull();
  });

  it("2xx 但契约不合法：解析错误折进 ssoError，不落半截身份", async () => {
    enableDevSso();
    demoHost.scriptSsoLoginPoll([
      fetchedWire(200, JSON.stringify({ code: 0, message: "ok" })),
    ]);
    const ok = await account.state.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(account.state.getState().ssoError).toContain("无法从 SSO 响应中解析");
    expect(account.state.getState().currentUser).toBeNull();
  });

  it("传输失败（宿主报错）：原因进 ssoError", async () => {
    enableDevSso();
    demoHost.scriptSsoLoginPoll([new Error("network down")]);
    const ok = await account.state.getState().loginWithSso();
    expect(ok).toBe(false);
    expect(account.state.getState().ssoError).toContain("network down");
  });

  it("取消后晚到的成功响应按代次丢弃，且取消会关登录窗", async () => {
    enableDevSso();
    let resolvePoll!: (wire: SsoLoginPollWire) => void;
    const deferred = new Promise<SsoLoginPollWire>((resolve) => {
      resolvePoll = resolve;
    });
    const pollSpy = vi
      .spyOn(demoHost, "ssoPollLogin")
      .mockReturnValueOnce(deferred);
    const closeSpy = vi
      .spyOn(demoHost, "ssoCloseLogin")
      .mockResolvedValue(undefined);

    const pending = account.state.getState().loginWithSso();
    expect(account.state.getState().ssoPending).toBe(true);
    account.state.getState().cancelSsoLogin();
    expect(account.state.getState().ssoPending).toBe(false);

    resolvePoll(fetchedWire(200, JSON.stringify({ userId: "late-1" })));
    expect(await pending).toBe(false);
    expect(account.state.getState().currentUser).toBeNull();
    // 取消即关窗（晚到结果丢弃路径还会再补一次关窗，幂等无害）
    expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    pollSpy.mockRestore();
    closeSpy.mockRestore();
  });
});

describe("手动身份登录", () => {
  it("用户名 + 工号即可登录：唯一 ID 为内部按工号分配的固定 UUID", () => {
    const user = account.state.getState().loginAsDev({
      name: "张三",
      employeeId: "100001",
    });
    expect(user).toMatchObject({
      id: getDevUuidFor("100001", webviewStorage),
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
    const first = account.state.getState().loginAsDev({
      name: "张三",
      employeeId: "100001",
    });
    account.state.getState().logout();
    const again = account.state.getState().loginAsDev({
      name: "张三",
      employeeId: "100001",
    });
    expect(again.id).toBe(first.id);

    const other = account.state.getState().loginAsDev({
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
      account.state.getState().loginAsDev({ name: "  ", employeeId: "1" }),
    ).toThrow(/请填写用户名和工号/);
    expect(() =>
      account.state.getState().loginAsDev({ name: "张三", employeeId: "" }),
    ).toThrow(/请填写用户名和工号/);
    expect(account.state.getState().currentUser).toBeNull();
  });

  it("getDevUuidFor：同一工号多次读取稳定；坏值自动重建", () => {
    const first = getDevUuidFor("100001", webviewStorage);
    expect(getDevUuidFor("100001", webviewStorage)).toBe(first);
    window.localStorage.setItem(devIdsKey, JSON.stringify({ "100001": "bad" }));
    const rebuilt = getDevUuidFor("100001", webviewStorage);
    expect(rebuilt).not.toBe("bad");
    expect(getDevUuidFor("100001", webviewStorage)).toBe(rebuilt);
  });
});

describe("持久化与恢复", () => {
  it("退出登录：身份清空，内部 ID 映射保留", () => {
    account.state.getState().loginAsDev({ name: "张三", employeeId: "100001" });
    const uuid = getDevUuidFor("100001", webviewStorage);

    account.state.getState().logout();
    expect(account.state.getState().currentUser).toBeNull();
    const persisted = parsePersistedAuth(
      window.localStorage.getItem(storageKey),
    );
    expect(persisted.user).toBeNull();
    expect(getDevUuidFor("100001", webviewStorage)).toBe(uuid);
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
