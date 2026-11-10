import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ResourceReport } from "../../../src/plugins/diagnostics/ui/ResourceReport.tsx";
import type { ResourceSnapshot } from "../../../src/plugins/diagnostics/types.ts";

it("shows separate totals, process details, history and connection association", () => {
  const at = Date.now();
  const desktop = {
    id: "desktop",
    handle: null,
    rootPid: 1,
    cpuPercent: 3,
    memoryBytes: 104857600,
    incomplete: false,
  };
  const agent = {
    id: "agent:7",
    handle: 7,
    rootPid: 2,
    cpuPercent: 5,
    memoryBytes: 209715200,
    incomplete: false,
  };
  const resources: ResourceSnapshot = {
    supported: true,
    error: null,
    exited: [],
    groups: [
      {
        ...desktop,
        processes: [
          {
            pid: 1,
            parentPid: 0,
            name: "desktop.exe",
            cpuPercent: 3,
            memoryBytes: 104857600,
          },
        ],
      },
      {
        ...agent,
        processes: [
          {
            pid: 2,
            parentPid: 1,
            name: "agent.exe",
            cpuPercent: 5,
            memoryBytes: 209715200,
          },
        ],
      },
    ],
    history: [{ at, groups: [desktop, agent] }],
  };
  render(
    <ResourceReport
      resources={resources}
      jsHeapBytes={32 * 1024 * 1024}
      connections={[
        {
          id: "conn",
          state: "ready",
          processHandle: 7,
          sessions: [],
          probe: null,
        },
      ]}
    />,
  );
  const heap = screen.getByText("前端 JS 堆");
  expect(heap).not.toBeVisible();
  const desktopDetails = heap.closest("details")!;
  expect(desktopDetails.open).toBe(false);
  fireEvent.click(desktopDetails.querySelector("summary")!);
  expect(heap).toBeVisible();
  expect(screen.getByText("32 MiB")).toBeVisible();
  expect(screen.getAllByText("100 MiB")[0]).toBeVisible();
  expect(screen.getAllByText("200 MiB")[0]).toBeVisible();
  expect(
    screen
      .getByRole("img", { name: "CPU最近 15 分钟趋势" })
      .querySelectorAll("polyline"),
  ).toHaveLength(2);
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "agent:7" },
  });
  expect(
    screen
      .getByRole("img", { name: "CPU最近 15 分钟趋势" })
      .querySelectorAll("polyline"),
  ).toHaveLength(1);
  expect(
    screen.getByRole("img", { name: "CPU最近 15 分钟趋势" }),
  ).toBeInTheDocument();
  expect(screen.getByText("ACP 连接：conn")).toBeInTheDocument();
  expect(screen.getByText("agent.exe")).toBeInTheDocument();
});

it("separates exited agents from the current process groups", () => {
  const at = Date.now();
  const resources: ResourceSnapshot = {
    supported: true,
    error: null,
    groups: [
      {
        id: "agent:10",
        handle: 10,
        rootPid: 43,
        cpuPercent: 0,
        memoryBytes: 1048576,
        incomplete: false,
        processes: [],
      },
    ],
    history: [],
    exited: [{ handle: 9, pid: 42, observedAt: at }],
  };
  render(<ResourceReport resources={resources} connections={[]} />);
  expect(screen.getByRole("heading", { name: "当前进程组 1" })).toBeVisible();
  const history = screen.getByText("历史进程组 · 1");
  const exited = screen.getByText(/检测到退出/);
  expect(exited).toHaveTextContent("Agent · 句柄 9");
  expect(exited).not.toBeVisible();
  fireEvent.click(history);
  expect(exited).toBeVisible();
  expect(screen.getByRole("group", { name: "历史进程组" })).toHaveTextContent(
    "句柄 9",
  );
});
