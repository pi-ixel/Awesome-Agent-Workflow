/**
 * 构建并暂存 Rust 工作流服务（workflow-engine-rs 的 sidecar）。
 *
 * - 默认 release（`npm run workflow:build`，tauri build 的 beforeBuildCommand）；
 * - `--debug` 走 debug profile（`npm run workflow:build:debug`，dev 迭代快）；
 * - 产物统一暂存到 workflow-engine-rs/dist/workflow_service(.exe)——tauri
 *   bundle 的 resources 指向这个稳定路径，target/ 目录不直接进包。
 *   定义、知识文件和独立的问题池 MCP 与可执行文件一同暂存。
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const crate = join(root, "workflow-engine-rs");
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(crate, "target");
const debug = process.argv.includes("--debug");
const exeName = process.platform === "win32" ? "workflow_service.exe" : "workflow_service";

const profile = debug ? "debug" : "release";
if (!["win32", "linux"].includes(process.platform)) throw new Error(`当前平台尚未提供 question-tracker 可执行文件：${process.platform}`);
const built = spawnSync("cargo", ["build", `--profile=${profile === "debug" ? "dev" : "release"}`, "--manifest-path", join(crate, "Cargo.toml"), "--bin", "workflow_service"], {
  stdio: "inherit",
});
if (built.error) throw built.error;
if (built.status !== 0) throw new Error(`cargo build 失败（exit ${built.status}）`);

const source = join(targetDir, profile, exeName);
await stat(source);
const stagedDir = join(crate, "dist");
await mkdir(stagedDir, { recursive: true });
await copyFile(source, join(stagedDir, exeName));
// The question tracker remains a separate MCP executable owned by the run.
const trackerSource = join(root, "..", "skills", "question-tracker-mcp", "bin", process.platform === "win32" ? "windows" : "linux", process.platform === "win32" ? "mcp_server.exe" : "mcp_server");
const trackerName = process.platform === "win32" ? "question-tracker.exe" : "question-tracker";
async function copyTrackerIfChanged(destination) {
  const digest = (content) => createHash("sha256").update(content).digest("hex");
  const sourceHash = digest(await readFile(trackerSource));
  const currentHash = await readFile(destination).then(digest).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (currentHash !== sourceHash) await copyFile(trackerSource, destination);
}
await copyTrackerIfChanged(join(stagedDir, trackerName));
await copyTrackerIfChanged(join(targetDir, profile, trackerName));
for (const target of [stagedDir, join(targetDir, profile)]) {
  await copyFile(join(crate, "definitions", "aaw-dev.json"), join(target, "aaw-dev.json"));
  await copyFile(join(crate, "definitions", "aaw-enterprise.json"), join(target, "aaw-enterprise.json"));
  const knowledgeTarget = join(target, "knowledge");
  await mkdir(knowledgeTarget, { recursive: true });
  const knowledgeSource = join(root, "workflow-engine-rs", "knowledge");
  for (const file of await readdir(knowledgeSource)) {
    if (file.endsWith(".md")) await copyFile(join(knowledgeSource, file), join(knowledgeTarget, file));
  }
}
const sizeMb = ((await stat(join(stagedDir, exeName))).size / 1024 / 1024).toFixed(1);
console.log(`workflow_service 已暂存到 dist/（${sizeMb} MB，${profile}）`);
