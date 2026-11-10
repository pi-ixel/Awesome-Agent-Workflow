/**
 * LoginScreen 测试：未内置 SSO 时直接呈现最小登录窗口（用户名 + 工号，
 * 无任何内部细节暴露）、手动登录通路、内置 SSO（自验通道）时进入即自动
 * 尝试且失败原文展示，以及 AuthGate 门槛接线（App 冒烟）。
 *
 * authConfig 统一 mock 为空（未对接构建）：SSO 是否内置经自验通道布置。
 */
import { act, screen, within } from "@testing-library/react";
import type { Context } from "cordis";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 构建期内置配置置空：让「未内置」与自验通道分支在本测试文件可控
vi.mock("../../../src/plugins/account/sso/authConfig.ts", () => ({
  SSO_ENDPOINT: "",
  SSO_LOGIN_URL: "",
}));

import { installDesktopWorkbench } from "../../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { renderDesktopApp } from "../../helpers/renderDesktopApp.tsx";
import type { SsoLoginPollWire } from "../../../src/plugins/host/types.ts";
import { createDemoHost } from "../../../src/plugins/host/adapters/host.ts";
import { getDevUuidFor } from "../../../src/plugins/account/identity/account.ts";
import * as accountPlugin from "../../../src/plugins/account/index.ts";

const storageKey = "aaw-desktop.auth.v1";
const devIdsKey = "aaw-desktop.auth.dev-ids.v1";
const ssoDevEndpointKey = "aaw-desktop.auth.sso-dev-endpoint.v1";
const ssoDevLoginUrlKey = "aaw-desktop.auth.sso-dev-login-url.v1";

/** 布置自验通道：网关端点 + 登录页（模拟「内置 SSO」的构建）。 */
function enableDevSso(): void {
  window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
  window.localStorage.setItem(
    ssoDevLoginUrlKey,
    "https://login.internal/login1",
  );
}

let demoHost: ReturnType<typeof createDemoHost>;
let services: Awaited<ReturnType<typeof createTestDesktopRuntime>["ready"]>;
let root: Context;

beforeEach(async ({ onTestFinished }) => {
  window.localStorage.clear();
  demoHost = createDemoHost();
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    async (context) => {
      root = context;
      await installDesktopWorkbench(context);
    },
    demoHost,
  );
  onTestFinished(() => runtime.shutdown());
  services = await runtime.ready;
});

it("卸载账户后撤销工作台登录状态，重装只恢复已保存的身份", async () => {
  const oldAccount = services.account;
  const user = oldAccount.loginAsDev({
    name: "重装测试用户",
    employeeId: "100001",
  });
  renderDesktopApp(services.workbench);
  expect(screen.getByText(user.name)).toBeVisible();
  const oldListener = vi.fn();
  oldAccount.state.subscribe(oldListener);

  const [fiber] = root.registry.get(accountPlugin)?.fibers ?? [];
  if (!fiber) throw new Error("Account fiber is missing");
  await act(() => fiber.dispose());
  expect(screen.queryByText(user.name)).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "登录 AAW" })).not.toBeInTheDocument();
  expect(oldAccount.state.getState().currentUser).toBeNull();
  expect(oldListener).not.toHaveBeenCalled();

  await act(async () => {
    await root.plugin(accountPlugin);
  });
  expect(root.account).not.toBe(oldAccount);
  expect(screen.getByText(user.name)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "打开设置菜单" }));
  await userEvent.click(
    within(screen.getByRole("menu", { name: "设置菜单" })).getByRole(
      "menuitem", { name: "退出登录" },
    ),
  );
  expect(await screen.findByRole("heading", { name: "登录 AAW" })).toBeVisible();
  expect(root.account.state.getState().currentUser).toBeNull();
  expect(oldListener).not.toHaveBeenCalled();
});

describe("未内置 SSO（本构建未对接）", () => {
  it("直接呈现最小登录窗口：只有用户名 / 工号，不暴露任何内部细节", () => {
    renderDesktopApp(services.workbench);
    expect(screen.getByRole("heading", { name: "登录 AAW" })).toBeVisible();
    expect(screen.getByRole("form", { name: "身份登录" })).toBeVisible();
    // 不出现 SSO 入口、端点输入、内部唯一 ID 等细节
    expect(screen.queryByRole("button", { name: "企业身份登录" })).toBeNull();
    expect(screen.queryByText(/SSO/)).toBeNull();
    expect(screen.queryByText(/唯一 ID/)).toBeNull();
    // 工作台不可见：门槛挡住整棵树
    expect(screen.queryByLabelText("项目树")).not.toBeInTheDocument();
  });

  it("手动登录：用户名 + 工号即可进入工作台，内部 ID 按工号分配", async () => {
    renderDesktopApp(services.workbench);
    await userEvent.type(screen.getByPlaceholderText("如：张三"), "张三");
    await userEvent.type(screen.getByPlaceholderText("如：100001"), "100001");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    const user = services.account.state.getState().currentUser;
    expect(user).toMatchObject({
      name: "张三",
      employeeId: "100001",
      source: "dev",
    });
    expect(user?.id).toBe(getDevUuidFor("100001", root.host.storage));
    // 工作台门槛解除：footer 身份区显示登录用户名
    expect(screen.getByText("张三")).toBeVisible();
    expect(window.localStorage.getItem(storageKey)).toContain(user?.id ?? "");
  });

  it("手动登录：必填缺失给出行内错误", async () => {
    renderDesktopApp(services.workbench);
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/请填写用户名和工号/);
    expect(services.account.state.getState().currentUser).toBeNull();
  });
});

