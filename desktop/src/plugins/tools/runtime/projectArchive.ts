import { strToU8, unzipSync, zipSync } from "fflate";
import type { ToolPackage } from "../types.ts";
import { parseToolPackage, toolPackageLimit, validateToolPackageText } from "./package.ts";
import { isRuntimeBinPath, safeSourcePath } from "./sourceFiles.ts";
import { toolLimits } from "./limits.ts";

/**
 * 源码 ZIP 的上限。
 *
 * 从 1 MB / 72 个条目放宽到 32 MB / 4000 个条目：工具开始能自带 `node_modules`
 * 之后，一个带 `ssh2` 的包大约是 90 个文件、2 MB；带前端构建产物的包通常是
 * 几十到几百个文件。再往上（几百 MB）就不该用"发个 ZIP"这种方式分发了。
 */
export const toolArchiveLimit = toolLimits.archiveBytes;
export const toolArchiveEntries = 4000;

/** 压缩包里与工具无关的系统垃圾：macOS 的 `__MACOSX/`、`.DS_Store`、`Thumbs.db`。 */
function isArchiveNoise(path: string): boolean {
  return path.startsWith("__MACOSX/")
    || path.includes("/__MACOSX/")
    || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(path);
}

/**
 * 是不是依赖目录里的文件。
 *
 * 这些文件**只落盘、不进清单**（`sourceFiles`）。原因有两条，都很实际：
 *
 * 1. **体积与数量。** 清单存在 `preferences.json` 里，而 `sourceFiles` 限 512 个
 *    文件 / 4 MB。一棵正常依赖树轻松几百个 `.js`（`ssh2` 约 90 个，带前端构建
 *    产物的包上千个），把它们塞进清单会直接撑爆上限——表现是**导入失败**，而且
 *    报错指向 `sourceFiles`，作者完全看不出这是自己的依赖树造成的。
 * 2. **语义。** `sourceFiles` 的用途是"作者的源码，AI 编辑与导出时要读得到"。
 *    依赖不是作者写的，把它灌进清单既没用，也让每台机器每次唤起启动器都要
 *    多读几 MB。
 *
 * 依赖照样随包导入导出——它们走 `ToolArchive.files`（原始字节）直接写进工具
 * 目录，运行时从磁盘 `require`，和清单无关。
 */
function isDependencyPath(path: string): boolean {
  return path === "node_modules" || path.startsWith("node_modules/");
}

/**
 * 导出的源码项目里除了工具本体，还要有"怎么改、怎么装回去"。
 *
 * 早先这里生成 `package.json` + `scripts/build.mjs`，要求接收方装 Node 再
 * `npm run build`——同事拿到 ZIP 第一步就卡住，而产物其实只是把两个文件
 * 打个包。现在直接写清：改完在工具中心点「导入工具」选中这个 ZIP 即可。
 * 不提「拖回」：拖拽导入从来没被支持过，写了只会让人照做然后发现没反应。
 */
