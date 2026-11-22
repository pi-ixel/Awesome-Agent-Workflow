/**
 * 把复测用工作流（workflow-engine-rs/testdata/aaw-flowtest）装进测试实例的「我的工作流」。
 *
 *   node scripts/flowtest-install.mjs [--identifier com.aaw.desktop.flowtest]
 *
 * 只装进测试实例的应用数据目录；拒绝装进正式应用（com.aaw.desktop）。已装过的整体替换。
 * 脚本内容变了时，要在工作流详情里重新点「我已查看，信任这些脚本」。
 * 复测步骤见 docs/workflow/flowtest.md。
 */
import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const at = args.indexOf("--identifier");
const identifier = at >= 0 ? args[at + 1] : "com.aaw.desktop.flowtest";
if (!identifier || identifier === "com.aaw.desktop") {
  console.error("只能装进测试实例（例如 com.aaw.desktop.flowtest），不能装进正式应用的数据目录。");
  process.exit(1);
}
const appData = process.env.APPDATA;
if (!appData) {
  console.error("找不到 APPDATA。");
  process.exit(1);
}
const source = join(dirname(fileURLToPath(import.meta.url)), "..", "workflow-engine-rs", "testdata", "aaw-flowtest");
const target = join(appData, identifier, "workflow-engine", "workflows", "aaw-flowtest");
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`已安装：${target}`);
