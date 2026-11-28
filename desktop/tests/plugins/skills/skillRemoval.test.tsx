import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type {
  NativeSkillLibrary,
  SkillCatalog,
  SkillRemovalResult,
} from "../../../src/plugins/host/types.ts";
import { SkillLibrary } from "../../../src/plugins/skills/ui/SkillLibrary.tsx";
import { Feedback } from "../../../src/shared/ui/feedback.ts";
import type { WorkbenchService } from "../../../src/plugins/workbench/service.ts";

const path = "C:/test/.cac/skills/sample";
const skill = {
  path,
  source: "C:/test/.cac/skills",
  name: "sample",
  description: "样例",
  realPath: path,
  preview: "正文",
  status: "正常",
  kind: "directory" as const,
  isLink: false,
  revision: "r1",
};
const data: SkillCatalog = {
  profile: null,
  profiles: [],
  warnings: [],
  trash: [],
  entries: [skill, { ...skill, path: path + "-other", name: "other" }],
  sources: [
    {
      path: skill.source,
      label: ".cac",
      project: null,
      kind: "directory",
      enabled: true,
      canImport: true,
    },
  ],
};
const result: SkillRemovalResult = {
  name: "sample",
  path,
  id: null,
  ok: true,
  message: "已永久删除",
  stopped: null,
};

async function setup(remove: NonNullable<NativeSkillLibrary["remove"]>) {
  const notify = vi.fn<WorkbenchService["showToast"]>();
  const list = vi.fn().mockResolvedValue(data);
  const change = vi.fn().mockResolvedValue([]);
  render(
    <Feedback.Provider value={notify}>
      <SkillLibrary
        library={{
          list,
          change,
          remove,
          candidates: () => Promise.resolve([]),
        }}
        provider="codeagent"
        storage={window.localStorage}
        knownProjects={() => []}
        pick={() => Promise.resolve(null)}
        reveal={() => Promise.resolve()}
      />
    </Feedback.Provider>,
  );
  const sample = await screen.findByRole("article", { name: "sample" });
  const other = screen.getByRole("article", { name: "other" });
  const user = userEvent.setup();
  await user.click(within(sample).getByRole("button", { name: "sample 删除" }));
  return { user, sample, other, list, change, notify };
}

it("取消删除不发请求；确认删除只更新目标，反馈走 Toast 且不重扫", async () => {
  const remove = vi.fn().mockResolvedValue([result]);
  const { user, sample, other, list, change, notify } = await setup(remove);
  await user.keyboard("{Escape}");
  expect(remove).not.toHaveBeenCalled();
  await user.click(within(sample).getByRole("button", { name: "sample 删除" }));
  await user.click(screen.getByRole("button", { name: "永久删除" }));
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "ok",
        message: "sample · 已永久删除",
      }),
    ),
  );
  expect(screen.queryByRole("article", { name: "sample" })).toBeNull();
  expect(screen.getByRole("article", { name: "other" })).toBe(other);
  expect(screen.queryByText("sample · 已永久删除")).toBeNull();
  expect(list).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
});

it.each(["业务失败", "请求异常"])(
  "%s 不误报成功、不丢失卡片、不在面板打印",
  async (failure) => {
    const remove =
      failure === "请求异常"
        ? vi.fn().mockRejectedValue(new Error("文件占用"))
        : vi
            .fn()
            .mockResolvedValue([{ ...result, ok: false, message: "文件占用" }]);
    const { user, sample, list, notify } = await setup(remove);
    await user.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "danger" }),
      ),
    );
    expect(notify.mock.lastCall?.[0].message).toContain("文件占用");
    expect(screen.getByRole("article", { name: "sample" })).toBe(sample);
    expect(screen.queryByText(/文件占用/)).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  },
);

it("部分失败使用警告反馈，仅移除成功条目", async () => {
  const remove = vi.fn().mockResolvedValue([
    result,
    {
      ...result,
      path: path + "-other",
      name: "other",
      ok: false,
      message: "拒绝访问",
    },
  ]);
  const { user, other, notify } = await setup(remove);
  await user.click(screen.getByRole("button", { name: "永久删除" }));
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warn" }),
    ),
  );
  expect(notify.mock.lastCall?.[0].message).toContain("已删除 1 项，失败 1 项");
  expect(screen.queryByRole("article", { name: "sample" })).toBeNull();
  expect(screen.getByRole("article", { name: "other" })).toBe(other);
});

it("已停用但永久删除失败时保留可重试条目，不重扫也不误报删除成功", async () => {
  const remove = vi.fn().mockResolvedValue([
    {
      ...result,
      ok: false,
      message: "已停用，删除未完成，请在已停用列表重试 · 文件占用",
      stopped: {
        ...skill,
        id: "disabled-sample",
        project: null,
        unavailable: null,
      },
    },
  ]);
  const { user, list, notify } = await setup(remove);
  await user.click(screen.getByRole("button", { name: "永久删除" }));
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "danger" }),
    ),
  );
  const card = screen.getByRole("article", { name: "sample" });
  expect(
    within(card).getByRole("switch", { name: "sample 启用" }),
  ).not.toBeChecked();
  expect(list).toHaveBeenCalledTimes(1);
});
