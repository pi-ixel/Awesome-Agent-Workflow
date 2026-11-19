/**
 * 重新生成仓库里的 `skills/tool-dev/SKILL.md`。
 *
 * 手册唯一真源在 `src/plugins/tools/runtime/guide.ts`（工具项目里的
 * `AGENTS.md`、指导窗口、技能目录三处共用）。运行时 `workshop.ts` 会把
 * `toolGuideSkill()` 写进用户的技能目录，但仓库里给人看 / 给技能安装器
 * 用的那份副本不会自动更新——改了 guide.ts 之后跑一次本脚本同步它。
 *
 * 用法：npm run tools:guide-skill
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const staged = join(desktop, "tools-runtime", "dist");
mkdirSync(staged, { recursive: true });
const entry = join(staged, "skill-entry.mjs");
await build({
  entryPoints: [join(desktop, "src", "plugins", "tools", "runtime", "guideEntry.ts")],
  outfile: entry,
  bundle: true,
  format: "esm",
});
const { markdown } = await import(pathToFileURL(entry).href);
// toolGuideSkill 不进 guideEntry（构建期只需要 markdown），这里单独 bundle。
const skillEntry = join(staged, "skill-only.mjs");
await build({
  entryPoints: [join(desktop, "src", "plugins", "tools", "runtime", "guide.ts")],
  outfile: skillEntry,
  bundle: true,
  format: "esm",
});
const guide = await import(pathToFileURL(skillEntry).href);
const skillMd = guide.toolGuideSkill();
const target = join(dirname(desktop), "skills", "tool-dev", "SKILL.md");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, skillMd);
writeFileSync(join(staged, "guide.md"), markdown);
console.log(`skill manual written: ${target} (${skillMd.length} chars)`);
