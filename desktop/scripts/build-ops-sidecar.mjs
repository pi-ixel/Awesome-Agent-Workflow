/**
 * 构建并暂存运维 sidecar（ops-sidecar，Go，源自 OpsCopilot 仓库）。
 *
 * - `npm run ops:build` / `npm run ops:build:debug`：Go 构建无 profile 区分，
 *   两个入口行为一致（保留与 workflow:build 相同的脚本形态）。
 * - 源码仓库由 OPSCOPILOT_REPO 指定，默认按本机布局
 *   `D:\dev\workspace-go\OpsCopilot`（desktop 仓库上三级的 workspace-go）。
 * - 产物统一暂存到 <desktop>/ops-sidecar/dist/ops-sidecar(.exe)——tauri
 *   bundle 的 resources 指向这个稳定路径；ops_service.rs 的 debug 解析
 *   也从这个目录取用。产物目录进 .gitignore。
 */
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const opsRepo = process.env.OPSCOPILOT_REPO
  ? resolve(process.env.OPSCOPILOT_REPO)
  : resolve(root, "../../../workspace-go/OpsCopilot");
const entryDir = join(opsRepo, "cmd", "ops-sidecar");
const exeName =
  process.platform === "win32" ? "ops-sidecar.exe" : "ops-sidecar";

let entryExists = true;
try {
  await stat(join(entryDir, "main.go"));
} catch {
  entryExists = false;
}
if (!entryExists) {
  throw new Error(
    `未找到 ops-sidecar 入口（${entryDir}）。请设置 OPSCOPILOT_REPO 指向 OpsCopilot 仓库，并确认其包含 cmd/ops-sidecar。`,
  );
}

const built = spawnSync(
  "go",
  [
    "build",
    "-o",
    join(root, "ops-sidecar", "dist", exeName),
    "./cmd/ops-sidecar",
  ],
  {
    stdio: "inherit",
    cwd: opsRepo,
  },
);
if (built.error) throw built.error;
if (built.status !== 0)
  throw new Error(`go build 失败（exit ${built.status}）`);

const staged = join(root, "ops-sidecar", "dist", exeName);
await stat(staged);
const sizeMb = ((await stat(staged)).size / 1024 / 1024).toFixed(1);
console.log(
  `ops-sidecar 已暂存到 ops-sidecar/dist/（${sizeMb} MB，源：${opsRepo}）`,
);
