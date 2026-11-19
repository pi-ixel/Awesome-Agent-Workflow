import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readRecord } from "./catalog.mjs";
// 目录段规则与 src/plugins/tools/runtime/project.ts 共用同一个真源；
// 这份 mjs 是构建期由 package.ts bundle 出来的，不要再本地复制一份。
import { toolOwnerSegment } from "./package-contract.mjs";

/** 单个工具的总存储上限。 */
const toolLimit = 5 * 1024 * 1024;
/** 单个键的上限。 */
const keyLimit = 256 * 1024;
const toolIdPattern = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/**
 * 工具持久化：`window.aawStore` 的落地实现。
 *
 * 落点是 `<AAW 数据目录>/tools/storage/<用户>/<工具 id>.json`，一个工具一个文件、
 * 整文件原子替换。之所以按工具分文件而不是塞进 preferences.json：
 * 工具写坏了只毁自己那一份，且卸载时删文件即可，不会留下孤儿键。
 */
export function createToolStorage(root) {
  const storageRoot = () => readRecord(join(root, "storage-location.json")).active || root;

  function owner() {
    // 以前这里 catch 成 "anonymous"：读不到账号就把数据写进一个用户永远
    // 看不到的目录，登录后读 <账号>/ 全是空的，看起来就像数据凭空消失了。
    // 现在让 toolOwnerSegment 抛明确错误——失败要当场可见，不能静默降级。
    const settings = readRecord(join(storageRoot(), "configuration", "preferences.json"));
    let auth;
    try { auth = JSON.parse(settings["aaw-desktop.auth.v1"] || "null"); }
    catch { throw new Error("账号信息格式无效，请重新登录 AAW。"); }
    return toolOwnerSegment(auth?.user?.id);
  }

  function file(toolId) {
    if (typeof toolId !== "string" || !toolIdPattern.test(toolId)) throw new Error("无效的工具 id。");
    return join(storageRoot(), "tools", "storage", owner(), `${toolId}.json`);
  }

  function read(toolId) {
    // 先算路径再进 try：账号读不到时 file() 抛的错不能被下面"文件坏了就给空对象"
    // 的分支吞掉，否则又是静默降级——用户看到空数据，却不知道该先登录。
    const path = file(toolId);
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      // 文件坏了不该连带工具一起废掉：给空对象，下一次写入自然覆盖。
      if (error instanceof SyntaxError) return {};
      throw error;
    }
  }

  function write(toolId, value) {
    const path = file(toolId);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, path);
  }

  function checkKey(key) {
    if (typeof key !== "string" || !key || key.length > 200 || [...key].some((ch) => ch.charCodeAt(0) < 0x20))
      throw new Error("存储键必须是 1–200 个可见字符。");
    return key;
  }

  return {
    get(toolId, key) {
      const value = read(toolId)[checkKey(key)];
      return value === undefined ? null : value;
    },
    set(toolId, key, value) {
      checkKey(key);
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new Error("存储值必须是可 JSON 序列化的。");
      if (Buffer.byteLength(encoded) > keyLimit) throw new Error("单个存储值不能超过 256 KB。");
      const current = read(toolId);
      const next = { ...current, [key]: value };
      if (Buffer.byteLength(JSON.stringify(next)) > toolLimit) throw new Error("这个工具的存储已满（上限 5 MB），请先清理。");
      write(toolId, next);
      return true;
    },
    delete(toolId, key) {
      const current = read(toolId);
      if (!Object.hasOwn(current, checkKey(key))) return false;
      delete current[key];
      write(toolId, current);
      return true;
    },
    keys(toolId) {
      return Object.keys(read(toolId));
    },
  };
}
