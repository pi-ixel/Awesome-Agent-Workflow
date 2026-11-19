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
}
export interface RecycledSkill {
  id: string;
  description: string;
  path: string;
  name: string;
  kind: SourceKind;
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
  | { type: "restore" | "purge"; ids: string[] };
export interface NativeSkillLibrary {
  candidates(from: string): Promise<string[]>;
  list(query: SkillQuery): Promise<SkillCatalog>;
  change(query: SkillQuery, action: SkillAction): Promise<string[]>;
}
