/**
 * 性能页签（评审定稿版）：内存折线图 + 对话存储两块；不承载体检 /
 * 压测 / 开发工具。采样器的环形缓冲在此一并覆盖。
 *
 * 存储口径说明：对话历史存在 localStorage（浏览器无精确配额查询），
 * 读数 = 实测键体积 / 上限约 5 MB；navigator.storage.estimate 量不到
 * localStorage（只统计 IndexedDB/Cache），不能用。
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PerfHud } from "../../src/plugins/diagnostics/ui/PerfHud.tsx";
import { MAX_MEMORY_SAMPLES, createMemorySampler } from "../../src/plugins/diagnostics/sampling/memorySampler.ts";

let memory: ReturnType<typeof createMemorySampler>;
beforeEach(() => {
  memory = createMemorySampler();
  window.localStorage.clear();
});

afterEach(() => memory.dispose());

describe("内存采样器", () => {
  it("环形缓冲：超容量丢最旧，始终保留最近 MAX_MEMORY_SAMPLES 点", () => {
    for (let i = 0; i < MAX_MEMORY_SAMPLES + 60; i += 1) {
      memory.record(1_000_000 + i * 1000, i);
    }
    const samples = memory.samples.getState();
    expect(samples).toHaveLength(MAX_MEMORY_SAMPLES);
    expect(samples[0]?.bytes).toBe(60);
    expect(samples.at(-1)?.bytes).toBe(MAX_MEMORY_SAMPLES + 59);
  });
});

describe("PerfHud（内存 + 存储）", () => {
  it("两块读数就位；存储为实测占用；无体检 / 压测 / 开发工具", () => {
    window.localStorage.setItem(
      "aaw-desktop/session-log/D_%5Cdev%5Cdemo",
      "x".repeat(1024 * 512), // 512KB 字符 → 1MB（UTF-16）
    );
    window.localStorage.setItem("无关键", "不参与统计");
    const { container } = render(<PerfHud memory={memory} />);

    expect(screen.getByText("内存")).toBeInTheDocument();
    expect(screen.getByText("对话存储")).toBeInTheDocument();
    expect(screen.getByText(/已用 1\.0 MB（1 个项目）/)).toBeInTheDocument();
    expect(screen.getByText(/上限约 5\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText(/自动精简/)).toBeInTheDocument();
    // 评审移除的承载物一并不在
    expect(screen.queryByText(/体检/)).not.toBeInTheDocument();
    expect(screen.queryByText(/灌入/)).not.toBeInTheDocument();
    expect(screen.queryByText(/开发者细节/)).not.toBeInTheDocument();
    expect(container.querySelector("button")).toBeNull();
  });

  it("jsdom 无 performance.memory：内存块显示不支持读数", () => {
    render(<PerfHud memory={memory} />);
    expect(screen.getByText("此环境不支持内存读数")).toBeInTheDocument();
  });
});

describe("MemoryChart（折线图）", () => {
  it("样本不足两点显示采样中占位", async () => {
    vi.resetModules();
    const { MemoryChart } = await import("../../src/plugins/diagnostics/ui/perf/MemoryChart.tsx");
    render(<MemoryChart />);
    expect(screen.getByText(/采样中/)).toBeInTheDocument();
  });
});
