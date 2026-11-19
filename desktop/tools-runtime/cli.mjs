import { getCatalog, describeTool } from "./catalog.mjs";
import { executeAction } from "./runtime.mjs";
import { readFile, stat } from "node:fs/promises";

async function readInput(filename) {
  if (!filename) throw new Error("请通过标准输入或 --input-file=<文件路径> 提供 JSON。");
  const info = await stat(filename);
  if (!info.isFile() || info.size > 512 * 1024) throw new Error("JSON 输入必须是 512 KB 以内的文件。");
  const bytes = await readFile(filename);
  if (bytes.length > 512 * 1024) throw new Error("JSON 输入不能超过 512 KB。");
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
}

export async function runCli(root, isolated, args) {
  const [command, id, action, file] = args;
  if (!command || command === "--help" || command === "help") {
    return { commands: ["list", "describe <tool-id>", "run <tool-id> <action-id> --input-file=<path>"], input: "npm run tools 也支持从标准输入读取 JSON" };
  }
  if (!(command === "list" && args.length === 1 ||
    command === "describe" && args.length === 2 ||
    command === "run" && (args.length === 3 || args.length === 4 && file.startsWith("--input-file=")))) throw new Error("命令参数无效。请运行 help。");
  const { signedIn, tools } = getCatalog(root);
  if (!signedIn) throw new Error("请在 AAW Desktop 登录后再使用个人工具。");
  if (command === "list") return tools.map(({ tool }) => describeTool(tool));
  const entry = tools.find((entry) => entry.tool.id === id);
  const tool = entry?.tool;
  if (!tool) throw new Error("未找到已安装的工具。");
  if (command === "describe") return describeTool(tool);
  if (!tool.actions?.some((entry) => entry.id === action)) throw new Error("工具未声明该动作。");
  return executeAction(isolated, tool, action, await readInput(file?.slice(13)), entry.settings, entry.dir);
}
