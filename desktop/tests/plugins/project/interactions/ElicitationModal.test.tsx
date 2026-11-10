import { bindTestLayout, useWorkbenchUiStore } from "../../../helpers/layout.ts";
import {
  createTestProjectPreferences,
  projectPreferencesWrapper,
} from "../../../helpers/projectPreferences.tsx";
import { Fragment, type ReactElement } from "react";
import { createTestProjectWorkbench } from "../../../helpers/projectWorkbench.tsx";
import {
  act,
  render as renderReact,
  screen,
  type RenderOptions,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  ElicitationModal,
  ElicitationDock,
} from "../../../../src/plugins/project/interactions/ui/ElicitationModal.tsx";
import { createElicitationQueue } from "../../../../src/plugins/project/interactions/elicitationStore.ts";

it("renders a real form, validates and sends typed values", async () => {
  const result = forms.offer(
    {},
    "CodeAgent",
    {
      message: "配置",
      sessionId: "s",
      requestedSchema: {
        properties: {
          count: { type: "integer", title: "数量", minimum: 1 },
          enabled: { type: "boolean", title: "启用" },
        },
        required: ["count", "enabled"],
      },
    },
    new AbortController().signal,
  );
  render(<ElicitationModal />);
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  await user.type(screen.getByLabelText(/数量/), "3");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await user.click(screen.getByRole("radio", { name: "否" }));
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await result).toEqual({
    action: "accept",
    content: { count: 3, enabled: false },
  });
});

it("disconnect never leaves a blocking modal over reconnect controls", async () => {
  const controller = new AbortController();
  const result = forms.offer(
    {},
    "CodeAgent",
    { message: "输入", sessionId: "s", requestedSchema: { properties: {} } },
    controller.signal,
  );
  render(<ElicitationModal />);
  act(() => controller.abort());
  expect(await result).toEqual({ action: "cancel" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "丢弃草稿" }));
});

const projectPreferences = createTestProjectPreferences();
const PreferencesWrapper = projectPreferencesWrapper(projectPreferences);

let forms: ReturnType<typeof createElicitationQueue>;
let fixture: ReturnType<typeof createTestProjectWorkbench>;

function render(ui: ReactElement, options?: RenderOptions) {
  const Parent = options?.wrapper ?? Fragment;
  return renderReact(ui, {
    ...options,
    wrapper: ({ children }) => (
      <fixture.Wrapper>
        <Parent>{children}</Parent>
      </fixture.Wrapper>
    ),
  });
}

beforeEach(() => {
  projectPreferences.setAutoAnswerQuestions(false);
  forms = createElicitationQueue();
  fixture = createTestProjectWorkbench({
    interactions: {
      forms: forms.view,
      selectForm: forms.selectForm,
      progressForm: forms.progressForm,
      editForm: forms.editForm,
      activateForm: forms.activateForm,
      answerForm: (id, action) => forms.store.getState().answer(id, action),
    },
  });
  bindTestLayout(fixture.workbench);
  useWorkbenchUiStore.setState({ overlay: null, viewId: "session" });
});
afterEach(() => {
  bindTestLayout(undefined);
  forms.dispose();
  fixture.dispose();
  vi.useRealTimers();
});

it("skips only the optional current field and sends the entire typed form at the end", async () => {
  const result = forms.offer(
    {},
    "Agent",
    {
      message: "填写",
      requestId: 1,
      requestedSchema: {
        properties: {
          note: { type: "string", title: "可选备注" },
          count: { type: "integer", title: "必填数量", minimum: 1 },
        },
        required: ["count"],
      },
    },
    new AbortController().signal,
  );
  const completed = vi.fn();
  void result.then(completed);
  render(<ElicitationModal />);
  const user = userEvent.setup();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("第 1／2 题")).toBeVisible();
  await user.type(screen.getByLabelText("可选备注"), "remove me");
  await user.click(screen.getByRole("button", { name: "跳过" }));
  expect(completed).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "跳过" })).toBeDisabled();
  await user.type(screen.getByLabelText("必填数量"), "3");
  expect(forms.store.getState().pending[0]?.values.count).toBe("3");
  await user.click(screen.getByRole("button", { name: "上一题" }));
  expect(screen.getByLabelText("可选备注")).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "跳过" }));
  expect(screen.getByLabelText("必填数量")).toHaveValue(3);
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await result).toEqual({ action: "accept", content: { count: 3 } });
});

it("routes session forms by owner, preserving answers while background requests only show a link", async () => {
  const owner = {},
    activate = vi.fn();
  void forms.offer(
    owner,
    "Background Agent",
    {
      message: "问题",
      sessionId: "s",
      requestedSchema: {
        properties: { name: { type: "string", title: "名字" } },
      },
    },
    new AbortController().signal,
    undefined,
    { workspacePath: "D:/a", sessionId: "s", activate },
  );
  render(
    <>
      <ElicitationModal />
      <ElicitationDock />
    </>,
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "前往回答" }));
  expect(activate).toHaveBeenCalledOnce();
  act(() => forms.setActiveOwner(owner));
  expect(screen.queryByRole("button", { name: "前往回答" })).toBeNull();
  await userEvent.type(screen.getByLabelText("名字"), "saved");
  act(() => forms.setActiveOwner({}));
  expect(screen.queryByRole("textbox")).toBeNull();
  act(() => forms.setActiveOwner(owner));
  expect(screen.getByLabelText("名字")).toHaveValue("saved");
});

it("auto-answers valid enums but never auto-submits required free text", async () => {
  vi.useFakeTimers();
  projectPreferences.setAutoAnswerQuestions(true);
  const result = forms.offer(
    {},
    "Agent",
    {
      message: "选择",
      requestId: 1,
      requestedSchema: {
        properties: { pick: { type: "string", enum: ["a", "b"] } },
        required: ["pick"],
      },
    },
    new AbortController().signal,
  );
  const { unmount } = render(<ElicitationModal />, {
    wrapper: PreferencesWrapper,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(await result).toEqual({ action: "accept", content: { pick: "a" } });
  unmount();
  const completed = vi.fn();
  void forms
    .offer(
      {},
      "Agent",
      {
        message: "输入",
        requestId: 2,
        requestedSchema: {
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      new AbortController().signal,
    )
    .then(completed);
  render(<ElicitationModal />);
  expect(document.querySelector("[data-auto-answer-countdown]")).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(completed).not.toHaveBeenCalled();
});
