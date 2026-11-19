import { expect, it } from "vitest";
import type { SkillCatalog } from "../../../src/plugins/host/types.ts";
import { slashSkillDescriptions } from "../../../src/plugins/skills/sources/slashSkillCatalog.ts";

it("prefers the current project's description and excludes other projects", () => {
  const sources: SkillCatalog["sources"] = [
    { path: "D:/home/skills", label: "全局", project: null },
    { path: "D:/current/skills", label: "当前", project: "D:/current" },
    { path: "D:/other/skills", label: "其他", project: "D:/other" },
  ].map((source) => ({
    ...source,
    kind: "directory",
    enabled: null,
    canImport: true,
  }));
  const entries: SkillCatalog["entries"] = [
    ["Review", "review-folder", "全局说明", sources[0]!.path],
    ["Review", "review-folder", "当前项目说明", sources[1]!.path],
    ["Review", "review-folder", "其他项目说明", sources[2]!.path],
    ["Other", "other", "仅其他项目", sources[2]!.path],
    ["Global", "global", "仅全局", sources[0]!.path],
  ].map(([name, folder, description, source]) => ({
    name: name!,
    source: source!,
    path: `${source}/${folder}`,
    description: description!,
    preview: "",
    realPath: `${source}/${folder}`,
    revision: "",
    isLink: false,
    kind: "directory",
    status: "正常",
    usageCount: null,
  }));
  const { descriptions } = slashSkillDescriptions(
    { profiles: [], profile: null, sources, entries, trash: [], warnings: [] },
    "D:/current",
  );
  expect(descriptions.get("review")).toBe("当前项目说明");
  expect(descriptions.get("review-folder")).toBe("当前项目说明");
  expect(descriptions.get("global")).toBe("仅全局");
  expect(descriptions.has("other")).toBe(false);
});
