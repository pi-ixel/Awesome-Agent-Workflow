import { useState } from "react";
import { pathKey, pathName } from "../panelPaths.ts";
import type { ReadonlySnapshot } from "../state/readonlySnapshot.ts";
import { useRegisteredSnapshot } from "../state/useRegisteredSnapshot.ts";
import { Listbox } from "./controls.tsx";

export type ToolProjectSource = ReadonlySnapshot<{
  readonly projectFolders?: Readonly<
    Record<
      string,
      {
        readonly relatedPaths: readonly string[];
      }
    >
  >;
}>;

export function useToolProject(
  primary: string | null,
  source?: ToolProjectSource,
) {
  const related = useRegisteredSnapshot(source, (state) =>
    primary
      ? state?.projectFolders?.[pathKey(primary)]?.relatedPaths
      : undefined,
  );
  const [selected, select] = useState<string>();
  const projects = primary ? [primary, ...(related ?? [])] : [];
  const project = projects.find((path) => path === selected) ?? primary;
  return { project, projects, select };
}

export function ToolProjectSelector({
  label,
  paths,
  value,
  onChange,
}: {
  readonly label: string;
  readonly paths: readonly string[];
  readonly value: string;
  readonly onChange: (path: string) => void;
}) {
  if (paths.length < 2) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="text-ui-caption text-ink-mute">项目</span>
      <Listbox
        label={label}
        value={value}
        options={paths.map((path) => ({ value: path, label: pathName(path) }))}
        onChange={onChange}
        className="max-w-36 py-0.5 text-ui-sm"
      />
    </div>
  );
}
