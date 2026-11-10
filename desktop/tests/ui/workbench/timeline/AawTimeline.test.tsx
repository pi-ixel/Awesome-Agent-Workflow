/**
 * AawTimeline 组件测试（紧凑条 + 泳道画布两态）：无活动 SR 不渲染；紧凑
 * 条给 SR · 分段进度 · 计数 · 当前站；「流程」展开泳道画布（泳道标签、
 * 列头短名、分叉徽标在位）；Esc / 点外部关闭；偏好持久化。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AawTimeline } from "../../../../src/plugins/workflow/ui/timeline/AawTimeline.tsx";
import { workflowStatus } from "../../../helpers/workflow.ts";
import { createTimelineDrawer } from "../../../../src/plugins/workflow/ui/timeline/drawer.ts";
import { webviewStorage } from "../../../../src/plugins/host/storage/storage.ts";
import { timelineCollapsedStorageKey } from "../../../../src/plugins/workflow/config.ts";

let drawer: ReturnType<typeof createTimelineDrawer>;

beforeEach(() => {
  window.localStorage.clear();
  drawer = createTimelineDrawer(webviewStorage);
  workflowStatus.setState({ currentSr: null, status: null });
});

afterEach(() => {
  cleanup();
  drawer.dispose();
});

/** 复杂场景种子：SR 段 + 两条 AR 段（多实例同名步骤）。 */
function seedComplex(): void {
  let id = 0;
  const step = (
    type: string,
    status: "completed" | "running" | null,
  ): {
    id: number;
    type: string;
    finished: boolean;
    executionStatus: "completed" | "running" | null;
  } => ({
    id: ++id,
    type,
    finished: status === "completed",
    executionStatus: status,
  });
  workflowStatus.setState({
    currentSr: "SR-COMPLEX-001",
    status: {
      sr: "SR-COMPLEX-001",
      entry: "sr",
      status: "in_progress",
      pendingUserConfirm: null,
      definitionDrift: null,
      steps: [
        {
          ...step("sr-init", "completed"),
          name: "sr-init",
          execution: "prompt",
          isGate: false,
        },
        {
          ...step("sr-design", "completed"),
          name: "sr-design",
          execution: "skill",
          isGate: false,
        },
        {
          ...step("sr-design-gate", "completed"),
          name: "sr-design-gate",
          execution: "skill",
          isGate: true,
        },
        {
          ...step("ar-split", "completed"),
          name: "ar-split",
          execution: "skill",
          isGate: false,
        },
        // AR-001 全链
        {
          ...step("ar-clarify", "completed"),
          name: "ar-clarify",
          execution: "skill",
          isGate: false,
        },
        {
          ...step("module-boundary-design", "completed"),
          name: "module-boundary-design",
          execution: "skill",
          isGate: false,
        },
        {
          ...step("module-design-gate", "completed"),
          name: "module-design-gate",
          execution: "skill",
          isGate: true,
        },
        // 任务簇：2 完成 1 在跑
        {
          ...step("task-dev", "completed"),
          name: "task-dev",
          execution: "skill",
          isGate: false,
        },
        {
          ...step("task-dev", "completed"),
          name: "task-dev",
          execution: "skill",
          isGate: false,
        },
        {
          ...step("task-dev", "running"),
          name: "task-dev",
          execution: "skill",
          isGate: false,
        },
        // AR-002：澄清完成，边界设计在跑
        {
          ...step("ar-clarify", "completed"),
          name: "ar-clarify",
          execution: "skill",
          isGate: false,
        },
        {
          ...step("module-boundary-design", "running"),
          name: "module-boundary-design",
          execution: "skill",
          isGate: false,
        },
      ],
    },
  });
}

describe("AawTimeline（紧凑条 + 泳道画布）", () => {
  it("无活动 SR 时不渲染", () => {
    const { container } = render(<AawTimeline statusSource={workflowStatus} drawer={drawer} />);
    expect(container.firstElementChild).toBeNull();
  });

  it("默认紧凑条：SR · 计数 · 当前站；泳道画布不渲染", () => {
    seedComplex();
    render(<AawTimeline statusSource={workflowStatus} drawer={drawer} />);
    expect(screen.getByText("SR-COMPLEX-001")).toBeInTheDocument();
    expect(screen.getByText("10/12")).toBeInTheDocument();
    expect(screen.getByText(/当前 ·/)).toBeInTheDocument();
    // 画布未展开：泳道标签不在
    expect(screen.queryByText("AR-001")).not.toBeInTheDocument();
  });

  it("展开泳道画布：泳道标签 + 列头短名 + 分叉徽标 + 任务簇", async () => {
    seedComplex();
    render(<AawTimeline statusSource={workflowStatus} drawer={drawer} />);
    await userEvent.click(screen.getByRole("button", { name: "展开流程全览" }));

    // 泳道标签（三条泳道）
    expect(screen.getByText("SR 主线")).toBeInTheDocument();
    expect(screen.getByText("AR-001")).toBeInTheDocument();
    expect(screen.getByText("AR-002")).toBeInTheDocument();
    // 列头中文短名（列定义来自 plan 缺失时回落步骤类型 → stationNames）
    expect(screen.getByText("拆出 2 条 AR")).toBeInTheDocument();
    // 任务簇说明
    expect(screen.getByText(/T1 ✓/)).toBeInTheDocument();
  });

  it("Esc 关闭画布；再点「流程」可重开", async () => {
    seedComplex();
    render(<AawTimeline statusSource={workflowStatus} drawer={drawer} />);
    await userEvent.click(screen.getByRole("button", { name: "展开流程全览" }));
    expect(screen.getByText("AR-001")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("AR-001")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开流程全览" }));
    expect(screen.getByText("AR-001")).toBeInTheDocument();
  });

  it("画布开着时点外部关闭", async () => {
    seedComplex();
    render(<AawTimeline statusSource={workflowStatus} drawer={drawer} />);
    await userEvent.click(screen.getByRole("button", { name: "展开流程全览" }));
    expect(screen.getByText("AR-001")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText("AR-001")).not.toBeInTheDocument();
  });

  it("展开偏好持久化：重挂载保持展开（默认收起）", () => {
    seedComplex();
    const separateDrawer = createTimelineDrawer(webviewStorage);
    drawer.toggle();
    expect(separateDrawer.state.getState()).toBe(false);
    separateDrawer.dispose();
    expect(localStorage.getItem(timelineCollapsedStorageKey)).toBe("0");
    drawer.dispose();
    drawer.close();
    expect(localStorage.getItem(timelineCollapsedStorageKey)).toBe("0");
    drawer = createTimelineDrawer(webviewStorage);
    render(<AawTimeline statusSource={workflowStatus} drawer={drawer} />);
    expect(screen.getByText("AR-001")).toBeInTheDocument();
  });
});
