import { pathKey } from "../../../shared/panelPaths.ts";
import type { NativeSkill, SkillCatalog } from "../../host/types.ts";

export function skillKey(skill: NativeSkill) {
  return JSON.stringify([
    skill.source,
    skill.path,
    skill.name,
    skill.disabledId ?? skill.revision,
  ]);
}
export function projectGroups(
  entries: NativeSkill[],
  catalog: SkillCatalog,
  projects: string[],
) {
  const sources = new Map(
    catalog.sources.map((source) => [source.path, source]),
  );
  const groups = new Map<
    string,
    { project: string | null; entries: NativeSkill[] }
  >();
  for (const skill of entries) {
    const project =
      sources.get(skill.source)?.project ?? skill.disabledProject ?? null;
    const key = project ? pathKey(project) : "";
    const group = groups.get(key) ?? { project, entries: [] };
    group.entries.push(skill);
    groups.set(key, group);
  }
  const order = projects.map(pathKey);
  const rank = (project: string | null) => {
    if (!project) return -1;
    const index = order.indexOf(pathKey(project));
    return index < 0 ? order.length : index;
  };
  return [...groups.values()].sort((a, b) => rank(a.project) - rank(b.project));
}
