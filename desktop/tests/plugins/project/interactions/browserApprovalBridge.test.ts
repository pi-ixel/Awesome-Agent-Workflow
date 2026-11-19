/**
 * 036 浏览器审批桥：把原生浏览器受限动作审批翻译为项目统一权限请求。
 *
 * 断言只读取公开纯函数返回值、审批 store 的待办与原生宿主决策调用参数，
 * 不读取桥内部状态。
 */
import { describe, expect, it, vi } from "vitest";

import {
  attachBrowserApprovals,
  browserApprovalPermission,
} from "../../../../src/plugins/project/interactions/browserApprovalBridge.ts";
import { createApprovalStore } from "../../../../src/plugins/project/interactions/approvalStore.ts";
import { createTestBrowserHost } from "../../../helpers/browserHost.ts";
import type { BrowserApproval } from "../../../../src/plugins/host/browser/types.ts";

const SESSION = "session-a";

function approval(overrides: Partial<BrowserApproval> = {}): BrowserApproval {
  return {
    approvalId: "approval-1",
    sessionId: SESSION,
    tabId: "tab-1",
    action: "script:abc",
    status: "pending",
    generation: 1,
    ...overrides,
  };
}

function bridge(
  browser: ReturnType<typeof createTestBrowserHost>,
  mode: "ask" | "auto-allow",
  store = createApprovalStore(),
) {
  const release = attachBrowserApprovals({
    browser,
    sessionId: SESSION,
    approvalStore: store.getState(),
    getApprovalMode: () => mode,
  });
  return { release, store };
}

