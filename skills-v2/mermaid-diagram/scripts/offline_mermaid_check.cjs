"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function denyNetwork() {
  const blocked = () => {
    throw new Error("network access is disabled by mermaid-diagram");
  };
  globalThis.fetch = blocked;
  globalThis.XMLHttpRequest = class {
    constructor() { blocked(); }
  };
  globalThis.WebSocket = class {
    constructor() { blocked(); }
  };
  globalThis.EventSource = class {
    constructor() { blocked(); }
  };
  if (!globalThis.navigator) globalThis.navigator = {};
  globalThis.navigator.sendBeacon = blocked;
  for (const name of ["http", "https"]) {
    const module = require(name);
    module.get = blocked;
    module.request = blocked;
  }
  const net = require("net");
  net.connect = blocked;
  net.createConnection = blocked;
  require("tls").connect = blocked;
  require("dgram").createSocket = blocked;
  require("http2").connect = blocked;
  const dns = require("dns");
  dns.lookup = blocked;
  dns.resolve = blocked;
  dns.resolve4 = blocked;
  dns.resolve6 = blocked;
  if (dns.promises) {
    dns.promises.lookup = blocked;
    dns.promises.resolve = blocked;
  }
  const childProcess = require("child_process");
  childProcess.exec = blocked;
  childProcess.execFile = blocked;
  childProcess.fork = blocked;
  childProcess.spawn = blocked;
  const workerThreads = require("worker_threads");
  workerThreads.Worker = class {
    constructor() { blocked(); }
  };
}

async function main() {
  denyNetwork();
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!payload || !Array.isArray(payload.diagrams)) {
    throw new Error("invalid validator input");
  }

  globalThis.window = globalThis;
  const bundle = path.resolve(__dirname, "..", "vendor", "mermaid", "mermaid.min.js");
  const originalBundle = fs.readFileSync(bundle, "utf8");
  const bundleSource = originalBundle.replace(
    "ao=wZ()});",
    "ao=wZ(),ao.addHook||(ao.addHook=()=>{},ao.sanitize=e=>e)});",
  );
  if (bundleSource === originalBundle) throw new Error("unsupported bundled Mermaid version");
  vm.runInThisContext(bundleSource, { filename: bundle });

  const results = [];
  for (const source of payload.diagrams) {
    try {
      if (typeof source !== "string") throw new Error("diagram source must be text");
      await mermaid.parse(source, { suppressErrors: false });
      results.push({ ok: true });
    } catch (error) {
      results.push({ ok: false, error: String(error && error.message ? error.message : error) });
    }
  }
  process.stdout.write(JSON.stringify({ results }));
  process.exitCode = results.some((item) => !item.ok) ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exitCode = 2;
});
