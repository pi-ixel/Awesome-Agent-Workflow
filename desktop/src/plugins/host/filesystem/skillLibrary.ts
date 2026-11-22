export type SkillProvider = string;
export interface SkillQuery {
  provider: SkillProvider;
  profile: string | null;
  projects: string[];
}
type SourceKind = "directory" | "inline" | "package";
export interface SkillSource {
  path: string;
  label: string;
  project: string | null;
  kind: SourceKind;
  enabled: boolean | null;
  canImport: boolean;
}
export interface NativeSkill {
  name: string;
  path: string;
  source: string;
  description: string;
  preview: string;
  realPath: string;
  revision: string;
  isLink: boolean;
  kind: SourceKind;
  status: string;
  statusLabel?: string | null;
  skillFilePath?: string | null;
  usageCount: number | null;
  disabledId?: string;
  disabledProject?: string | null;
  unavailable?: string | null;
}
export interface RecycledSkill {
  id: string;
  description: string;
  path: string;
  name: string;
  kind: SourceKind;
  source?: string;
  project?: string | null;
  preview?: string;
  isLink?: boolean;
  unavailable?: string | null;
}
export interface SkillCatalog {
  profiles: string[];
  profile: string | null;
  sources: SkillSource[];
  entries: NativeSkill[];
  trash: RecycledSkill[];
  warnings: string[];
}
export type SkillAction =
  | {
      type: "import";
      from: string;
      destination: string;
      enable: boolean;
      names: string[];
    }
  | { type: "delete"; items: Pick<NativeSkill, "name" | "path" | "revision">[] }
  | { type: "deletePermanent"; item: Pick<NativeSkill, "name" | "path" | "revision"> }
  | { type: "restore" | "purge"; ids: string[] };
export type SkillFileRequest = {
  type: "directory" | "read";
  path: string;
};
export interface SkillFileRow {
  name: string;
  kind: "directory" | "file" | "unavailable";
  bytes: number | null;
}
export type SkillFileResponse =
  | { type: "directory"; entries: SkillFileRow[]; truncated: boolean }
  | { type: "text"; text: string; modifiedAt: number | null };
export type SkillDirectorySelection = Pick<
  NativeSkill,
  "source" | "path" | "realPath" | "disabledId"
>;
export interface NativeSkillLibrary {
  candidates(from: string): Promise<string[]>;
  list(query: SkillQuery): Promise<SkillCatalog>;
  change(query: SkillQuery, action: SkillAction): Promise<string[]>;
  sizes?: (
    query: SkillQuery,
    skills: SkillDirectorySelection[],
  ) => Promise<(number | null)[]>;
  files?: (
    query: SkillQuery,
    skill: SkillDirectorySelection,
    request: SkillFileRequest,
  ) => Promise<SkillFileResponse>;
}
