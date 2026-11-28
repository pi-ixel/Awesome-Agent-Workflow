import { webcrypto } from "node:crypto";
import type { Context } from "cordis";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createTestDesktopRuntime } from "../../../helpers/desktopRuntime.ts";
import { installDesktopWorkbench } from "../../../../src/bootstrap/installDesktopWorkbench.ts";
import type { GitChange } from "../../../../src/plugins/host/types.ts";
import {
  encodeAnnotationMessage,
  decodeAnnotationMessage,
} from "../../../../src/plugins/project/composer/annotationMessage.ts";
import { draftScopeKey } from "../../../../src/plugins/project/composer/scope.ts";
import { newProjectPath } from "../../../../src/shared/panelPaths.ts";

it("Git Changes 批注归入会话草稿，准确匹配版本，并兼容发送后的历史批注", async ({
  onTestFinished,
}) => {
  vi.stubGlobal("crypto", webcrypto);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    async (context) => {
      root = context;
      await installDesktopWorkbench(context);
    },
  );
  onTestFinished(() => runtime.shutdown());
  const { project, git, workbench } = await runtime.ready;
  const owner = newProjectPath("/primary");
  const repositoryTarget = "/repo/subfolder";
  project.projects.updateProjectFolders(owner, {
    name: "多目录项目",
    relatedPaths: [repositoryTarget],
  });
  const change: GitChange = {
    source: "unstaged",
    path: "renamed.ts",
    oldPath: "original.ts",
    status: "R",
  };
  const snapshot = {
    repoRoot: "/repo",
    branch: "main",
    watchPaths: [],
    changes: [change],
  };
  const old = "original";
  const patch = (text: string) => ({
    patch: `@@ -1 +1 @@\n-${old}\n+${text}\n`,
    notice: null,
    beforeContent: old + "\n",
    afterContent: text + "\n",
  });
  vi.spyOn(git, "status").mockResolvedValue(snapshot);
  const diff = vi.spyOn(git, "diff").mockResolvedValue(patch("current"));
  const value = { data: snapshot, loading: false };
  const empty = { loading: true };
  vi.spyOn(git, "query").mockImplementation((project) => ({
    getSnapshot: () => (project === repositoryTarget ? value : empty),
    subscribe: () => () => {},
    refresh: () => Promise.resolve(),
    invalidate: () => {},
  }));
  project.projects.openWorkspace(owner);
  const editor = project.drafts.annotationEditor;
  const show = vi.spyOn(editor, "showAfterSave");
  const Panel = workbench
    .getSnapshot()
    .panels.find(({ id }) => id === "git")!.View;
  const rendered = render(
    <Panel project={owner} tab={undefined} openPath={() => {}} visible />,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Git 项目" }));
  await userEvent.click(screen.getByRole("option", { name: "subfolder" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "展开 renamed.ts" }),
  );
  const code = await screen.findByText(old, { exact: true });
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(code);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.pointerUp(code, { clientX: 380, clientY: 150 });
  expect(screen.getByRole("group", { name: "选区操作" })).toHaveStyle({
    left: "380px",
    top: "156px",
  });
  fireEvent.keyDown(window, { key: "Escape" });
  selection.removeAllRanges();

  await userEvent.click(
    await screen.findByRole("button", { name: "批注修改前 · 第 1 行" }),
  );
  const form = screen.getByRole("dialog", { name: "文档批注" });
  expect(within(form).getByText("original", { exact: true })).toBeVisible();
  await userEvent.type(
    within(form).getByRole("textbox", { name: "批注意见" }),
    "旧侧批注",
  );
  await userEvent.click(
    within(form).getByRole("button", { name: "添加到会话" }),
  );
  await screen.findByRole("button", { name: "收起 renamed.ts" });
  await vi.waitFor(() => expect(form).not.toBeInTheDocument());
  const target = editor.current(owner)!;
  const [annotation] = editor.read(target);
  expect(annotation).toMatchObject({
    project: owner,
    path: "/repo/original.ts",
    quote: old,
    comment: "旧侧批注",
    diff: {
      kind: "git",
      target: repositoryTarget,
      root: "/repo",
      file: "renamed.ts",
      side: "old",
      first: 1,
      last: 1,
    },
  });
  const state = project.conversation.foreground.session.getState();
  const scope = draftScopeKey(owner, null, state.agentKey);
  expect(
    project.drafts.annotationDrafts.getState().drafts[scope]?.annotations,
  ).toEqual([annotation]);
  expect(show).not.toHaveBeenCalled();
  expect(
    decodeAnnotationMessage(encodeAnnotationMessage("说明", [annotation!]))
      ?.annotations,
  ).toEqual([annotation]);

  rendered.unmount();
  const reopen = root!.gitUi.annotationView!;
  const view = render(await reopen(annotation!));
  expect(
    view.container.querySelector("[data-diff-annotation-location]"),
  ).toHaveTextContent(old);
  view.unmount();
  diff.mockResolvedValue(patch("changed after save"));
  expect(await reopen(annotation!)).toBeNull();
  expect(editor.read(target)[0]?.quote).toBe(old);
  diff.mockClear();
  expect(await reopen({ ...annotation!, project: "/unrelated" })).toBeNull();
  expect(diff).not.toHaveBeenCalled();
}, 20_000);
