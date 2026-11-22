import { fieldSurfaceClass } from "../../../shared/ui/SettingsPageParts.tsx";
import { PageHeader } from "../../../shared/ui/PageHeader.tsx";
import { useFeedback } from "../../../shared/ui/feedback.ts";
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
  ActionButton,
  Checkbox,
  Listbox,
} from "../../../shared/ui/controls.tsx";
import {
  PlusIcon,
  RefreshIcon,
  SearchIcon,
} from "../../../shared/ui/icons.tsx";
import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import { SkillPackageActions } from "./SkillPackageActions.tsx";
import { SkillCard, SkillGroup } from "./SkillCards.tsx";
import { SkillDetail } from "./SkillDetail.tsx";
import { formatSize, projectGroups, skillKey } from "./skillGroups.ts";
import type { SkillPackageManager } from "../types.ts";

const buttonSize =
  "inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap px-3 text-ui-xs";

type Props = {
  library?: NativeSkillLibrary;
  provider: SkillProvider;
  storage: HostStorage;
  packages?: SkillPackageManager;
  knownProjects: () => string[];
  pick: (title: string) => Promise<string | null>;
  reveal: (path: string, action: "open-directory" | "reveal") => Promise<void>;
};
type SkillStatus = "all" | "enabled" | "disabled";

