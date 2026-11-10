/**
 * 站名友好化：技术 ID → 中文短名。词表对着 flow.yaml 的真实节点全集，
 * 未知段原样回落（新工作流加站不显示错词）。
 */
import { describe, expect, it } from "vitest";

import { stationDisplayName } from "../../../../src/plugins/workflow/ui/timeline/stationNames.ts";

describe("stationDisplayName", () => {
  it("sr 入口站：启动 / 详设 / 详设门禁", () => {
    expect(stationDisplayName("sr-init")).toBe("启动");
    expect(stationDisplayName("sr-design")).toBe("详设");
    expect(stationDisplayName("sr-design-gate")).toBe("详设门禁");
  });

  it("ar 与拆分：澄清 / 拆分 / 任务拆分", () => {
    expect(stationDisplayName("ar-init")).toBe("启动");
    expect(stationDisplayName("ar-clarify")).toBe("澄清");
    expect(stationDisplayName("ar-split")).toBe("拆分");
    expect(stationDisplayName("sr-task-split")).toBe("任务拆分");
  });

  it("dev 入口与模板实例站：T{序号}-dev-task-dev → 任务开发", () => {
    expect(stationDisplayName("dev-init")).toBe("启动");
    expect(stationDisplayName("dev-test-design")).toBe("测试详设");
    expect(stationDisplayName("dev-design-gate")).toBe("详设门禁");
    expect(stationDisplayName("T{序号}-dev-task-dev")).toBe("任务开发");
    expect(stationDisplayName("T{N}-task-dev")).toBe("任务开发");
  });

  it("模块设计域（module-* 整体名）", () => {
    expect(stationDisplayName("module-boundary-design")).toBe("边界设计");
    expect(stationDisplayName("module-asis-analysis")).toBe("现状分析");
    expect(stationDisplayName("module-tobe-design")).toBe("目标设计");
    expect(stationDisplayName("module-design-gate")).toBe("设计门禁");
    expect(stationDisplayName("module-detail-design-split")).toBe("详设拆分");
  });

  it("未知段原样回落（不猜词）", () => {
    expect(stationDisplayName("sr-unknown-stage")).toBe("unknown-stage");
    expect(stationDisplayName("T{N}-future-op")).toBe("future-op");
  });
});
