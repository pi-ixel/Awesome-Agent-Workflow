import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConnectionReport } from "../../../src/plugins/diagnostics/ui/ConnectionReport.tsx";

it("counts distinct ready projects and sessions separately from loading sessions", () => {
  const probe = vi.fn();
  render(
    <ConnectionReport
      probe={probe}
      connections={[
        {
          id: "one",
          state: "ready",
          probe: null,
          sessions: [
            {
              id: "s1",
              state: "ready",
              running: true,
              project: { id: "p1", path: "C:/one" },
            },
            {
              id: "s2",
              state: "ready",
              running: false,
              project: { id: "p1", path: "C:/one" },
            },
            {
              id: "s3",
              state: "loading",
              running: false,
              project: { id: "p2", path: "C:/two" },
            },
          ],
        },
        {
          id: "two",
          state: "initializing",
          probe: null,
          sessions: [
            {
              id: "s4",
              state: "ready",
              running: false,
              project: { id: "p1", path: "C:/one" },
            },
            {
              id: "s5",
              state: "ready",
              running: false,
              project: { id: "p2", path: "C:/two" },
            },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByLabelText("one 负载")).toHaveTextContent(
    "项目1session2执行中1",
  );
  expect(screen.getByLabelText("two 负载")).toHaveTextContent(
    "项目2session2执行中0",
  );
  fireEvent.click(screen.getAllByText("项目与 session 明细")[0]!);
  expect(screen.getByText("s3").closest("li")).toHaveTextContent("加载中");
  fireEvent.click(screen.getByRole("button", { name: "测试全部" }));
  expect(probe.mock.calls).toEqual([["one"], ["two"]]);
});

it("merges runtime details, keeps alerts visible while collapsed, and retains unbound sessions", () => {
  render(
    <ConnectionReport
      probe={vi.fn()}
      connections={[
        {
          id: "connection-alpha",
          state: "ready",
          probe: null,
          sessions: [
            {
              id: "merged",
              state: "ready",
              running: true,
              project: { id: "p", path: "C:/Project" },
            },
          ],
        },
      ]}
      runtime={[
        {
          sessionId: "merged",
          workspacePath: "c:\\project",
          isActive: true,
          busyReason: "等待授权",
          queuedPrompts: 2,
          pendingApprovals: 1,
        },
        { sessionId: "orphan", agentCrashed: "进程已退出" },
        { listOnly: true },
      ]}
    />,
  );
  expect(screen.getAllByText("等待授权")[0]).toBeVisible();
  expect(screen.getAllByText("进程已退出")[0]).toBeVisible();
  expect(screen.getAllByText("预热")[0]).toBeVisible();
  expect(
    screen.getByText("项目与 session 明细").closest("details"),
  ).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("项目与 session 明细"));
  expect(screen.getByText("当前")).toBeVisible();
  expect(screen.getByText("排队 2")).toBeVisible();
  expect(screen.getByText("待审批 1")).toBeVisible();
  expect(screen.getByRole("button", { name: "复制连接 ID" })).toBeVisible();
  expect(screen.getAllByText("merged")).toHaveLength(1);
});
