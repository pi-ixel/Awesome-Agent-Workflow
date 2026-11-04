// Exercise the real Windows WebView2 -> Tauri command dispatch. No update is
// prepared, so this must return the precondition error without exiting the app.
// This catches stack exhaustion while IPC constructs the update_install future,
// before the helper-only tests can observe any handoff.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32")
  throw new Error("Windows-only IPC smoke test");
const executable = path.resolve(
  process.argv[2] ??
    "src-tauri/target/x86_64-pc-windows-msvc/release/desktop.exe",
);
await fs.access(executable);
const root = path.resolve("src-tauri/target/update-ipc-tests");
await fs.mkdir(root, { recursive: true });
const profile = await fs.mkdtemp(path.join(root, "profile-"));
const listener = net.createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const child = spawn(executable, [], {
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      "--remote-debugging-address=127.0.0.1 --remote-debugging-port=" + port,
  },
});
let ended = false;
let exitCode;
let spawnError;
const exited = new Promise((resolve) => {
  child.once("error", (error) => {
    spawnError = error;
    ended = true;
    resolve();
  });
  child.once("exit", (code) => {
    exitCode = code;
    ended = true;
    resolve();
  });
});
const processFailure = () =>
  spawnError ??
  new Error(
    "Desktop exited unexpectedly: " +
      (typeof exitCode === "number"
        ? "0x" + (exitCode >>> 0).toString(16)
        : String(exitCode)),
  );
let socket;
try {
  let target;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (ended) throw processFailure();
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/json/list", {
        signal: AbortSignal.timeout(1000),
      });
      target = (await response.json()).find(
        (entry) =>
          entry.type === "page" &&
          /tauri|localhost|index\.html/.test(entry.url),
      );
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      // WebView2 starts asynchronously.
    }
    await delay(100);
  }
  assert.ok(
    target?.webSocketDebuggerUrl,
    "Desktop WebView2 page did not start",
  );
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("CDP connection timed out")),
      5000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("CDP connection failed"));
      },
      { once: true },
    );
  });
  let sequence = 0;
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const finish = (error, value) => {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
        socket.removeEventListener("close", closed);
        if (error) reject(error);
        else resolve(value);
      };
      const receive = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        if (message.error || message.result?.exceptionDetails)
          finish(new Error(JSON.stringify(message)));
        else finish(null, message.result.result.value);
      };
      const closed = () => finish(new Error("Desktop disconnected during IPC"));
      const timer = setTimeout(() => finish(new Error("IPC timed out")), 15000);
      socket.addEventListener("message", receive);
      socket.addEventListener("close", closed);
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (ended) throw processFailure();
    try {
      ready = await evaluate(
        "Boolean(document.readyState === 'complete' && " +
          "document.querySelector('#root') && window.__TAURI_INTERNALS__?.invoke)",
      );
      if (ready) break;
    } catch {
      // Initial navigation can destroy the first execution context.
    }
    await delay(100);
  }
  assert.ok(ready, "Desktop IPC bridge did not become ready");
  const result = await evaluate(
    "window.__TAURI_INTERNALS__.invoke('update_install')" +
      ".then(() => 'unexpected success', e => String(e))",
  ).catch(async (error) => {
    await Promise.race([exited, delay(2000)]);
    throw ended ? processFailure() : error;
  });
  assert.equal(result, "请先确认更新版本");
  await delay(250);
  if (ended) throw processFailure();
  console.log(
    "PASS: real update_install IPC rejects an unprepared update and keeps Desktop alive",
  );
} finally {
  socket?.close();
  if (!ended) child.kill();
  await Promise.race([exited, delay(5000)]);
  // Only remove the profile created by this test, never an existing app profile.
  if (
    path
      .resolve(profile)
      .toLowerCase()
      .startsWith(root.toLowerCase() + path.sep)
  ) {
    await fs
      .rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      })
      .catch((error) => console.warn("Test profile cleanup:", error.message));
  } else {
    console.error("Unexpected test profile path; preserved for inspection");
    process.exitCode = 1;
  }
}
