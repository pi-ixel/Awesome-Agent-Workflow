/**
 * 从 OpsCopilot GitHub Release 下载并校验 ops-sidecar 二进制到
 * desktop/ops-sidecar/dist/ops-sidecar(.exe)。
 *
 * - 版本与期望 SHA256 锁定在 desktop/ops-sidecar/version.json；
 * - 若目标文件已存在且 SHA256 与 version.json 匹配，直接跳过下载（幂等、离线友好）；
 * - 本地开发如需从本机 OpsCopilot 源码编译，请使用 `npm run ops:build`。
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(root, "ops-sidecar", "version.json");
const distDir = join(root, "ops-sidecar", "dist");

const platformKey = `${process.platform}-${process.arch}`;
const exeName = process.platform === "win32" ? "ops-sidecar.exe" : "ops-sidecar";
const targetPath = join(distDir, exeName);
const force = process.argv.includes("--force");

async function sha256OfFile(filePath) {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex").toLowerCase();
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const asset = manifest.assets?.[platformKey];
if (!asset?.file || !asset?.sha256) {
  throw new Error(
    `ops-sidecar/version.json 未配置平台 ${platformKey} 的 Release 产物。`,
  );
}
const expectedSha = String(asset.sha256).trim().toLowerCase();

if (!force) {
  try {
    await stat(targetPath);
    const existingSha = await sha256OfFile(targetPath);
    if (existingSha === expectedSha) {
      console.log(
        `ops-sidecar 已就绪且 SHA256 匹配（${manifest.tag}，${platformKey}），跳过下载。`,
      );
      process.exit(0);
    }
  } catch {
    // 文件不存在，继续下载
  }
}

const downloadUrl = `https://github.com/${manifest.repo}/releases/download/${encodeURIComponent(manifest.tag)}/${encodeURIComponent(asset.file)}`;
console.log(`正在下载 ops-sidecar（${manifest.tag} / ${platformKey}）：${downloadUrl}`);

const headers = {
  "User-Agent": "aaw-desktop-build",
  Accept: "application/octet-stream",
};
const token = process.env.OPSCOPILOT_TOKEN || process.env.GITHUB_TOKEN;
if (token) {
  headers.Authorization = `Bearer ${token}`;
}

const response = await fetch(downloadUrl, { headers, redirect: "follow" });
if (!response.ok) {
  throw new Error(
    `下载 ops-sidecar 失败：HTTP ${response.status} ${response.statusText} (${downloadUrl})`,
  );
}

const bytes = Buffer.from(await response.arrayBuffer());
const actualSha = createHash("sha256").update(bytes).digest("hex").toLowerCase();
if (actualSha !== expectedSha) {
  throw new Error(
    `ops-sidecar SHA256 校验失败：期望 ${expectedSha}，实际 ${actualSha}`,
  );
}

await mkdir(distDir, { recursive: true });
const tmpPath = `${targetPath}.download`;
await writeFile(tmpPath, bytes);
if (process.platform !== "win32") {
  await chmod(tmpPath, 0o755);
}
await rename(tmpPath, targetPath);

const sizeMb = (bytes.length / 1024 / 1024).toFixed(1);
console.log(
  `ops-sidecar 已下载并校验通过（${sizeMb} MB，${manifest.tag}）→ ${targetPath}`,
);
