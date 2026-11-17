import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const root = new URL("../src-tauri/installer/ui/", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const script = await readFile(new URL("app.js", root), "utf8");
const dom = new JSDOM(html, {
  runScripts: "outside-only",
  url: "http://tauri.localhost",
});
const { window } = dom;
const calls = [];
let selection = null;
let state = {
  phase: "ready",
  busy: false,
  update: false,
  stage: "prepare",
  destination: "C:\\Apps\\AAW Desktop",
  version: "0.1.8",
  error: "",
};
window.matchMedia = () => ({ matches: true, addEventListener() {} });
window.ResizeObserver = class {
  observe() {}
};
window.requestAnimationFrame = () => 1;
window.cancelAnimationFrame = () => {};
window.HTMLCanvasElement.prototype.getContext = () => ({});
window.__TAURI_INTERNALS__ = {
  invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "installer_status") return { ...state };
    if (command === "installer_pick_directory") {
      if (selection instanceof Error) throw selection;
      return selection;
    }
    if (command === "installer_return_to_options")
      state = { ...state, phase: "ready", stage: "prepare", error: "" };
    if (command === "installer_begin")
      state = {
        ...state,
        destination: args.destination,
        phase: "installing",
        busy: true,
      };
  },
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const click = (selector) => window.document.querySelector(selector).click();
try {
  window.eval(script);
  await settle();
  click("#path");
  await settle();
  assert.equal(
    window.document.querySelector("#path").value,
    state.destination,
    "cancel preserves destination",
  );
  selection = new Error("不能直接安装到磁盘根目录");
  click("#path");
  await settle();
  assert.equal(window.document.querySelector("#path").value, state.destination);
  assert.equal(window.document.querySelector("#path").disabled, false);
  assert.match(window.document.querySelector("#error").textContent, /磁盘根目录/);
  selection = "D:\\My workspace\\AAW";
  click("#path");
  await settle();
  assert.equal(window.document.querySelector("#path").value, selection);
  assert.equal(window.document.querySelector("#error").textContent, "");
  window.document.querySelector("#shortcut").checked = false;
  click('[data-action="begin"]');
  await settle();
  const begin = calls.find((c) => c.command === "installer_begin");
  assert.equal(begin.args.destination, selection);
  assert.equal(begin.args.shortcut, false);
  assert.equal(
    window.document.querySelector("#close").disabled,
    true,
    "close disabled while installing",
  );
  state = {
    ...state,
    phase: "failure",
    busy: false,
    error: '<img src=x onerror="alert(1)">',
  };
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(
    window.document.querySelector("#panel img"),
    null,
    "native errors rendered as text",
  );
  assert.equal(window.document.querySelector("#close").disabled, false);
  click('[data-action="retry"]');
  await settle();
  assert.equal(
    calls.filter((c) => c.command === "installer_begin").at(-1).args.shortcut,
    false,
    "retry preserves shortcut preference",
  );
  state = { ...state, phase: "failure", busy: false };
  await new Promise((resolve) => setTimeout(resolve, 400));
  click('[data-action="options"]');
  await settle();
  assert.equal(window.document.querySelector("#path").value, selection);
  assert.equal(window.document.querySelector("#shortcut").checked, false);
  selection = "D:\\Other workspace\\AAW";
  click("#path");
  await settle();
  click('[data-action="begin"]');
  await settle();
  assert.equal(
    calls.filter((c) => c.command === "installer_begin").at(-1).args.destination,
    selection,
  );
  click("#minimize");
  await settle();
  assert.equal(calls.find((call) => call.command === "installer_window").args.action, "minimize");
  state = { ...state, phase: "failure", busy: false, update: true };
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(window.document.querySelector('[data-action="retry"]'));
  assert.equal(window.document.querySelector('[data-action="options"]'), null);
  console.log(
    "PASS: directory cancel and validation recovery, changing the destination after failure, retry preferences, close guard, failure escaping, minimize",
  );
} finally {
  window.close();
}
