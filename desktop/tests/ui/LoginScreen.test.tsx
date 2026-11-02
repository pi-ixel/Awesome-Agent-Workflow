/**
 * LoginScreen 测试：未登录门槛的呈现、SSO 失败文案展示、开发者降级
 * 表单（必填校验 + 固定 UUID 唯一 ID）与 AuthGate 门槛接线（App 冒烟）。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import App from "../../src/App";
import { demoHost } from "../../src/core/host";
import { useAuthStore } from "../../src/stores/authStore.ts";

const storageKey = "aaw-desktop.auth.v1";

beforeEach(() => {
  window.localStorage.clear();
  demoHost.reset();
  useAuthStore.setState({
    currentUser: null,
    ssoEndpoint: "",
    ssoPending: false,
    ssoError: null,
  });
});

describe("LoginScreen", () => {
  it("未登录呈现 SSO 主路径与降级入口", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "登录 AAW" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "使用企业 SSO 登录" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "开发者身份登录（降级自验）" }),
    ).toBeVisible();
    // 工作台不可见：门槛挡住整棵树
    expect(screen.queryByLabelText("项目树")).not.toBeInTheDocument();
  });

  it("SSO 失败：接口返回原文进错误框，身份不落地", async () => {
    useAuthStore.getState().setSsoEndpoint("https://sso.internal/auth");
    demoHost.scriptSsoFetch({ status: 500, body: '{"message":"boom"}' });
    render(<App />);
    await userEvent.click(
      screen.getByRole("button", { name: "使用企业 SSO 登录" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HTTP 500");
    expect(alert).toHaveTextContent("boom");
    expect(useAuthStore.getState().currentUser).toBeNull();
    // 登录界面仍在（门槛未解除）
    expect(screen.getByRole("heading", { name: "登录 AAW" })).toBeVisible();
  });

  it("开发者降级：填姓名 + 工号登录成功，唯一 ID 用本机固定 UUID", async () => {
    render(<App />);
    await userEvent.click(
      screen.getByRole("button", { name: "开发者身份登录（降级自验）" }),
    );
    await userEvent.type(screen.getByPlaceholderText("张三"), "张三");
    await userEvent.type(screen.getByPlaceholderText("100001"), "100001");
    await userEvent.click(screen.getByRole("button", { name: "以此身份登录" }));

    const user = useAuthStore.getState().currentUser;
    expect(user).not.toBeNull();
    expect(user).toMatchObject({
      name: "张三",
      employeeId: "100001",
      source: "dev",
    });
    // 工作台门槛解除：footer 身份区显示登录姓名
    expect(screen.getByText("张三")).toBeVisible();
    // 唯一 ID 落了固定 UUID（持久化 key 里可取到同一值）
    expect(user?.id).not.toBe("");
    expect(window.localStorage.getItem(storageKey)).toContain(user?.id ?? "");
  });

  it("开发者降级：必填缺失给出行内错误", async () => {
    render(<App />);
    await userEvent.click(
      screen.getByRole("button", { name: "开发者身份登录（降级自验）" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "以此身份登录" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/必填/);
    expect(useAuthStore.getState().currentUser).toBeNull();
  });

  it("降级表单展示唯一 ID（固定 UUID）且可返回 SSO 主路径", async () => {
    render(<App />);
    await userEvent.click(
      screen.getByRole("button", { name: "开发者身份登录（降级自验）" }),
    );
    const form = screen.getByRole("form", { name: "开发者降级登录" });
    // 只读 ID 块以 code 呈现
    const code = within(form).getByText(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(code).toBeVisible();
    await userEvent.click(within(form).getByRole("button", { name: "返回" }));
    expect(
      screen.getByRole("button", { name: "使用企业 SSO 登录" }),
    ).toBeVisible();
  });
});
