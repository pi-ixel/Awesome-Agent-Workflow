import { useEffect, useMemo, useRef, useState } from "react";
import type {
  HostStorage,
  NativeSkill,
  NativeSkillLibrary,
  SkillAction,
  SkillCatalog,
  SkillProvider,
} from "../../host/types.ts";
import {
  btnPrimary,
  btnSecondary,
  CheckSquare,
  Listbox,
} from "../../../shared/ui/controls.tsx";
import {
  CheckIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
} from "../../../shared/ui/icons.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import { SkillPackageActions } from "./SkillPackageActions.tsx";
import { uninstallSkillPackage } from "./skillPackageReceipts.ts";
import {
  SelectableSkillCard,
  SkillCard,
  SkillDetail,
  SkillGroup,
} from "./SkillCards.tsx";
import { projectGroups, skillKey } from "./skillGroups.ts";
import type { SkillPackage, SkillPackageManager } from "../types.ts";

const buttonSize =
  " inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap px-3 text-xs";
const button = btnSecondary + buttonSize;
type Props = {
  library?: NativeSkillLibrary;
  provider: SkillProvider;
  storage: HostStorage;
  packages?: SkillPackageManager;
  knownProjects: () => string[];
  pick: (title: string) => Promise<string | null>;
  reveal: (path: string, action: "open-directory" | "reveal") => Promise<void>;
  trash?: boolean;
};
type Pending =
  | { type: "delete"; items: NativeSkill[] }
  | { type: "purge"; ids: string[] }
  | { type: "uninstall"; pkg: SkillPackage; manager: SkillPackageManager };
function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
      <input
        type="checkbox"
        className="peer sr-only"
        aria-label={label}
        checked={checked}
        onChange={onChange}
      />
      <span className="rounded peer-focus-visible:ring-2">
        <CheckSquare checked={checked} />
      </span>
      {label}
    </label>
  );
}

export function SkillLibrary(props: Props) {
  const [profile, setProfile] = useState<string | null>(null);
  return (
    <LibraryPage
      key={JSON.stringify([props.provider, profile, !!props.trash])}
      {...props}
      profile={profile}
      changeProfile={setProfile}
    />
  );
}