export function toolProjectFiles(tool: ToolPackage): Record<string, string> {
  const { html, sourceFiles, ...manifest } = tool;
  const author = tool.author ? `作者：${tool.author}\n` : "";
  const source = tool.source ? `来源：${tool.source}\n` : "";
  const scaffolding = {
    "README.md": `# ${tool.name}

${author}${source}
这是 AAW 工具的源码。单文件工具不需要任何构建；要带依赖的话见下面「带依赖的工具」。

- \`manifest.json\`：工具身份、AI 动作、设置声明、能力声明
- \`index.html\`：界面入口
- \`app.js\`：可选，L2 的构建产物（清单里用 \`"build": { "out": "app.js" }\` 声明）
- \`src/\`：可选，你的源码。平台不读它，带不带由你决定
- \`bin/\`：可选，L3 的运行时（清单里用 \`"runtime": { "kind": "process", … }\` 声明）

把目录交给 AI 继续改时，先让它读 \`manifest.json\` 与 \`index.html\`。

## 带依赖的工具

**优先用 L2：把纯 JS 依赖打进一个 app.js。**

1. 在工具目录里 \`npm install <包名>\`。
2. 源码写在 \`src/main.js\`，然后打一次包：

   \`\`\`bash
   npx esbuild src/main.js --bundle --format=esm --minify --outfile=app.js
   \`\`\`

3. \`manifest.json\` 里写 \`"build": { "entry": "src/main.js", "out": "app.js", "command": "npm run bundle" }\`。
4. \`index.html\` 里用 \`<script type="module" src="./app.js"></script>\` 引进去。

运行只认 \`build.out\`。\`src/\` 带不带随你——平台不读它，也不会因此降低任何能力。
SQLite 这类需要原生库的东西，在 L2 里改用 WASM 版（\`sql.js\`）。

## 真的需要进程时（L3）

原生模块（\`.node\`）、SSH / TCP / 数据库直连、要遍历监听整个文件系统、要真正
无窗口的常驻进程——只有这四类才该用 L3。把运行时与它的依赖放进 \`bin/\`：

\`\`\`json
"runtime": { "kind": "process", "entry": "bin/run.exe", "protocol": 1 }
\`\`\`

进程用 NDJSON over stdio 与宿主通信。**这条路会放弃沙箱**：进程拥有你账户下的
文件与网络权限。\`bin/\` 不计入 4 MB 源码限额，但导入时平台会把它的真实体积
单独列出来给用户看。

## 改完怎么装回去

在 AAW 桌面版的「工具中心」点「导入工具」，选中这个 ZIP 即可。
ID 相同的会覆盖更新；界面会在安装后告诉你版本从哪一版变到了哪一版。

## 注意

- 单文件工具仍然推荐把 CSS/JS 写在 \`index.html\` 里；多文件时同目录的
  \`<script src="./app.js">\` 可以正常加载。
- 图片小的话用 data URL；大文件直接放目录里。
- 需要跨重启保留的数据用 \`window.aawStore\`，不要用 \`localStorage\`。
- 会联网的工具要在 \`manifest.json\` 里写 \`"permissions": { "network": true }\`，用户安装时能看到。
`,
  };
  // Windows treats paths case-insensitively. Author files win over generated
  // scaffolding while retaining their exact contents and original path casing.
  const authored = new Set(Object.keys(sourceFiles ?? {}).map((path) => path.toLowerCase()));
  const generated = Object.fromEntries(Object.entries(scaffolding).filter(([path]) => !authored.has(path.toLowerCase())));
  const combined = { ...generated, ...sourceFiles };
  // Optional instructions must not turn an installable package into a ZIP
  // that exceeds the source-count or serialized-size limits on reimport.
  const exportedSources = Object.keys(generated).length > 0
    && !validateToolPackageText(JSON.stringify({ ...manifest, html, sourceFiles: combined })).ok
    ? sourceFiles : combined;
  return {
    ...exportedSources,
    "manifest.json": JSON.stringify(manifest, null, 2),
    "index.html": html,
  };
}

/**
 * 导入结果：清单 + **原始文件字节**。
 *
 * 为什么要带 `files`：工具可以自带 `node_modules`、wasm、字体这些非文本资源，
 * 它们没法塞进清单（清单只能存 UTF-8 文本）。调用方要把这些文件写到工具目录，
 * 运行时再从目录里加载——所以解压这一步必须把字节原样交出去。
 */
export interface ToolArchive {
  readonly tool: ToolPackage;
  /** 相对工具根目录的路径 → 原始字节；含 `manifest.json` 与 `index.html`。 */
  readonly files: Readonly<Record<string, Uint8Array>>;
  /**
   * `bin/` 下所有文件的总字节数。
   *
   * 它**不计入** 4 MB 的源码限额（那是清单的额度），但导入界面必须把它单独
   * 显示出来——"装完才发现 80 MB"是设计稿 §2.5.4 明令要避免的事。
   */
  readonly binBytes: number;
}

export function exportToolProject(tool: ToolPackage, extra: Readonly<Record<string, Uint8Array>> = {}): Uint8Array {
  const text = Object.fromEntries(Object.entries(toolProjectFiles(tool)).map(([name, source]) => [name, strToU8(source)]));
  // 工具目录里的文件（node_modules、图片、wasm…）优先于清单里的同路径文本，
  // 因为磁盘上的那份才是作者实际在用的。
  return zipSync({ ...text, ...extra }, { level: 6 });
}