function isSharedSkill(skill: NativeSkill, catalog: SkillCatalog): boolean {
  return (
    skill.kind !== "inline" &&
    (/(?:^|\/)\.agents\/skills$/i.test(
      skill.source.replaceAll("\\", "/").replace(/\/$/, ""),
    ) ||
      catalog.entries.some(
        (other) =>
          other.path !== skill.path && other.realPath === skill.realPath,
      ))
  );
}
export function SkillLibrary(props: Props) {
  const [profile, setProfile] = useState<string | null>(null);
  return (
    <LibraryPage
      key={JSON.stringify([props.provider, profile])}
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
  const { library, knownProjects, provider, profile } = props;
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
    scanned?: SkillCatalog;
    error?: string;
  }>();
  const catalog = snapshot?.catalog;
  const scanned = snapshot?.scan === scan ? snapshot.scanned : undefined;
  const notify = useFeedback();
  const scanError = snapshot?.scan === scan ? snapshot.error : undefined;
  const [sizes, setSizes] = useState<{
    scan: typeof scan;
    bytes: ReadonlyMap<string, number>;
  }>();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<SkillStatus>("all");
  const [detail, setDetail] = useState<NativeSkill | null>(null);
  const [pending, setPending] = useState<{
    skill: NativeSkill;
    mode: "delete" | "disable";
  } | null>(null);
  const [batch, setBatch] = useState<{
    from: string;
    names: string[];
    checked: string[];
  } | null>(null);
  const [destination, setDestination] = useState("");
  const [enable, setEnable] = useState(false);
  const [reports, report] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState<ReadonlySet<string>>(new Set());
  const toggles = useRef(new Set<string>());
  const [rowSlots, setRowSlots] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const gate = useRef(false);
  const detailOpener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!detail && !pending && detailOpener.current) {
      detailOpener.current.focus({ preventScroll: true });
      detailOpener.current = null;
    }
  }, [detail, pending]);
  const rescan = () => {
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
          setRowSlots(new Map());
          setSnapshot({ scan, catalog: data, scanned: data });
        })
        .catch((e: unknown) => {
          if (current) setSnapshot({ scan, error: String(e) });
        });
    return () => {
      current = false;
    };
  }, [library, scan]);
  useEffect(() => {
    if (!library?.sizes || !scanned) return;
    const readSizes = library.sizes;
    const selected = [
      ...scanned.entries
        .filter((entry) => entry.kind !== "inline")
        .map(({ source, path, realPath }) => ({
          key: JSON.stringify([source, path]),
          selection: { source, path, realPath },
        })),
      ...scanned.trash
        .filter((entry) => entry.kind !== "inline" && !entry.unavailable)
        .map(({ id, path, source }) => ({
          key: id,
          selection: {
            source: source ?? path,
            path,
            realPath: path,
            disabledId: id,
          },
        })),
    ];
    let current = true;
    async function loadSizes() {
      const bytes = new Map<string, number>();
      for (let index = 0; index < selected.length && current; index += 16) {
        const batch = selected.slice(index, index + 16);
        const result = await readSizes(
          scan.query,
          batch.map(({ selection }) => selection),
        );
        if (!current) return;
        batch.forEach(({ key }, offset) => {
          if (typeof result[offset] === "number")
            bytes.set(key, result[offset]);
        });
        setSizes((previous) => ({
          scan,
          bytes: new Map([
            ...(previous?.scan === scan ? previous.bytes : []),
            ...bytes,
          ]),
        }));
      }
    }
    void loadSizes().catch(() => {
      // 大小是补充信息，读取失败时保留已显示的卡片和结果。
    });
    return () => {
      current = false;
    };
  }, [scanned, library, scan]);
  const manager = props.packages;
  const sources = new Map(catalog?.sources.map((entry) => [entry.path, entry]));
  const destinations = catalog?.sources.filter((s) => s.canImport) ?? [];
  const source = destinations.find((s) => s.path === destination);
  const toDisabled = (item: SkillCatalog["trash"][number]): NativeSkill => ({
    name: item.name,
    path: item.path,
    source: item.source ?? item.path,
    description: item.description,
    preview: item.preview ?? "",
    realPath: item.path,
    revision: item.id,
    isLink: item.isLink ?? false,
    kind: item.kind,
    status: "已停用",
    usageCount: null,
    disabledId: item.id,
    disabledProject: item.project,
    unavailable: item.unavailable,
  });
  const disabled = (catalog?.trash ?? []).map(toDisabled);
  const slots = new Map(
    [
      ...(scanned?.entries ?? []),
      ...(scanned?.trash ?? []).map(toDisabled),
    ].map((skill, index) => [skillKey(skill), index]),
  );
  const slot = (skill: NativeSkill) =>
    rowSlots.get(skillKey(skill)) ?? skillKey(skill);
  const keyword = search.trim().toLowerCase();
  const visible = [...(catalog?.entries ?? []), ...disabled]
    .filter(
      (entry) =>
        (status === "all" || (status === "disabled") === !!entry.disabledId) &&
        [entry.name, entry.description, entry.path].some((value) =>
          value.toLowerCase().includes(keyword),
        ),
    )
    .sort(
      (left, right) =>
        (slots.get(slot(left)) ?? Infinity) -
        (slots.get(slot(right)) ?? Infinity),
    );
  const groups = catalog
    ? projectGroups(visible, catalog, scan.query.projects)
    : [];
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
  async function toggleSkill(skill: NativeSkill) {
    if (!library || !catalog) return;
    const { source, path, realPath, name, revision, disabledId } = skill;
    if (!library.toggle) {
      await change(
        disabledId
          ? { type: "restore", ids: [disabledId] }
          : { type: "delete", items: [{ name, path, revision }] },
      );
      return;
    }
    const key = skillKey(skill);
    if (toggles.current.has(key)) return;
    toggles.current.add(key);
    setChanging(new Set(toggles.current));
    const query = { ...scan.query, profile: catalog.profile };
    try {
      const result = await library.toggle(
        query,
        disabledId
          ? { type: "enable", id: disabledId }
          : { type: "disable", source, path, realPath, name, revision },
      );
      const next =
        result.entry ?? (result.stopped ? toDisabled(result.stopped) : null);
      if (notify)
        notify({ message: result.message, variant: next ? "ok" : "warn" });
      else if (!next) report([result.message]);
      if (!next) return;
      setRowSlots(
        (previous) =>
          new Map([...previous, [skillKey(next), previous.get(key) ?? key]]),
      );
      setSnapshot((previous) => {
        if (!previous?.catalog || previous.scan !== scan) return previous;
        const current = previous.catalog;
        return {
          ...previous,
          catalog: {
            ...current,
            entries: [
              ...current.entries.filter((entry) => skillKey(entry) !== key),
              ...(result.entry ? [result.entry] : []),
            ],
            trash: [
              ...current.trash.filter((entry) => entry.id !== disabledId),
              ...(result.stopped ? [result.stopped] : []),
            ],
          },
        };
      });
      if (library.sizes && next.kind !== "inline") {
        const target = {
          source: next.source,
          path: next.path,
          realPath: next.realPath,
          disabledId: next.disabledId,
        };
        const sizeKey =
          next.disabledId ?? JSON.stringify([next.source, next.path]);
        const oldSize =
          sizes?.scan === scan
            ? sizes.bytes.get(disabledId ?? JSON.stringify([source, path]))
            : undefined;
        if (oldSize !== undefined)
          setSizes((previous) => ({
            scan,
            bytes: new Map([
              ...(previous?.scan === scan ? previous.bytes : []),
              [sizeKey, oldSize],
            ]),
          }));
        void library
          .sizes(query, [target])
          .then(([bytes]) => {
            if (typeof bytes === "number")
              setSizes((previous) =>
                !previous || previous.scan === scan
                  ? {
                      scan,
                      bytes: new Map([
                        ...(previous?.bytes ?? []),
                        [sizeKey, bytes],
                      ]),
                    }
                  : previous,
              );
          })
          .catch(() => undefined);
      }
    } catch (error) {
      if (notify) notify({ message: String(error), variant: "danger" });
      else report([String(error)]);
    } finally {
      toggles.current.delete(key);
      setChanging(new Set(toggles.current));
    }
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
    open: (skill: NativeSkill) =>
      void props
        .reveal(
          skill.path,
          skill.kind === "inline" ? "reveal" : "open-directory",
        )
        .catch((e: unknown) => report([String(e)])),
    remove: (skill: NativeSkill, opener: HTMLButtonElement) => {
      detailOpener.current = opener;
      setPending({ skill, mode: "delete" });
    },
    toggle: (skill: NativeSkill) => {
      if (skill.disabledId) {
        void toggleSkill(skill);
      } else if (catalog && isSharedSkill(skill, catalog)) {
        setPending({ skill, mode: "disable" });
      } else {
        void toggleSkill(skill);
      }
    },
  };
  function confirm() {
    if (!pending || busy) return;
    const { skill, mode } = pending;
    const { name, path, revision, disabledId } = skill;
    setPending(null);
    setDetail(null);
    if (mode === "disable") {
      void toggleSkill(skill);
    } else if (disabledId) {
      void change({ type: "purge", ids: [disabledId] });
    } else {
      void change({ type: "deletePermanent", item: { name, path, revision } });
    }
  }
  return (
    <section aria-label="技能管理" className="w-full text-ui-sm text-ink">
      <PageHeader
        title="技能"
        bordered
        count={
          catalog
            ? `${catalog.entries.length + catalog.trash.length} 项 · ${catalog.entries.length} 已启用`
            : undefined
        }
        actions={
          <>
            <ActionButton
              tone="secondary"
              size="compact"
              disabled={busy || !library}
              onClick={rescan}
            >
              <RefreshIcon className="ui-icon-14" />
              刷新
            </ActionButton>

            <ActionButton
              tone="primary"
              size="compact"
              disabled={busy || !destinations.length}
              onClick={importSkills}
            >
              <PlusIcon className="ui-icon-14" />
              导入技能
            </ActionButton>
          </>
        }
      />
      <fieldset
        disabled={busy}
        className="mx-auto w-full min-w-0 max-w-[112rem] space-y-6 px-[clamp(1rem,3vw,3rem)] py-4"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line pb-4">
          {!!catalog?.profiles.length && (
            <Listbox
              label="配置档案"
              className="min-h-9 max-w-52 text-ui-sm"
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
              className={`${fieldSurfaceClass} min-h-9 w-44 pl-8 pr-2 text-ui-xs`}
              placeholder="搜索技能…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <Listbox
            label="技能状态"
            className="min-h-9 text-ui-xs"
            value={status}
            options={[
              { value: "all", label: "全部状态" },
              { value: "enabled", label: "已启用" },
              { value: "disabled", label: "已停用" },
            ]}
            onChange={(value) =>
              setStatus(
                value === "disabled" || value === "enabled" ? value : "all",
              )
            }
          />
        </div>
        {!library ? (
          <p>请在 AAW Desktop 中打开技能页。</p>
        ) : scanError ? (
          <div role="alert">
            {scanError}{" "}
            {profile && (
              <ActionButton
                tone="secondary"
                className={buttonSize}
                onClick={() => props.changeProfile(null)}
              >
                返回默认配置
              </ActionButton>
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
            {status === "disabled" && manager && !keyword && (
              <SkillPackageActions
                manager={manager}
                storage={props.storage}
                report={report}
                changed={rescan}
              />
            )}
            {!visible.length && <p className="text-ink-mute">没有匹配的技能</p>}
            {groups.map((group) => (
              <SkillGroup key={group.project ?? ""} {...group}>
                {group.entries.map((skill) => {
                  const origin = sources.get(skill.source);
                  const bytes =
                    sizes?.scan === scan
                      ? sizes.bytes.get(
                          skill.disabledId ??
                            JSON.stringify([skill.source, skill.path]),
                        )
                      : undefined;
                  return (
                    <SkillCard
                      key={slot(skill)}
                      skill={skill}
                      isToggling={changing.has(skillKey(skill))}
                      actions={{
                        ...actions,
                        busy: busy || changing.has(skillKey(skill)),
                      }}
                      metadata={[
                        origin?.label ??
                          (skill.kind === "inline"
                            ? "配置内定义"
                            : skill.kind === "package"
                              ? "插件技能"
                              : "目录技能"),
                        bytes === undefined ? null : formatSize(bytes),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      status={
                        skill.unavailable ??
                        (!skill.disabledId &&
                        !["正常", "配置内定义"].includes(skill.status)
                          ? (skill.statusLabel ?? skill.status)
                          : !skill.disabledId && origin?.enabled === false
                            ? "当前配置未加载来源"
                            : undefined)
                      }
                      onDetail={(opener) => {
                        detailOpener.current = opener;
                        report([]);
                        setDetail(skill);
                      }}
                    />
                  );
                })}
              </SkillGroup>
            ))}
          </>
        )}
      </fieldset>
      {catalog && detail && !pending && (
        <SkillDetail
          key={skillKey(detail)}
          skill={detail}
          catalog={catalog}
          actions={actions}
          query={scan.query}
          readFiles={library?.files}
          message={reports.join("\n")}
          onClose={() => setDetail(null)}
        />
      )}
      {pending && (
        <ConfirmationDialog
          label="确认技能操作"
          title={
            pending.mode === "delete" ? "永久删除技能？" : "停用共用技能？"
          }
          confirmLabel={pending.mode === "delete" ? "永久删除" : "停用"}
          onCancel={() => setPending(null)}
          onConfirm={confirm}
        >
          <p className="break-all font-semibold">{pending.skill.name}</p>
          <p>
            {pending.mode === "disable"
              ? "共用此目录的 Agent 下次加载时也会停用此技能。已打开的会话可能需要重连。可通过开关恢复。"
              : pending.skill.isLink
                ? "仅删除本条链接，保留目标文件。此操作无法恢复。"
                : pending.skill.kind === "inline"
                  ? "仅移除这条配置定义。此操作无法恢复。"
                  : "删除此技能的文件。共用此目录的 Agent 下次加载时也会受影响。此操作无法恢复。"}
          </p>
          <p className="break-all font-mono text-xs text-ink-mute">
            {pending.skill.path}
          </p>
        </ConfirmationDialog>
      )}{" "}
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
                <Checkbox
                  label="同时将此目录加入当前配置所有会话的加载路径"
                  checked={enable}
                  onChange={setEnable}
                />
              )}
            </div>
          )}
          {source?.enabled === null && (
            <p>当前 Agent 是否加载此来源未知。导入将写入所选目录。</p>
          )}
          <div className="flex max-h-60 flex-col gap-2 overflow-auto">
            {batch.names.map((n) => (
              <Checkbox
                key={n}
                label={n}
                checked={batch.checked.includes(n)}
                onChange={(checked) =>
                  setBatch({
                    ...batch,
                    checked: checked
                      ? [...batch.checked, n]
                      : batch.checked.filter((s) => s !== n),
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
