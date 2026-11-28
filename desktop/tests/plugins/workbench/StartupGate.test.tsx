import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { knownWorkspacePaths } from "../../../src/plugins/project/workspace/knownPaths.ts";
import { StartupGate } from "../../../src/plugins/workbench/ui/StartupGate.tsx";
import { WorkbenchContext } from "../../../src/plugins/workbench/ui/bindings/react.ts";
import type { WorkbenchService } from "../../../src/plugins/workbench/service.ts";
import { pathKey } from "../../../src/shared/panelPaths.ts";
import { createTestProjectIndexes } from "../../helpers/projectIndexes.ts";
import { createTestProjectWorkbench } from "../../helpers/projectWorkbench.tsx";

function mount(workbench: WorkbenchService) {
  return render(
    <StrictMode>
      <WorkbenchContext.Provider value={workbench}>
        <StartupGate>
          <button>工作区操作</button>
        </StartupGate>
      </WorkbenchContext.Provider>
    </StrictMode>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("启动欢迎页", () => {
  it("播放开场，项目仍在后台查询时按动画时长显示工作区", () => {
    const indexes = createTestProjectIndexes();
    const fixture = createTestProjectWorkbench({ sessions: indexes });
    const path = pathKey("D:/project");
    const catalog = indexes.catalog;
    try {
      fixture.workbench.register("startup", {
        id: "test",
        shouldPlay: () => true,
      });
      catalog.setState({
        agentKey: "agent",
        statusByPath: { [path]: { state: "loading" } },
      });
      vi.useFakeTimers();
      mount(fixture.workbench);
      expect(screen.getByRole("status")).toBeVisible();
      act(() => {
        vi.advanceTimersByTime(1199);
      });
      expect(
        screen.queryByRole("button", { name: "工作区操作" }),
      ).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole("button", { name: "工作区操作" })).toBeVisible();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(catalog.getState().statusByPath[path]?.state).toBe("loading");
    } finally {
      cleanup();
      fixture.dispose();
      indexes.dispose();
    }
  });

  it.each([false, true])(
    "按项目或减少动画设置跳过开场（reduce=%s）",
    (reduce) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: reduce })),
      );
      const fixture = createTestProjectWorkbench({});
      try {
        fixture.workbench.register("startup", {
          id: "test",
          shouldPlay: () => reduce,
        });
        mount(fixture.workbench);
        expect(
          screen.getByRole("button", { name: "工作区操作" }),
        ).toBeVisible();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
      } finally {
        cleanup();
        fixture.dispose();
      }
    },
  );

  it("启动来源卸载后立即显示工作区，并清理定时器", () => {
    vi.useFakeTimers();
    const fixture = createTestProjectWorkbench({});
    try {
      const release = fixture.workbench.register("startup", {
        id: "test",
        shouldPlay: () => true,
      });
      mount(fixture.workbench);
      expect(screen.getByRole("status")).toBeVisible();
      act(release);
      expect(screen.getByRole("button", { name: "工作区操作" })).toBeVisible();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cleanup();
      fixture.dispose();
    }
  });

  it("置顶、最近、选中和当前项目使用同一路径规则去重", () => {
    expect(
      knownWorkspacePaths({
        selectedPath: "D:\\project",
        activePath: "D:/project",
        pinnedPaths: ["D:/second"],
        recentWorkspaces: [{ path: "d:/PROJECT" }],
      }),
    ).toEqual(["D:\\project", "D:/second"]);
  });
});
