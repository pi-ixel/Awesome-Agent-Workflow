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
  | {
      type: "deletePermanent";
      item: Pick<NativeSkill, "name" | "path" | "revision">;
    }
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
  toggle?(
    query: SkillQuery,
    action:
      | { type: "enable"; id: string }
      | ({
          type: "disable";
          name: string;
          revision: string;
        } & SkillDirectorySelection),
  ): Promise<{
    message: string;
    entry: NativeSkill | null;
    stopped: RecycledSkill | null;
  }>;
  remove?: (
    query: SkillQuery,
    action: SkillRemovalAction,
  ) => Promise<SkillRemovalResult[]>;
  cleanupCodeAgent?: (
    identity: string,
    version: string | null,
  ) => Promise<SkillRemovalResult[]>;
  files?: (
    query: SkillQuery,
    skill: SkillDirectorySelection,
    request: SkillFileRequest,
  ) => Promise<SkillFileResponse>;
}

export interface SkillRemovalResult {
  name: string;
  path: string | null;
  id: string | null;
  ok: boolean;
  message: string;
  stopped: RecycledSkill | null;
}

export type SkillRemovalAction =
  | Extract<SkillAction, { type: "deletePermanent" }>
  | { type: "purge"; ids: string[] };