export function importToolArchive(bytes: Uint8Array): ToolArchive {
  if (bytes.length > toolArchiveLimit) throw new Error(`源码 ZIP 不能超过 ${Math.round(toolArchiveLimit / 1024 / 1024)} MB。`);
  const names = new Set<string>();
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => {
      const path = file.name.replace(/\/$/, "");
      // macOS 压缩会带一层 `__MACOSX/` 资源目录和 `.DS_Store`；以前它们会被
      // 当成"不在项目根目录"的证据，用户只看到一句看不懂的报错。
      if (isArchiveNoise(path)) return false;
      if (!safeSourcePath(path) || names.has(path.toLowerCase())) throw new Error("源码 ZIP 含不安全或重复的文件路径。");
      names.add(path.toLowerCase());
      total += file.originalSize;
      if (names.size > toolArchiveEntries || !Number.isSafeInteger(total) || total > toolArchiveLimit)
        throw new Error(`源码 ZIP 解压后不能超过 ${Math.round(toolArchiveLimit / 1024 / 1024)} MB 或 ${toolArchiveEntries} 个条目。`);
      return !file.name.endsWith("/");
    } });
  } catch (error) {
    throw new Error(error instanceof Error ? `无法读取源码 ZIP：${error.message}` : "无法读取源码 ZIP。", { cause: error });
  }
  // 依赖自身的 manifest.json 是普通资源，不能当作另一个工具的入口清单。
  const manifests = Object.keys(files).filter((path) =>
    (path === "manifest.json" || path.endsWith("/manifest.json"))
    && !path.split("/").includes("node_modules"),
  );
  if (manifests.length !== 1) throw new Error("源码 ZIP 需要唯一的 manifest.json。");
  const prefix = manifests[0]!.slice(0, -"manifest.json".length);
  if (!files[`${prefix}index.html`] || Object.keys(files).some((path) => !path.startsWith(prefix)))
    throw new Error("manifest.json 与 index.html 必须放在同一个项目根目录。");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (path: string) => {
    try { return decoder.decode(files[path]); }
    catch { throw new Error(`${path} 必须是 UTF-8 文本。`); }
  };
  let manifest: unknown;
  try { manifest = JSON.parse(decode(`${prefix}manifest.json`)); } catch (error) {
    if (error instanceof Error && error.message.endsWith("必须是 UTF-8 文本。")) throw error;
    throw new Error("manifest.json 格式无效。", { cause: error });
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("manifest.json 必须是对象。");
  // 文本文件仍然进清单（AI 编辑、导出时都要能读到）；二进制只留在 files 里，
  // 由调用方写到工具目录。用"能否按 UTF-8 严格解码"来分类，不猜扩展名。
  // `node_modules/**` 是例外：它虽然也是文本，但属于依赖而不是作者源码，
  // 一律只落盘（理由见 isDependencyPath）。
  // 构建产物（`build.out`）也**不进清单**：它常常是几百 KB 到几 MB，而清单存在
  // `preferences.json` 里，塞进去等于让每次唤起启动器都读一个大文件。运行只认
  // 磁盘上的那份（协议层从工具目录直接读），所以它只要落盘就够了。
  const declaredOut = (() => {
    const build = manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>).build
      : undefined;
    const out = build && typeof build === "object" && !Array.isArray(build)
      ? (build as Record<string, unknown>).out
      : undefined;
    return typeof out === "string" ? out.replace(/^\.\//, "") : undefined;
  })();
  const text: Record<string, string> = {};
  const relative: Record<string, Uint8Array> = {};
  let binBytes = 0;
  for (const [path, data] of Object.entries(files)) {
    const name = path.slice(prefix.length);
    relative[name] = data;
    if (isRuntimeBinPath(name)) {
      // L3 运行时：只落盘。体积单独统计，导入界面拿它提示真实占用。
      binBytes += data.byteLength;
      continue;
    }
    if (name === "manifest.json" || name === "index.html" || isDependencyPath(name) || name === declaredOut) continue;
    try { text[name] = decoder.decode(data); } catch { /* 二进制：只落盘，不进清单 */ }
  }
  const tool = parseToolPackage(JSON.stringify({
    ...manifest,
    html: decode(`${prefix}index.html`),
    sourceFiles: Object.keys(text).length ? text : undefined,
  }));
  return { tool, files: relative, binBytes };
}

/** 老接口：只要清单、不要文件字节。 */
export function importToolProject(bytes: Uint8Array): ToolPackage {
  return importToolArchive(bytes).tool;
}

/**
 * 读用户选中的文件。
 *
 * 返回 `files` 时表示"这个包带了需要落盘的文件"（ZIP 里除清单与页面之外的
 * 东西），调用方应当先写到工具目录再安装，否则运行时找不到 `node_modules`。
 */
export async function readToolUpload(file: File): Promise<{ readonly tool: ToolPackage; readonly files?: Readonly<Record<string, Uint8Array>>; readonly binBytes?: number }> {
  if (file.name.toLowerCase().endsWith(".zip")) {
    if (file.size > toolArchiveLimit) throw new Error(`源码 ZIP 不能超过 ${Math.round(toolArchiveLimit / 1024 / 1024)} MB。`);
    const archive = importToolArchive(new Uint8Array(await file.arrayBuffer()));
    // 全部文件都交出去（含 manifest.json 与 index.html）：工具目录要能独立成为
    // 一个完整项目，作者装完可以直接在那个目录里继续改。
    return { tool: archive.tool, files: archive.files, binBytes: archive.binBytes };
  }
  if (file.size > toolPackageLimit) throw new Error(`工具包不能超过 ${Math.round(toolPackageLimit / 1024 / 1024)} MB。`);
  return { tool: parseToolPackage(await file.text()) };
}
