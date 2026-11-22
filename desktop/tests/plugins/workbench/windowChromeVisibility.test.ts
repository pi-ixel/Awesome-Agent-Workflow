import { expect, it, vi } from "vitest";
import { createWindowChrome } from "../../../src/plugins/workbench/window/windowChrome.ts";

it("uses native visibility across resize, loss of focus and minimize without treating blur as hidden", async () => {
  let isDisplayed = true;
  let resize = () => {};
  let changeFocus = () => {};
  const unlistenResize = vi.fn();
  const unlistenFocus = vi.fn();
  const chrome = createWindowChrome({
    async minimize() {
      isDisplayed = false;
    },
    async toggleMaximize() {},
    async requestClose() {},
    async isMaximized() {
      return false;
    },
    isDisplayed: async () => isDisplayed,
    listenForResize: async (receive) => {
      resize = receive;
      return unlistenResize;
    },
    listenForFocusChange: async (receive) => {
      changeFocus = receive;
      return unlistenFocus;
    },
  });
  const stop = chrome.observe();
  const displayed = chrome.service.displayed;
  try {
    changeFocus();
    await Promise.resolve();
    expect(displayed?.getState()).toBe(true);

    chrome.service.minimize();
    await vi.waitFor(() => expect(displayed?.getState()).toBe(false));
    isDisplayed = true;
    resize();
    await vi.waitFor(() => expect(displayed?.getState()).toBe(true));
    isDisplayed = false;
    changeFocus();
    await vi.waitFor(() => expect(displayed?.getState()).toBe(false));
  } finally {
    await stop();
  }
  expect(unlistenResize).toHaveBeenCalledOnce();
  expect(unlistenFocus).toHaveBeenCalledOnce();
});