describe("内置 SSO（经自验通道模拟内置端点与登录页）", () => {
  it("进入登录界面即自动尝试认证，失败原文展示且身份不落地", async () => {
    enableDevSso();
    demoHost.scriptSsoLoginPoll([
      {
        windowClosed: false,
        fetched: { status: 500, body: '{"message":"boom"}' },
      },
    ]);
    renderDesktopApp(services.workbench);
    // 无需点击：进入即已发起尝试
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HTTP 500");
    expect(alert).toHaveTextContent("boom");
    expect(services.account.state.getState().currentUser).toBeNull();
    expect(screen.getByRole("heading", { name: "登录 AAW" })).toBeVisible();
  });

  it("认证等待中不出现手动入口，失败后才出现（防绕过统一身份认证）", async () => {
    enableDevSso();
    let resolvePoll!: (wire: SsoLoginPollWire) => void;
    const deferred = new Promise<SsoLoginPollWire>((resolve) => {
      resolvePoll = resolve;
    });
    const spy = vi
      .spyOn(demoHost, "ssoPollLogin")
      .mockReturnValueOnce(deferred);
    renderDesktopApp(services.workbench);
    // 等待中：主路径 pending，手动兜底入口不可见
    expect(
      await screen.findByText(
        "正在检测已有登录态，需要登录时会弹出企业认证窗口",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "手动输入身份登录" }),
    ).toBeNull();
    resolvePoll({
      windowClosed: false,
      fetched: { status: 500, body: '{"message":"boom"}' },
    });
    // 失败后：错误展示 + 手动兜底入口才出现
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 500");
    expect(
      screen.getByRole("button", { name: "手动输入身份登录" }),
    ).toBeVisible();
    spy.mockRestore();
  });

  it("等待满 45s 手动入口先亮出（认证仍在进行，不打断）", async () => {
    enableDevSso();
    let resolvePoll!: (wire: SsoLoginPollWire) => void;
    const deferred = new Promise<SsoLoginPollWire>((resolve) => {
      resolvePoll = resolve;
    });
    const spy = vi
      .spyOn(demoHost, "ssoPollLogin")
      .mockReturnValueOnce(deferred);
    vi.useFakeTimers();
    try {
      renderDesktopApp(services.workbench);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // 45s 内：入口不可见
      expect(
        screen.queryByRole("button", { name: "手动输入身份登录" }),
      ).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
      // 满 45s：入口亮出，且认证仍在等待（未被取消、登录窗不打断）
      expect(
        screen.getByRole("button", { name: "手动输入身份登录" }),
      ).toBeVisible();
      expect(services.account.state.getState().ssoPending).toBe(true);
      // 后续认证结束（用户关窗=放弃）：状态收口正常
      resolvePoll({ windowClosed: true, fetched: null });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(services.account.state.getState().ssoPending).toBe(false);
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it("失败后可经手动输入身份登录，表单不暴露内部细节", async () => {
    enableDevSso();
    demoHost.scriptSsoLoginPoll([new Error("network down")]);
    renderDesktopApp(services.workbench);
    expect(await screen.findByRole("alert")).toHaveTextContent("network down");

    await userEvent.click(
      screen.getByRole("button", { name: "手动输入身份登录" }),
    );
    const form = screen.getByRole("form", { name: "身份登录" });
    expect(form).toBeVisible();
    expect(screen.queryByText(/唯一 ID/)).toBeNull();
    await userEvent.type(screen.getByPlaceholderText("如：张三"), "张三");
    await userEvent.type(screen.getByPlaceholderText("如：100001"), "100001");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    const user = services.account.state.getState().currentUser;
    expect(user).toMatchObject({ name: "张三", source: "dev" });
    expect(screen.getByText("张三")).toBeVisible();
    // 手动登录的内部 ID 映射落盘
    const map = JSON.parse(
      window.localStorage.getItem(devIdsKey) ?? "{}",
    ) as Record<string, string>;
    expect(map["100001"]).toBe(user?.id);
  });
});