describe("TD-036-U01 浏览器审批映射", () => {
  it("脚本、上传、提交与控制分别给出可识别的标题和统一选项", () => {
    const cases = [
      ["script:abc", "允许 Agent 在浏览器中执行脚本？"],
      ["upload:C:/tmp/a.txt", "允许 Agent 上传指定文件？"],
      ["submit", "允许 Agent 提交浏览器表单？"],
      ["control", "允许 Agent 控制此浏览器页面？"],
      ["unknown-action", "允许 Agent 执行受限浏览器操作？"],
    ] as const;
    for (const [action, title] of cases) {
      const permission = browserApprovalPermission(approval({ action }));
      expect(permission.toolCall).toMatchObject({
        toolCallId: "browser:approval-1",
        title,
        rawInput: { action, tabId: "tab-1" },
      });
      expect(permission.options).toEqual([
        { optionId: "allow", name: "允许一次", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ]);
    }
  });
});

describe("TD-036-U02 自动放行", () => {
  it("会话就绪时已有待审批：不进入审批 store，直接批准原生记录", async () => {
    const browser = createTestBrowserHost();
    browser.emitApproval(approval());
    const { store } = bridge(browser, "auto-allow");

    await vi.waitFor(() =>
      expect(browser.approvalDecisions).toEqual([
        { approvalId: "approval-1", approved: true },
      ]),
    );
    expect(store.getState().pending).toHaveLength(0);
  });

  it("运行中到达的审批同样直接批准", async () => {
    const browser = createTestBrowserHost();
    const { store } = bridge(browser, "auto-allow");
    await Promise.resolve();
    browser.emitApproval(approval({ approvalId: "approval-2" }));

    await vi.waitFor(() =>
      expect(browser.approvalDecisions).toEqual([
        { approvalId: "approval-2", approved: true },
      ]),
    );
    expect(store.getState().pending).toHaveLength(0);
  });
});

describe("TD-036-U03/U04 人工模式", () => {
  it("审批进入统一待办；选择允许后批准原生记录", async () => {
    const browser = createTestBrowserHost();
    const { store } = bridge(browser, "ask");
    browser.emitApproval(approval());

    await vi.waitFor(() => expect(store.getState().pending).toHaveLength(1));
    const item = store.getState().pending[0];
    expect(item).toMatchObject({
      kind: "permission",
      id: "permission:browser:approval-1",
      title: "允许 Agent 在浏览器中执行脚本？",
      toolCallId: "browser:approval-1",
    });
    store.getState().decidePermission(item!.id, "allow");

    await vi.waitFor(() =>
      expect(browser.approvalDecisions).toEqual([
        { approvalId: "approval-1", approved: true },
      ]),
    );
    expect(store.getState().pending).toHaveLength(0);
  });

  it("选择拒绝后拒绝原生记录", async () => {
    const browser = createTestBrowserHost();
    const { store } = bridge(browser, "ask");
    browser.emitApproval(approval());

    await vi.waitFor(() => expect(store.getState().pending).toHaveLength(1));
    const item = store.getState().pending[0];
    store.getState().decidePermission(item!.id, "reject");

    await vi.waitFor(() =>
      expect(browser.approvalDecisions).toEqual([
        { approvalId: "approval-1", approved: false },
      ]),
    );
    expect(store.getState().pending).toHaveLength(0);
  });
});

describe("TD-036-U05 去重", () => {
  it("同一审批同时出现在快照与事件：只挂起一次，只决策一次", async () => {
    const browser = createTestBrowserHost();
    browser.emitApproval(approval());
    const { store } = bridge(browser, "ask");
    browser.emitApproval(approval());

    await vi.waitFor(() => expect(store.getState().pending).toHaveLength(1));
    store.getState().decidePermission(store.getState().pending[0]!.id, "allow");

    await vi.waitFor(() => expect(browser.approvalDecisions).toHaveLength(1));
  });
});

describe("TD-036-U06 会话与状态过滤", () => {
  it("其它会话的审批不挂起，本会话审批正常挂起", async () => {
    const browser = createTestBrowserHost();
    const { store } = bridge(browser, "ask");
    browser.emitApproval(
      approval({ approvalId: "approval-other", sessionId: "session-b" }),
    );

    await Promise.resolve();
    expect(store.getState().pending).toHaveLength(0);

    browser.emitApproval(approval({ approvalId: "approval-mine" }));
    await vi.waitFor(() => expect(store.getState().pending).toHaveLength(1));
    expect(store.getState().pending[0]).toMatchObject({
      toolCallId: "browser:approval-mine",
    });
    expect(browser.approvalDecisions).toHaveLength(0);
  });

  it("非 pending 状态的事件不处理，后续 pending 事件正常挂起", async () => {
    const browser = createTestBrowserHost();
    const { store } = bridge(browser, "ask");
    browser.emitApproval(
      approval({ approvalId: "approval-done", status: "approved" }),
    );

    await Promise.resolve();
    expect(store.getState().pending).toHaveLength(0);

    browser.emitApproval(approval({ approvalId: "approval-live" }));
    await vi.waitFor(() => expect(store.getState().pending).toHaveLength(1));
    expect(browser.approvalDecisions).toHaveLength(0);
  });
});

describe("TD-036-U07 释放", () => {
  it("释放前正常挂起，释放后事件不再挂起或决策", async () => {
    const browser = createTestBrowserHost();
    const { release, store } = bridge(browser, "ask");
    browser.emitApproval(approval({ approvalId: "approval-before" }));
    await vi.waitFor(() => expect(store.getState().pending).toHaveLength(1));

    release();
    browser.emitApproval(approval({ approvalId: "approval-after" }));

    await Promise.resolve();
    expect(store.getState().pending).toHaveLength(1);
    expect(browser.approvalDecisions).toHaveLength(0);
  });
});

describe("TD-036-U09 会话挂起", () => {
  it("审批待办被清空时按拒绝回传", async () => {
    const browser = createTestBrowserHost();
    const { store } = bridge(browser, "ask");
    browser.emitApproval(approval());

    await vi.waitFor(() => expect(store.getState().pending).toHaveLength(1));
    store.getState().clear();

    await vi.waitFor(() =>
      expect(browser.approvalDecisions).toEqual([
        { approvalId: "approval-1", approved: false },
      ]),
    );
  });
});