function LibraryPage(
  props: Props & {
    profile: string | null;
    changeProfile: (v: string | null) => void;
  },
) {
  const { library, knownProjects, provider, profile, trash = false } = props;
  const [tick, refresh] = useState(0);
  const scan = useMemo(
    () => ({
      tick,
      query: {
        provider,
        profile,
        projects: knownProjects(),
      },
    }),
    [provider, profile, knownProjects, tick],
  );
  const [snapshot, setSnapshot] = useState<{
    scan: typeof scan;
    catalog?: SkillCatalog;
    error?: string;
  }>();
  const catalog = snapshot?.scan === scan ? snapshot.catalog : undefined;
  const scanError = snapshot?.scan === scan ? snapshot.error : undefined;
  const [search, setSearch] = useState("");
  const [isBulk, setBulk] = useState(false);
  const [selected, select] = useState<string[]>([]);
  const [detail, setDetail] = useState<NativeSkill | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [batch, setBatch] = useState<{
    from: string;
    names: string[];
    checked: string[];
  } | null>(null);
  const [destination, setDestination] = useState("");
  const [enable, setEnable] = useState(false);
  const [reports, report] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  const detailOpener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!detail && !pending && detailOpener.current) {
      detailOpener.current.focus({ preventScroll: true });
      detailOpener.current = null;
    }
  }, [detail, pending]);
  const rescan = () => {
    select([]);
    setDetail(null);
    setPending(null);
    refresh((n) => n + 1);
  };
  useEffect(() => {
    let current = true;
    if (library)
      void library
        .list(scan.query)
        .then((data) => {
          if (!current) return;
          setSnapshot({ scan, catalog: data });
        })
        .catch((e: unknown) => {
          if (current) setSnapshot({ scan, error: String(e) });
        });
    return () => {
      current = false;
    };
  }, [library, scan]);
  const manager = props.packages;
  const destinations = catalog?.sources.filter((s) => s.canImport) ?? [];
  const source = destinations.find((s) => s.path === destination);
  const visible =
    catalog?.entries.filter((e) =>
      [e.name, e.description, e.path].some((s) =>
        s.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    ) ?? [];
  const groups = catalog
    ? projectGroups(visible, catalog, scan.query.projects)
    : [];
  const recycled =
    catalog?.trash.filter((e) =>
      (e.name + " " + e.path)
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
    ) ?? [];
  const selectedSkills = visible.filter(
    (e) => e.kind !== "package" && selected.includes(skillKey(e)),
  );
  const toggle = (id: string) =>
    select((keys) =>
      keys.includes(id) ? keys.filter((k) => k !== id) : [...keys, id],
    );
  async function perform(operation: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    try {
      await operation();
    } catch (e) {
      report([String(e)]);
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  async function change(action: SkillAction) {
    if (!library || !catalog) return;
    await perform(async () => {
      try {
        report(
          await library.change(
            { ...scan.query, profile: catalog.profile },
            action,
          ),
        );
      } finally {
        rescan();
      }
    });
  }
  const importSkills = () =>
    void perform(async () => {
      const from = await props.pick("选择技能目录或包含多个技能的目录");
      if (!from || !library) return;
      const names = await library.candidates(from);
      if (!names.length) {
        report(["未找到包含 SKILL.md 的技能目录"]);
        return;
      }
      setDestination(
        (destinations.find((s) => s.enabled) ?? destinations[0])?.path ?? "",
      );
      setEnable(false);
      setBatch({ from, names, checked: names });
    });
  const actions = {
    busy,
    hasPackageManager: !!manager,
    open: (skill: NativeSkill) =>
      void props
        .reveal(
          skill.path,
          skill.kind === "inline" ? "reveal" : "open-directory",
        )
        .catch((e: unknown) => report([String(e)])),
    remove: (skill: NativeSkill) => {
      if (skill.kind !== "package")
        setPending({ type: "delete", items: [skill] });
      else if (manager)
        void perform(async () =>
          setPending({
            type: "uninstall",
            manager,
            pkg: await manager.inspect(skill.path),
          }),
        );
    },
  };
  function confirm() {
    if (!pending || busy) return;
    setPending(null);
    setDetail(null);
    if (pending.type === "uninstall") {
      void perform(async () => {
        try {
          await uninstallSkillPackage(
            pending.manager,
            props.storage,
            pending.pkg,
          );
          report([`已卸载 ${pending.pkg.id}`]);
        } finally {
          rescan();
        }
      });
    } else if (pending.type === "purge") void change(pending);
    else
      void change({
        type: "delete",
        items: pending.items.map(({ name, path, revision }) => ({
          name,
          path,
          revision,
        })),
      });
  }
  const count = trash ? recycled.length : visible.length;
  return (
    <section
      aria-label="技能管理"
      className="mx-auto w-full max-w-[112rem] space-y-5 px-[clamp(1rem,3vw,3rem)] py-6 text-sm text-ink"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-ui-settings-title-lg font-semibold tracking-tight">
            {trash ? "回收站" : "技能"}
          </h1>
          {catalog && !trash && (
            <span className="border-l border-line-strong pl-3 text-xs text-ink-mute">
              {count} 项
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            iconSize="rail"
            className={btnSecondary}
            disabled={busy || !library}
            aria-label="刷新"
            data-hint="刷新"
            onClick={rescan}
          >
            <RefreshIcon className="ui-icon-16" />
          </IconButton>
          {!trash && (
            <button
              className={btnPrimary + buttonSize}
              disabled={busy || !destinations.length}
              onClick={importSkills}
            >
              <PlusIcon className="ui-icon-14" />
              导入技能
            </button>
          )}
        </div>
      </header>
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-center gap-2 border-b border-line pb-4">
          {!!catalog?.profiles.length && (
            <Listbox
              label="配置档案"
              className="min-h-9 max-w-52 text-xs"
              value={catalog.profile}
              triggerLabel={`配置档案 ${catalog.profile?.replace(/\.ya?ml$/, "") ?? "内置默认配置"}`}
              options={catalog.profiles.map((p) => ({
                value: p,
                label: p.replace(/\.ya?ml$/, ""),
              }))}
              onChange={props.changeProfile}
            />
          )}
          <label className="relative flex min-w-36 items-center">
            <SearchIcon className="ui-icon-14 pointer-events-none absolute left-2.5 text-ink-mute" />
            <input
              aria-label="搜索技能"
              className="min-h-9 w-44 rounded-md border border-line-strong bg-surface pl-8 pr-2 text-xs"
              placeholder={trash ? "搜索回收条目" : "搜索技能…"}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                select([]);
              }}
            />
          </label>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {catalog && (trash || isBulk) && (
              <div className="flex flex-wrap gap-2">
                <button
                  className={button}
                  disabled={!count}
                  onClick={() =>
                    select(
                      trash
                        ? recycled.map((e) => e.id)
                        : visible
                            .filter((e) => e.kind !== "package")
                            .map(skillKey),
                    )
                  }
                >
                  全选
                </button>
                {trash && (
                  <button
                    className={button}
                    disabled={!selected.length}
                    onClick={() =>
                      void change({ type: "restore", ids: selected })
                    }
                  >
                    恢复所选
                  </button>
                )}
                {trash ? (
                  <button
                    className={button}
                    disabled={!selected.length}
                    onClick={() => setPending({ type: "purge", ids: selected })}
                  >
                    永久删除
                    {selected.length ? `（${selected.length}）` : ""}
                  </button>
                ) : (
                  <IconButton
                    iconSize="rail"
                    aria-label="将所选技能移入回收站"
                    data-hint={
                      selectedSkills.length
                        ? `将 ${selectedSkills.length} 个技能移入回收站`
                        : "将所选技能移入回收站"
                    }
                    disabled={!selectedSkills.length}
                    className="rounded-md border border-line-strong bg-surface text-ink-mute transition-colors enabled:hover:border-danger-line enabled:hover:bg-danger-bg enabled:hover:text-danger-ink focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40"
                    onClick={() =>
                      setPending({ type: "delete", items: selectedSkills })
                    }
                  >
                    <TrashIcon className="ui-icon-16" />
                  </IconButton>
                )}
              </div>
            )}
            {!trash && (
              <button
                className={button}
                aria-pressed={isBulk}
                onClick={() => {
                  setBulk(!isBulk);
                  select([]);
                }}
              >
                <CheckIcon className="ui-icon-14" />
                {isBulk ? "退出选择" : "批量选择"}
              </button>
            )}
          </div>
        </div>
        {!library ? (
          <p>请在 AAW Desktop 中打开技能页。</p>
        ) : scanError ? (
          <div role="alert">
            {scanError}{" "}
            {profile && (
              <button
                className={button}
                onClick={() => props.changeProfile(null)}
              >
                返回默认配置
              </button>
            )}
          </div>
        ) : !catalog ? (
          <p role="status">正在扫描技能…</p>
        ) : (
          <>
            {catalog.warnings.map((w, i) => (
              <p key={i} role="alert" className="break-all text-xs">
                {w}
              </p>
            ))}
            {!detail && reports.length > 0 && (
              <div role="status" className="space-y-1 text-xs">
                {reports.map((m, i) => (
                  <p key={i} className="break-all">
                    {m}
                  </p>
                ))}
              </div>
            )}
            {trash ? (
              <>
                {manager && (
                  <SkillPackageActions
                    manager={manager}
                    storage={props.storage}
                    report={report}
                    changed={rescan}
                  />
                )}
                {!count && (
                  <p className="text-ink-mute">没有匹配的文件或配置回收条目</p>
                )}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(16.5rem,100%),1fr))] gap-3">
                  {recycled.map((e) => (
                    <SelectableSkillCard
                      key={e.id}
                      name={e.name}
                      description={e.description}
                      selected={selected.includes(e.id)}
                      onToggle={() => toggle(e.id)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <>
                {!count && <p className="text-ink-mute">没有匹配的技能</p>}
                {groups.map((group) => (
                  <SkillGroup key={group.project ?? ""} {...group}>
                    {group.entries.map((skill) =>
                      isBulk ? (
                        <SelectableSkillCard
                          key={skillKey(skill)}
                          name={skill.name}
                          description={skill.description}
                          disabled={skill.kind === "package"}
                          selected={selected.includes(skillKey(skill))}
                          onToggle={() => toggle(skillKey(skill))}
                        />
                      ) : (
                        <SkillCard
                          key={skillKey(skill)}
                          skill={skill}
                          actions={actions}
                          onDetail={(opener) => {
                            detailOpener.current = opener;
                            report([]);
                            setDetail(skill);
                          }}
                        />
                      ),
                    )}
                  </SkillGroup>
                ))}
              </>
            )}
          </>
        )}
      </fieldset>
      {catalog && detail && !pending && (
        <SkillDetail
          skill={detail}
          catalog={catalog}
          actions={actions}
          message={reports.join("\n")}
          onClose={() => setDetail(null)}
        />
      )}
      {pending && (
        <ConfirmationDialog
          label={
            pending.type === "uninstall" ? "确认卸载插件包" : "确认技能操作"
          }
          title={
            pending.type === "uninstall"
              ? "卸载整个插件包"
              : pending.type === "purge"
                ? "永久删除回收条目"
                : "将技能移入回收站？"
          }
          confirmLabel={
            pending.type === "uninstall"
              ? "卸载插件包"
              : pending.type === "purge"
                ? "永久删除"
                : "移入回收站"
          }
          onCancel={() => setPending(null)}
          onConfirm={confirm}
        >
          {pending.type === "delete" ? (
            <ul className="max-h-60 space-y-2 overflow-auto">
              {pending.items.map((e) => (
                <li key={skillKey(e)}>
                  <strong className="break-all font-mono">{e.name}</strong>
                  <p>
                    {e.isLink
                      ? "仅移除链接，保留目标。"
                      : e.kind === "inline"
                        ? "从配置移除，可恢复定义。"
                        : "回收技能目录，共用该目录的 Agent 也会受影响。"}
                    可从回收站恢复。
                  </p>
                  <p className="break-all font-mono text-xs text-ink-mute">
                    {e.path}
                  </p>
                </li>
              ))}
            </ul>
          ) : pending.type === "purge" ? (
            <p>永久删除所选的 {pending.ids.length} 个条目后将无法恢复。</p>
          ) : (
            <>
              <p>
                {pending.pkg.id}{" "}
                的全部技能及其他插件能力都将被移除。可以从回收站通过 CodeAgent
                重新安装，版本取决于原生插件源。
              </p>
              <p className="break-all">{pending.pkg.path}</p>
            </>
          )}
        </ConfirmationDialog>
      )}
      {batch && catalog && (
        <ConfirmationDialog
          label="选择导入技能"
          title="选择导入技能"
          tone="neutral"
          confirmLabel="导入所选"
          confirmDisabled={!batch.checked.length || !destination}
          onCancel={() => setBatch(null)}
          onConfirm={() => {
            setBatch(null);
            void change({
              type: "import",
              from: batch.from,
              destination,
              enable,
              names: batch.checked,
            });
          }}
        >
          <p>导入位置 · 同名技能将跳过。</p>
          <Listbox
            label="导入位置"
            fullWidth
            className="min-h-9"
            value={destination}
            options={destinations.map((s) => ({
              value: s.path,
              label: s.path,
              group: s.project ?? "全局",
            }))}
            onChange={(v) => {
              setDestination(v);
              setEnable(false);
            }}
          />
          {source?.enabled === false && (
            <div className="space-y-1">
              <p>当前配置未加载此来源。</p>
              {catalog.profile && (
                <Check
                  label="同时将此目录加入当前配置所有会话的加载路径"
                  checked={enable}
                  onChange={() => setEnable(!enable)}
                />
              )}
            </div>
          )}
          {source?.enabled === null && (
            <p>当前 Agent 是否加载此来源未知。导入将写入所选目录。</p>
          )}
          <div className="flex max-h-60 flex-col gap-2 overflow-auto">
            {batch.names.map((n) => (
              <Check
                key={n}
                label={n}
                checked={batch.checked.includes(n)}
                onChange={() =>
                  setBatch({
                    ...batch,
                    checked: batch.checked.includes(n)
                      ? batch.checked.filter((s) => s !== n)
                      : [...batch.checked, n],
                  })
                }
              />
            ))}
          </div>
        </ConfirmationDialog>
      )}
    </section>
  );
}
