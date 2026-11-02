/**
 * LoginScreen 测试：未内置 SSO 时直接呈现最小登录窗口（用户名 + 工号，
 * 无任何内部细节暴露）、手动登录通路、内置 SSO（自验通道）时进入即自动
 * 尝试且失败原文展示，以及 AuthGate 门槛接线（App 冒烟）。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import App from "../../src/App";
import { demoHost } from "../../src/core/host";
import {
  getDevUuidFor,
  resetSsoAutoAttemptForTests,
  useAuthStore,
} from "../../src/stores/authStore.ts";

const storageKey = "aaw-desktop.auth.v1";
const devIdsKey = "aaw-desktop.auth.dev-ids.v1";
const ssoDevEndpointKey = "aaw-desktop.auth.sso-dev-endpoint.v1";

beforeEach(() => {
  window.localStorage.clear();
  demoHost.reset();
  resetSsoAutoAttemptForTests();
  useAuthStore.setState({
    currentUser: null,
    ssoPending: false,
    ssoError: null,
  });
});

describe("未内置 SSO（本构建未对接）", () => {
  it("直接呈现最小登录窗口：只有用户名 / 工号，不暴露任何内部细节", () => {
    render(<App />);
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
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText("如：张三"), "张三");
    await userEvent.type(screen.getByPlaceholderText("如：100001"), "100001");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    const user = useAuthStore.getState().currentUser;
    expect(user).toMatchObject({
      name: "张三",
      employeeId: "100001",
      source: "dev",
    });
    expect(user?.id).toBe(getDevUuidFor("100001"));
    // 工作台门槛解除：footer 身份区显示登录用户名
    expect(screen.getByText("张三")).toBeVisible();
    expect(window.localStorage.getItem(storageKey)).toContain(user?.id ?? "");
  });

  it("手动登录：必填缺失给出行内错误", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/请填写用户名和工号/);
    expect(useAuthStore.getState().currentUser).toBeNull();
  });
});

describe("内置 SSO（经自验通道模拟内置端点）", () => {
  it("进入登录界面即自动尝试认证，失败原文展示且身份不落地", async () => {
    window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
    demoHost.scriptSsoFetch({ status: 500, body: '{"message":"boom"}' });
    render(<App />);
    // 无需点击：进入即已发起尝试
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HTTP 500");
    expect(alert).toHaveTextContent("boom");
    expect(useAuthStore.getState().currentUser).toBeNull();
    expect(screen.getByRole("heading", { name: "登录 AAW" })).toBeVisible();
  });

  it("失败后可经手动输入身份登录，表单不暴露内部细节", async () => {
    window.localStorage.setItem(ssoDevEndpointKey, "https://sso.internal/auth");
    demoHost.scriptSsoFetch(new Error("network down"));
    render(<App />);
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

    const user = useAuthStore.getState().currentUser;
    expect(user).toMatchObject({ name: "张三", source: "dev" });
    expect(screen.getByText("张三")).toBeVisible();
    // 手动登录的内部 ID 映射落盘
    const map = JSON.parse(
      window.localStorage.getItem(devIdsKey) ?? "{}",
    ) as Record<string, string>;
    expect(map["100001"]).toBe(user?.id);
  });
});
