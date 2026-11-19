import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function expandCaseReferences(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(
    /\bTD[-_](\d{2})[-_]([MIBU])(\d{2})(?:(?:\/|,|_|并)(?:TD[-_])?(?:\d{2})?[-_]?([MIBU])(\d{2}))?/gi,
  )) {
    const [, group, prefix, first, secondPrefix, second] = match;
    found.add(`TD-${group}-${prefix}${first}`.toUpperCase());
    if (secondPrefix && second)
      found.add(`TD-${group}-${secondPrefix}${second}`.toUpperCase());
  }
  return [...found];
}

export function auditBrowserCoverage(root: string): {
  designed: number;
  manual: number;
  nonManual: number;
  referencedNonManual: number;
  uncovered: string[];
} {
  const designRoot = join(root, "docs", "内嵌浏览器", "详细设计");
  const designed = new Map<string, boolean>();
  for (const file of readdirSync(designRoot).filter((file) =>
    file.endsWith("测试设计.md"),
  )) {
    const text = readFileSync(join(designRoot, file), "utf8");
    for (const match of text.matchAll(/^\| (TD-\d{2}-([MIBU])\d{2}) /gim)) {
      designed.set(match[1]!.toUpperCase(), match[2]!.toUpperCase() === "M");
    }
  }
  const implemented = new Set<string>();
  for (const directory of [
    "src-tauri/src/browser",
    "tests/browser",
    "scripts",
  ]) {
    for (const file of readdirSync(join(root, directory))) {
      const path = join(root, directory, file);
      if (!/\.(?:rs|ts|tsx)$/.test(file)) continue;
      for (const id of expandCaseReferences(readFileSync(path, "utf8")))
        implemented.add(id);
    }
  }
  const nonManual = [...designed]
    .filter(([, manual]) => !manual)
    .map(([id]) => id);
  return {
    designed: designed.size,
    manual: [...designed].filter(([, manual]) => manual).length,
    nonManual: nonManual.length,
    referencedNonManual: nonManual.filter((id) => implemented.has(id)).length,
    uncovered: nonManual.filter((id) => !implemented.has(id)).sort(),
  };
}

if (process.argv[1]?.endsWith("browserCoverage.ts")) {
  console.log(JSON.stringify(auditBrowserCoverage(process.cwd()), null, 2));
}
