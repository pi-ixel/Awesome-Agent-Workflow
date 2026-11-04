import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ElicitationModal } from "../../src/ui/ElicitationModal.tsx";
import { offerElicitation } from "../../src/stores/elicitationStore.ts";

it("renders a real form, validates and sends typed values", async () => {
  const result = offerElicitation(
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
  expect(screen.getByRole("button", { name: "提交" })).toBeDisabled();
  await user.type(screen.getByLabelText(/数量/), "3");
  await user.selectOptions(screen.getByLabelText(/启用/), "false");
  await user.click(screen.getByRole("button", { name: "提交" }));
  expect(await result).toEqual({
    action: "accept",
    content: { count: 3, enabled: false },
  });
});

it("disconnect never leaves a blocking modal over reconnect controls", async () => {
  const controller = new AbortController();
  const result = offerElicitation(
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
