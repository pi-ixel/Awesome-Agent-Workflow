/**
 * AAW 状态面板组件测试。
 *
 * 面板回答的是**人的**三个问题：现在在哪一步、这一步要产出什么、卡在
 * 哪。因此断言分两组：
 * - 呈现：步骤条 / 门禁徽标 / 工作单摘要（类型、点名 skill、数据与交付件）；
 * - 边界：agent 侧的执行细节（done 命令行原文）**默认不露**，只在用户
 *   主动展开「执行详情」时可见——把引擎命令摊给用户是我们修掉的毛病。
 *
 * 放行是全流程里唯一需要人拍板的一步：注入 onRunCommand 时给一个
 * 「放行进入下一步」动作，交给会话的是一条自然语言请求（不是命令行）。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AawStatusPanel from "../../../src/plugins/workflow/ui/AawStatusPanel.tsx";
import { workflowStatus, workflowTestService } from "../../helpers/workflow.ts";
import {
  sampleNextAwaitingJson,
  sampleNextJson,
  sampleSrListJson,
  sampleStatusJson,
} from "../../fixtures/aawWorkflowSamples.ts";

const user = userEvent.setup();

beforeEach(() => {
  workflowStatus.getState().reset();
  workflowStatus.getState().bindLoader(null);
});
/**
 * 经真实通路预置面板数据：绑定返回样本载荷的 loader 并刷新 + 切到
 * SR-004（与用户在界面上的操作序列一致）。
 */
async function seedPanelData(
  nextPayload: unknown = sampleNextJson,
): Promise<void> {
  workflowStatus.getState().bindLoader({
    listSrs: () => Promise.resolve(sampleSrListJson),
    readStatus: () => Promise.resolve(sampleStatusJson),
    readNext: () => Promise.resolve(nextPayload),
    readPlan: () => Promise.resolve({ ok: false }),
  });
  await workflowStatus.getState().refresh();
  workflowStatus.getState().selectSr("SR-004");
  await vi.waitFor(() => {
    expect(workflowStatus.getState().currentSr).toBe("SR-004");
  });
  await vi.waitFor(() => {
    expect(workflowStatus.getState().next).not.toBeNull();
  });
}

