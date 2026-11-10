// Exercise real Windows WebView2 -> Tauri command dispatch. The unprepared
// request catches stack exhaustion while IPC constructs the update future.
// Optional isolated fixtures cover native window routing, controls and NSIS handoff.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32")
  throw new Error("Windows-only IPC smoke test");
const handoff = process.argv[2] === "--isolated-handoff";
const isolated = handoff || process.argv[2] === "--isolated-window";
const root = path.resolve("src-tauri/target/update-ipc-tests");
await fs.mkdir(root, { recursive: true });
const fixture = isolated ? await prepareIsolatedWindow(handoff) : undefined;
const executable =
  fixture?.executable ??
  path.resolve(
    process.argv[2] ??
      "src-tauri/target/x86_64-pc-windows-msvc/release/desktop.exe",
  );
await fs.access(executable);
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
    ...fixture?.environment,
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
  async function connectPage(matches, afterHandoff = false) {
    let target;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (ended && !afterHandoff) throw processFailure();
      try {
        const response = await fetch(
          "http://127.0.0.1:" + port + "/json/list",
          {
            signal: AbortSignal.timeout(1000),
          },
        );
        target = (await response.json()).find(
          (entry) => entry.type === "page" && matches(entry.url),
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
    const connection = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CDP connection timed out")),
        5000,
      );
      connection.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      connection.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP connection failed"));
        },
        { once: true },
      );
    });
    return connection;
  }
  const desktopPage = (url) =>
    (fixture ? url.startsWith(`${fixture.origin}/`) : /tauri|localhost|index\.html/.test(url)) &&
    !url.includes("diagnostics=1");
  socket = await connectPage(desktopPage);
  let sequence = 0;
  const evaluateOn = (connection, expression) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const finish = (error, value) => {
        clearTimeout(timer);
        connection.removeEventListener("message", receive);
        connection.removeEventListener("close", closed);
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
      connection.addEventListener("message", receive);
      connection.addEventListener("close", closed);
      connection.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  const evaluate = (expression) => evaluateOn(socket, expression);
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
  const invoke = (command) =>
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, { label: 'main' })`;
  const click = (name) =>
    `document.querySelector('[data-testid="window-control-${name}"]').click()`;
  const dialog = `document.querySelector('[role="dialog"][aria-label="关闭确认"]')`;
  const clickDialog = (name) =>
    `[...${dialog}.querySelectorAll('button')].find(b => b.textContent.trim() === '${name}').click()`;
  if (handoff) {
    await waitFor("signed fixture update", () =>
      evaluate(
        "window.__TAURI_INTERNALS__.invoke('update_status').then(s => s.installed && s.phase === 'ready')",
      ),
    );
    await waitFor("native update entry", () =>
      evaluate(
        `Boolean(document.querySelector('button[aria-label="更新 Desktop"]'))`,
      ),
    );
    await evaluate(
      `document.querySelector('button[aria-label="更新 Desktop"]').click()`,
    );
    await evaluate(`
      [...document.querySelector('[role="dialog"][aria-label="Desktop 更新"]').querySelectorAll('button')]
        .find(button => button.textContent.trim() === '重启更新').click()
    `);
    await Promise.race([exited, delay(15000)]);
    assert.ok(ended, "The update UI did not hand off and exit");
    assert.equal(exitCode, 0);
    await fixture.verifyHandoff();
    socket.close();
    socket = await connectPage(desktopPage, true);
    await waitFor("restarted Desktop workspace", () =>
      evaluate(
        "Boolean(document.querySelector('[data-testid=\"desktop-window-controls\"]'))",
      ),
    );
    await evaluate(click("close"));
    await waitFor("restarted Desktop close confirmation", () =>
      evaluate(`Boolean(${dialog})`),
    );
    const disconnected = new Promise((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    await evaluate(clickDialog("退出"));
    assert.equal(
      await Promise.race([disconnected.then(() => true), delay(15000, false)]),
      true,
      "Restarted fixture did not exit",
    );
    await fixture.uninstall();
    console.log(
      "PASS: signed update confirmed in Desktop, old process exited, NSIS replaced the app, and restarted Desktop loaded the workspace",
    );
  } else if (fixture) {
    const maximized = (expected) =>
      `(${invoke("plugin:window|is_maximized")}).then(value =>
        value === ${JSON.stringify(expected)} &&
        document.querySelector('[data-testid="window-control-maximize"]').dataset.maximized === String(value))`;
    await waitFor("isolated update preferences", () =>
      evaluate(
        "window.__TAURI_INTERNALS__.invoke('update_status').then(s => !s.installed && !s.preferences.autoCheck)",
      ),
    );
    await waitFor("Workbench window controls", () =>
      evaluate(
        "Boolean(document.querySelector('[data-testid=\"desktop-window-controls\"]'))",
      ),
    );
    await evaluate(invoke("plugin:window|show"));
    const diagnosticsMenuItem =
      `[...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === '打开诊断')`;
    await evaluate(`document.querySelector('[data-testid="help-menu-button"]').click()`);
    await waitFor("diagnostics menu entry", () => evaluate(`Boolean(${diagnosticsMenuItem})`));
    await evaluate(`${diagnosticsMenuItem}.click()`);
    const diagnosticSocket = await connectPage((url) => url.includes("diagnostics=1"));
    try {
      await waitFor("standalone Diagnostics window", () =>
        evaluateOn(diagnosticSocket, `
          document.querySelector('h1')?.textContent === 'AAW Desktop 诊断' &&
          Boolean(document.querySelector('[aria-label="诊断视图"]')) &&
          !document.querySelector('[data-testid="desktop-window-controls"]')
        `),
      );
      console.log("PASS: Workbench opens the standalone native Diagnostics window");
    } finally {
      diagnosticSocket.close();
    }
    const [target, other] = fixture.removalProjects;
    const projectRow = (project) =>
      `[...document.querySelectorAll('[aria-label="项目树"] button[title]')].find(row => row.title === ${JSON.stringify(project)})`;
    const removalDialog = `document.querySelector('[role="dialog"][aria-label="确认移除项目"]')`;
    const openRemoval = async () => {
      await waitFor("previous project menu dismissed", () =>
        evaluate(`!document.querySelector('[role="menu"][aria-label="项目菜单"]')`),
      );
      await evaluate(`${projectRow(target)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
      const item = `[...document.querySelectorAll('[role="menuitem"]')].find(entry => entry.textContent.trim() === '从列表移除')`;
      await waitFor("project removal menu entry", () => evaluate(`Boolean(${item})`));
      await evaluate(`${item}.click()`);
      await waitFor("project removal confirmation", () => evaluate(`Boolean(${removalDialog})`));
    };
    const chooseRemoval = (label) => evaluate(
      `[...${removalDialog}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`,
    );
    await waitFor("fixture projects", () => evaluate(`Boolean(${projectRow(target)} && ${projectRow(other)})`));
    await openRemoval();
    await chooseRemoval("取消");
    await waitFor("cancelled project removal", () => evaluate(`!${removalDialog} && Boolean(${projectRow(target)})`));
    await openRemoval();
    await chooseRemoval("确认移除");
    await waitFor("confirmed project removal", () => evaluate(
      `!(${projectRow(target)}) && Boolean(${projectRow(other)}) &&
        JSON.parse(localStorage.getItem('aaw-desktop/workspace/v1')).recent.every(entry => entry.path !== ${JSON.stringify(target)})`,
    ));
    console.log("PASS: native project removal confirms, persists and preserves the other project");
    for (const expected of [true, false]) {
      await evaluate(click("maximize"));
      await waitFor(`native maximized state ${expected}`, () =>
        evaluate(maximized(expected)),
      );
    }
    await evaluate(click("minimize"));
    await waitFor("native minimized state", () =>
      evaluate(invoke("plugin:window|is_minimized")),
    );
    await evaluate(invoke("plugin:window|unminimize"));
    await waitFor("native restored state", () =>
      evaluate(
        `(${invoke("plugin:window|is_minimized")}).then(value => !value)`,
      ),
    );
    await evaluate(click("close"));
    await waitFor("native close confirmation", () =>
      evaluate(`Boolean(${dialog})`),
    );
    await evaluate(clickDialog("取消"));
    await waitFor("dismissed close confirmation", () => evaluate(`!${dialog}`));
    assert.equal(ended, false);
    await evaluate(click("close"));
    await waitFor("second native close confirmation", () =>
      evaluate(`Boolean(${dialog})`),
    );
    await evaluate(clickDialog("退出"));
    await Promise.race([exited, delay(15000)]);
    assert.ok(ended, "Confirmed close did not exit the isolated Desktop");
    assert.equal(exitCode, 0);
    console.log(
      "PASS: real Workbench maximize, restore, minimize, cancel close and confirmed close",
    );
  }
} finally {
  socket?.close();
  if (!ended) child.kill();
  await Promise.race([exited, delay(5000)]);
  // Only remove the profile created by this test, never an existing app profile.
  if (
    path
      .normalize(await fs.realpath(profile))
      .toLowerCase()
      .startsWith((await fs.realpath(root)).toLowerCase() + path.sep)
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
  await fixture?.dispose();
}

async function waitFor(label, read) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function prepareIsolatedWindow(handoff) {
  const identifier = `com.aaw.cordis-smoke.${randomUUID()}`;
  assert.ok(process.env.LOCALAPPDATA, "LOCALAPPDATA is required");
  const dataRoot = await fs.realpath(process.env.LOCALAPPDATA);
  const dataDirectory = path.join(dataRoot, identifier);
  const identity = {
    id: "cordis-smoke",
    name: "Cordis smoke",
    employeeId: "test",
    email: null,
    department: null,
    source: "dev",
    loggedInAt: new Date().toISOString(),
  };
  const account = JSON.stringify({ version: 1, user: identity });
  const peer = path.join(dataDirectory, "acp-peer.mjs");
  const removalProjects = ["remove-project", "keep-project"].map((name) => path.join(dataDirectory, name));
  const agent = {
    id: "custom-native-smoke",
    name: "Native smoke ACP peer",
    command: [process.execPath, peer],
  };
  const preferences = JSON.stringify({ agents: [agent], activeAgentId: agent.id });
  const workspaces = JSON.stringify({
    version: 1,
    recent: removalProjects.map((path) => ({ path, lastOpenedAt: new Date().toISOString() })),
  });
  const seed = `<script>
    localStorage.setItem("aaw-desktop.auth.v1", ${JSON.stringify(account)});
    localStorage.setItem("aaw-desktop.settings.v1", ${JSON.stringify(preferences)});
    ${handoff ? "" : `if (!location.search) localStorage.setItem("aaw-desktop/workspace/v1", ${JSON.stringify(workspaces)});`}
  </script>`;
  const server = http.createServer(async (request, response) => {
    try {
      const incoming = new URL(request.url, "http://fixture");
      const url = new URL("http://localhost:1420");
      url.pathname = incoming.pathname;
      url.search = incoming.search;
      const upstream = await fetch(url, { redirect: "error" });
      const type = upstream.headers.get("content-type");
      if (type) response.setHeader("content-type", type);
      response.statusCode = upstream.status;
      if (type?.includes("text/html")) {
        response.end(
          (await upstream.text()).replace("<head>", `<head>${seed}`),
        );
      } else {
        response.end(Buffer.from(await upstream.arrayBuffer()));
      }
    } catch {
      response.writeHead(502).end();
    }
  });
  let ownsData = false;
  let installedFixture;
  const dispose = async () => {
    server.close();
    server.closeAllConnections();
    if (installedFixture && !installedFixture.uninstalled) {
      console.warn(`Preserved isolated update logs in ${dataDirectory}`);
      return;
    }
    if (ownsData) {
      const actual = await fs.realpath(dataDirectory);
      const relative = path.relative(dataRoot, actual).toLowerCase();
      // A packaged runner can redirect LocalAppData to its MSIX LocalCache.
      const parts = relative.split(path.sep);
      const redirected =
        parts.length === 5 &&
        parts[0] === "packages" &&
        parts[2] === "localcache" &&
        parts[3] === "local" &&
        parts[4] === identifier;
      assert.ok(
        relative === identifier || redirected,
        `Unexpected fixture path: ${actual}`,
      );
      await fs.rm(actual, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  };
  try {
    assert.ok(
      (
        await fetch("http://localhost:1420", {
          signal: AbortSignal.timeout(3000),
        })
      ).ok,
      "Start the Desktop development server on port 1420 first",
    );
    await fs.mkdir(dataDirectory);
    ownsData = true;
    if (!handoff) await Promise.all(removalProjects.map((path) => fs.mkdir(path)));
    // Keep startup and exit independent of Agents installed on the test machine.
    await fs.writeFile(peer, `
      import { createInterface } from "node:readline";
      const requests = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of requests) {
        const { id, method } = JSON.parse(line);
        if (id === undefined) continue;
        const response = method === "initialize"
          ? { result: { protocolVersion: 1, agentInfo: { name: "native-smoke", version: "1" }, agentCapabilities: {} } }
          : { error: { code: -32601, message: "Method not found" } };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...response }) + "\\n");
      }
    `);
    const updates = path.join(dataDirectory, "updates");
    await fs.mkdir(updates);
    await fs.writeFile(
      path.join(updates, "preferences.json"),
      JSON.stringify({
        autoCheck: false,
        autoDownload: false,
        acceleration: false,
        contribute: false,
      }),
    );
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const config = JSON.parse(
      await fs.readFile("src-tauri/tauri.conf.json", "utf8"),
    );
    const override = {
      identifier,
      productName: `AAW Cordis Smoke ${identifier.split(".").at(-1)}`,
      build: { devUrl: `http://127.0.0.1:${server.address().port}` },
      app: {
        windows: [
          {
            ...config.app.windows[0],
            title: "AAW Cordis native smoke",
            visible: false,
            focus: false,
          },
        ],
      },
    };
    const keys = handoff ? generateKeyPairSync("ed25519") : undefined;
    await run(
      "cargo",
      [
        "rustc",
        "--offline",
        "--example",
        "cordis_native_smoke",
        "-j",
        "2",
        "--",
        "-C",
        "link-arg=/MANIFEST:EMBED",
        "-C",
        "link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'",
      ],
      {
        cwd: path.resolve("src-tauri"),
        env: {
          ...process.env,
          CARGO_TARGET_DIR: path.resolve("src-tauri/target"),
          TAURI_CONFIG: JSON.stringify(override),
          ...(keys && {
            AAW_DESKTOP_UPDATE_PUBLIC_KEY: keys.publicKey
              .export({ type: "spki", format: "der" })
              .subarray(-32)
              .toString("base64"),
          }),
        },
      },
    );
    const environment = { AAW_CORDIS_SMOKE_IDENTIFIER: identifier };
    const executable = path.resolve(
      "src-tauri/target/debug/examples/cordis_native_smoke.exe",
    );
    if (keys)
      installedFixture = await prepareInstalledUpdate(
        executable,
        override,
        updates,
        keys.privateKey,
      );
    return {
      origin: override.build.devUrl,
      executable,
      environment,
      removalProjects,
      dispose,
      ...installedFixture,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function run(program, args, options) {
  await new Promise((resolve, reject) => {
    const process = spawn(program, args, {
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    process.once("error", reject);
    process.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${program} exited with ${code}`)),
    );
  });
}

async function prepareInstalledUpdate(binary, config, updates, privateKey) {
  const version = "9000.0.0";
  const directory = await fs.mkdtemp(
    path.join(await fs.realpath(root), "handoff-"),
  );
  const destination = path.join(directory, "Installed AAW fixture");
  const debug = path.join(directory, "debug");
  await fs.mkdir(debug);
  await fs.copyFile(binary, path.join(debug, "desktop.exe"));
  await run(
    process.execPath,
    [
      "node_modules/@tauri-apps/cli/tauri.js",
      "bundle",
      "--debug",
      "--bundles",
      "nsis",
      "--ci",
      "--no-sign",
      "--no-binary-patching",
      "--config",
      JSON.stringify({ ...config, version }),
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: directory } },
  );
  const bundles = path.join(debug, "bundle", "nsis");
  const installers = (await fs.readdir(bundles)).filter(
    (name) => name.endsWith("-setup.exe") || name.endsWith("_setup.exe"),
  );
  assert.equal(installers.length, 1);
  const installer = path.join(bundles, installers[0]);
  await run(installer, ["/S", "/NS", `/D=${destination}`], {
    windowsVerbatimArguments: true,
  });
  const executable = path.join(destination, "desktop.exe");
  const installedHash = createHash("sha256")
    .update(await fs.readFile(executable))
    .digest("hex");
  // Distinguish the old executable from the package without compiling the app twice.
  await fs.appendFile(
    executable,
    "\nAAW Cordis installed predecessor fixture\n",
  );
  const marker = path.join(destination, "preserve.txt");
  await fs.writeFile(marker, "preserve installed data");
  const bytes = await fs.readFile(installer);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.copyFile(installer, path.join(updates, `${sha256}.exe`));
  const payload = Buffer.from(
    JSON.stringify({
      schema: 1,
      version,
      platform: "windows-x86_64",
      kind: "nsis",
      file_name: `AAW-Desktop-${version}-windows-x64-setup.exe`,
      size: bytes.length,
      sha256,
    }),
  );
  await fs.writeFile(
    path.join(updates, "ready.json"),
    JSON.stringify({
      payload: payload.toString("base64"),
      signature: sign(null, payload, privateKey).toString("base64"),
    }),
  );
  const state = {
    executable,
    uninstalled: false,
    async verifyHandoff() {
      const logFile = path.join(updates, "last-install.log");
      let log = "";
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        log = await fs.readFile(logFile, "utf8").catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        assert.ok(!log.includes("FAILED:"), log);
        if (log.includes("is accepting input.")) break;
        await delay(250);
      }
      assert.match(
        log,
        /waiting for Desktop to exit\.[\s\S]*Starting verified installer\.[\s\S]*Installer exit code: 0[\s\S]*is accepting input\./,
      );
      assert.equal(
        createHash("sha256")
          .update(await fs.readFile(executable))
          .digest("hex"),
        installedHash,
      );
      assert.equal(
        await fs.readFile(marker, "utf8"),
        "preserve installed data",
      );
    },
    async uninstall() {
      await run(path.join(destination, "uninstall.exe"), ["/S", "/UPDATE"]);
      const parent = await fs.realpath(root);
      const actual = await fs.realpath(directory);
      assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
      assert.ok(path.basename(actual).startsWith("handoff-"));
      await fs.rm(actual, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      state.uninstalled = true;
    },
  };
  return state;
}
