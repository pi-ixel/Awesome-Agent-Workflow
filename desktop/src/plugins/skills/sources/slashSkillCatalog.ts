import {
  normalizePath,
  pathKey,
  pathName,
} from "../../../shared/panelPaths.ts";
import type { SkillCatalog } from "../../host/types.ts";

export interface SlashSkillCandidate {
  readonly name: string;
  readonly directoryName: string;
  readonly path: string;
  readonly project: boolean;
  readonly description: string;
}

export interface SlashSkillCatalog {
  readonly skills: readonly SlashSkillCandidate[];
  readonly commandNames: ReadonlySet<string>;
}

export interface SlashSkillDescriptions {
  readonly descriptions: ReadonlyMap<string, string>;
}

export function slashSkillDescriptions(
  catalog: SkillCatalog,
  project: string | null,
): SlashSkillDescriptions {
  const sources = new Map(
    catalog.sources.map((source) => [pathKey(source.path), source]),
  );
  const projectKey = project && pathKey(project);
  const matches = new Map<
    string,
    { isProject: boolean; description: string | null }
  >();
  for (const entry of catalog.entries) {
    const source = sources.get(pathKey(entry.source));
    if (
      !source ||
      (source.project !== null && pathKey(source.project) !== projectKey)
    ) {
      continue;
    }
    const isProject = source.project !== null;
    const description = entry.description.trim();
    const names = [entry.name];
    if (entry.kind !== "inline") names.push(pathName(entry.path));
    for (const name of names) {
      const key = name.toLowerCase();
      const match = matches.get(key);
      if (!match || (isProject && !match.isProject)) {
        matches.set(key, { isProject, description });
      } else if (
        match.isProject === isProject &&
        match.description !== description
      ) {
        match.description = null;
      }
    }
  }
  const descriptions = new Map<string, string>();
  for (const [key, { description }] of matches) {
    if (description) descriptions.set(key, description);
  }
  return { descriptions };
}

export function slashSkillCatalog(
  catalog: SkillCatalog,
  project: string | null,
): SlashSkillCatalog {
  const sources = new Map(
    catalog.sources.map((source) => [pathKey(source.path), source]),
  );
  const selectedProject = project && pathKey(project);
  const commandNames = new Set<string>();
  const skills = new Map<string, SlashSkillCandidate>();
  for (const entry of catalog.entries) {
    const source = sources.get(pathKey(entry.source));
    if (
      !source ||
      (source.project !== null && pathKey(source.project) !== selectedProject)
    )
      continue;

    const directoryName = pathName(entry.path);
    commandNames.add(entry.name.toLowerCase());
    commandNames.add(directoryName.toLowerCase());
    if (entry.status !== "正常") continue;

    const identity = pathKey(
      entry.skillFilePath ?? entry.realPath + "/SKILL.md",
    );
    const isProject = source.project !== null;
    const existing = skills.get(identity);
    if (existing && (!existing.project || isProject)) continue;
    skills.set(identity, {
      name: entry.name,
      directoryName,
      path: normalizePath(entry.path + "/SKILL.md"),
      project: isProject,
      description: entry.description,
    });
  }
  return {
    skills: [...skills.values()].sort(
      (a, b) => Number(a.project) - Number(b.project),
    ),
    commandNames,
  };
}