describe("AawStatusPanel", () => {
  it("列表成功但详情失败时仍可选择其他 SR", async () => {
    workflowStatus.getState().bindLoader({
      listSrs: () => Promise.resolve(sampleSrListJson),
      readStatus: (sr) =>
        sr === "SR-001"
          ? Promise.reject(new Error("需要迁移"))
          : Promise.resolve(sampleStatusJson),
      readNext: (sr) =>
        sr === "SR-001"
          ? Promise.reject(new Error("需要迁移"))
          : Promise.resolve(sampleNextJson),
      readPlan: () => Promise.resolve(null),
    });
    await workflowStatus.getState().refresh();
    render(<AawStatusPanel workflow={workflowTestService} />);
    const select = screen.getByRole("combobox", { name: "当前 SR" });
    expect(select).toHaveTextContent("SR-001");
    expect(select).not.toBeDisabled();
    await user.click(select);
    await user.click(screen.getByRole("option", { name: "SR-004" }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(select).toHaveTextContent("SR-004");
  });

  it("首次读取失败只显示错误，不声称没有工作流", async () => {
    workflowStatus.getState().bindLoader({
      listSrs: () => Promise.reject(new Error("aaw 工具文件不存在")),
      readStatus: () => Promise.resolve(null),
      readNext: () => Promise.resolve(null),
      readPlan: () => Promise.resolve(null),
    });
    await workflowStatus.getState().refresh();
    render(<AawStatusPanel workflow={workflowTestService} />);
    expect(screen.getByRole("alert")).toHaveTextContent("aaw 工具文件不存在");
    expect(screen.queryByText(/暂无.*工作流/)).not.toBeInTheDocument();
  });

  it("查询成功且列表为空才显示暂无工作流", async () => {
    workflowStatus.getState().bindLoader({
      listSrs: () => Promise.resolve({ ok: true, srs: [] }),
      readStatus: () => Promise.resolve(null),
      readNext: () => Promise.resolve(null),
      readPlan: () => Promise.resolve(null),
    });
    await workflowStatus.getState().refresh();
    render(<AawStatusPanel workflow={workflowTestService} />);
    expect(screen.getByText(/当前项目暂无 AAW 工作流/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("首次读取中只显示加载提示", () => {
    workflowStatus.getState().bindLoader({
      listSrs: () => new Promise<unknown>(() => undefined),
      readStatus: () => Promise.resolve(null),
      readNext: () => Promise.resolve(null),
      readPlan: () => Promise.resolve(null),
    });
    void workflowStatus.getState().refresh();
    render(<AawStatusPanel workflow={workflowTestService} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取工作流");
    expect(screen.queryByText(/暂无.*工作流/)).not.toBeInTheDocument();
  });

  it("刷新失败保留上次进度并标注过期数据", async () => {
    await seedPanelData();
    const loader = workflowStatus.getState().loader!;
    workflowStatus.getState().bindLoader({
      ...loader,
      listSrs: () => Promise.reject(new Error("查询失败")),
    });
    await workflowStatus.getState().refresh();
    render(<AawStatusPanel workflow={workflowTestService} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "刷新失败，显示上次读取结果",
    );
    expect(
      screen.getByRole("list", { name: "就绪工作单" }),
    ).toBeInTheDocument();
  });

  it("未绑定数据源时显示引导空态，不显示刷新动作", () => {
    render(<AawStatusPanel workflow={workflowTestService} />);
    expect(screen.getByText(/尚未连接工作流数据源/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^刷新$/ })).toBeDisabled();
  });

  it("渲染当前 SR、入口、进度与阶段步骤条", async () => {
    await seedPanelData();
    render(<AawStatusPanel workflow={workflowTestService} />);

    expect(screen.getByRole("combobox", { name: "当前 SR" })).toHaveTextContent(
      "SR-004",
    );
    expect(screen.getByText("入口 dev · in_progress")).toBeInTheDocument();
    // 进度：细进度条 + 数字（aria-valuenow 供辅助技术读取）
    const progress = screen.getByRole("progressbar");
    expect(progress).toHaveAttribute("aria-valuenow", "2");
    expect(progress).toHaveAttribute("aria-valuemax", "6");
    expect(screen.getByText("2/6")).toBeInTheDocument();

    // 步骤条：已完成 2、当前 1、待办 3，门禁步骤带徽标
    const steps = screen.getByRole("list", { name: /阶段步骤/i });
    expect(within(steps).getAllByText("已完成")).toHaveLength(2);
    expect(within(steps).getAllByText("当前")).toHaveLength(1);
    expect(within(steps).getAllByText("待办")).toHaveLength(3);
    expect(within(steps).getAllByText("门禁")).toHaveLength(1);
    expect(within(steps).getByText("测试设计")).toBeInTheDocument();
    expect(within(steps).getByText("设计门禁")).toBeInTheDocument();
  });

  it("渲染当前工作单摘要：编号、名称、点名 skill、数据与交付件", async () => {
    await seedPanelData();
    render(<AawStatusPanel workflow={workflowTestService} />);

    const orders = screen.getByRole("list", { name: "就绪工作单" });
    expect(within(orders).getByText("#3")).toBeInTheDocument();
    expect(within(orders).getByText("测试设计")).toBeInTheDocument();
    expect(within(orders).getByText("dev-test-design")).toBeInTheDocument();
    expect(within(orders).getByText(/点名 skill/)).toBeInTheDocument();
    expect(within(orders).getByText(/需提交数据/)).toBeInTheDocument();
    expect(within(orders).getByText(/强制交付件/)).toBeInTheDocument();
  });

  it("done 命令行默认不露：只在展开「执行详情」时才可见", async () => {
    await seedPanelData();
    render(<AawStatusPanel workflow={workflowTestService} />);

    // 默认：没有命令行原文，也没有任何指着它的动作
    expect(screen.queryByText(/--sr SR-004/)).not.toBeInTheDocument();
    expect(screen.queryByText(/done 预览/)).not.toBeInTheDocument();
    expect(screen.queryByText(/aaw\.py/)).not.toBeInTheDocument();

    // 主动展开后才有（用户要查就给他，但别摆在正面上）
    await user.click(screen.getByRole("button", { name: "执行详情" }));
    expect(screen.getByText(/--sr SR-004/)).toBeInTheDocument();
  });

  it("awaiting_user_confirm：显示待确认提示与来源", async () => {
    await seedPanelData(sampleNextAwaitingJson);
    render(<AawStatusPanel workflow={workflowTestService} />);

    expect(screen.getByText(/等待用户确认是否放行/)).toBeInTheDocument();
    expect(screen.getByText(/来源：#3 测试设计/)).toBeInTheDocument();
    // 放行命令行同样默认收起
    expect(screen.queryByText(/放行预览/)).not.toBeInTheDocument();
  });

  it("刷新触发 loader 读取", async () => {
    const listSrs = vi.fn(() => Promise.resolve(sampleSrListJson));
    const readStatus = vi.fn(() => Promise.resolve(sampleStatusJson));
    const readNext = vi.fn(() => Promise.resolve(sampleNextJson));
    const readPlan = vi.fn(() => Promise.resolve({ ok: false }));
    workflowStatus.getState().bindLoader({
      listSrs,
      readStatus,
      readNext,
      readPlan,
    });
    render(<AawStatusPanel workflow={workflowTestService} />);

    await user.click(screen.getByRole("button", { name: /^刷新$/ }));
    await vi.waitFor(() => {
      expect(listSrs).toHaveBeenCalledTimes(1);
      expect(readStatus).toHaveBeenCalledWith("SR-001");
      expect(readNext).toHaveBeenCalledWith("SR-001");
    });
  });

  it("切换当前 SR 触发该 SR 的读取（自绘下拉，不是原生 select）", async () => {
    const listSrs = vi.fn(() => Promise.resolve(sampleSrListJson));
    const readStatus = vi.fn(() => Promise.resolve(sampleStatusJson));
    const readNext = vi.fn(() => Promise.resolve(sampleNextJson));
    const readPlan = vi.fn(() => Promise.resolve({ ok: false }));
    workflowStatus.getState().bindLoader({
      listSrs,
      readStatus,
      readNext,
      readPlan,
    });
    await workflowStatus.getState().refresh();
    render(<AawStatusPanel workflow={workflowTestService} />);

    // 打开自绘面板并选另一项（原生 select 的 option 由系统绘制，主题管
    // 不到——这里断言面板确实是我们自己的 listbox）
    await user.click(screen.getByRole("combobox", { name: "当前 SR" }));
    const options = screen.getByRole("listbox", { name: "当前 SR" });
    await user.click(within(options).getByRole("option", { name: "SR-004" }));
    await vi.waitFor(() => {
      expect(readStatus).toHaveBeenCalledWith("SR-004");
    });
  });

  it("严格只读：未注入 onRunCommand 时除「刷新」外没有别的动作按钮", async () => {
    await seedPanelData(sampleNextAwaitingJson);
    render(<AawStatusPanel workflow={workflowTestService} />);

    // 「执行详情」是展开开关（不是写操作），放行按钮因未注入而退场
    expect(screen.queryByRole("button", { name: /放行/ })).toBeNull();
    expect(screen.getByText(/放行在会话里执行/)).toBeInTheDocument();
  });

  it("注入 onRunCommand：放行给一个动作，交给会话的是自然语言请求而非命令行", async () => {
    await seedPanelData(sampleNextAwaitingJson);
    const onRunCommand = vi.fn();
    render(<AawStatusPanel workflow={workflowTestService} onRunCommand={onRunCommand} />);

    await user.click(screen.getByRole("button", { name: "放行进入下一步" }));
    expect(onRunCommand).toHaveBeenCalledTimes(1);
    const sent = String(onRunCommand.mock.calls[0]?.[0] ?? "");
    expect(sent).toContain("放行");
    // 发给会话的是请求，不是 aaw.py 的命令行（那是执行详情里的事）
    expect(sent).not.toContain("aaw.py");
  });

  it("就绪工作单里没有「交给会话执行」这类把 agent 的活推给用户的按钮", async () => {
    await seedPanelData();
    render(<AawStatusPanel workflow={workflowTestService} onRunCommand={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /交给会话执行/ })).toBeNull();
  });
});
