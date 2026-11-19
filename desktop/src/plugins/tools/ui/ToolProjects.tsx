import { useState } from "react";
import { useStore } from "zustand";
import { pathKey } from "../../../shared/panelPaths.ts";
import { DangerButton, btnGhost, btnPrimary, btnSecondary } from "../../../shared/ui/controls.tsx";
import { WrenchIcon } from "../../../shared/ui/icons.tsx";
import type { ToolProjectSummary } from "../runtime/project.ts";
import type { PersonalTool } from "../types.ts";
import { ProjectDetail } from "./ToolBuilder.tsx";
import { ToolPath } from "./ToolPath.tsx";
import type { WorkshopService } from "./workshop.ts";

/**
 * 我的工具项目：磁盘上真实存在的目录，不是"装了什么"。
 *
 * 一个项目在页面上**只出现一次**——就是这一行。点标题展开，展开的内容
 * 就是「校验结论 + 验收动作」；收起即消失。以前那部分是一个独立的浮动
 * 卡片，和列表里的同一个项目并排出现，于是同一个东西有了两套动作、两个
 * 刷新时机，而且卡片没有关闭入口：目录被删掉之后它仍然挂着，点重新校验
 * 只会得到"目标文件不存在"。
 */
export function ToolProjectList({ workshop, installed, available, onPreview }: {
  workshop: WorkshopService;
  /** 已安装列表：用来标出"这个项目装了没有 / 装的是哪一版"。 */
  installed: readonly PersonalTool[];
  /** 桌面版才有目录选择器：没有时隐藏更改/恢复按钮，只展示当前位置。 */
  available: boolean;
  onPreview: (dir: string) => void;
}) {
  const snapshot = useStore(workshop.state);
  const [confirming, setConfirming] = useState<string>();
  const [renaming, setRenaming] = useState<{ dir: string; name: string; id: string; note?: string }>();
  const { projects, projectsLoading, projectsRoot, customRoot, busy, project: active } = snapshot;
  const root = customRoot ?? projectsRoot;
  const activeKey = active ? pathKey(active.dir) : "";
  /**
   * 展开中的项目即使还没被扫到，也得有一行可展开。
   *
   * 刚建完项目、刷新还在途中的那一小段时间里，列表是空的；如果这时直接
   * 渲染空状态，用户会以为刚建的项目没了。拿快照合成一行就够。
   */
  const rows: ToolProjectSummary[] = [...projects];
  if (active && !projects.some((entry) => pathKey(entry.dir) === activeKey)) {
    rows.unshift({
      dir: active.dir,
      dirName: active.dir.split(/[\\/]/).filter(Boolean).pop() ?? active.id,
      id: active.id,
      name: active.name,
      version: snapshot.check?.tool?.version,
      // 还没读过盘时不能说"没有 index.html"：新建项目的那一瞬间就是这样，
      // 红字提示会让用户以为 AI 根本没把文件写出来。
      hasHtml: snapshot.check ? !!snapshot.check.tool : true,
      network: snapshot.check?.tool?.permissions?.network === true,
    });
  }
  if (projectsLoading && !rows.length)
    return <p className="build-hint">正在读取工具项目…</p>;
  if (!rows.length)
    return <section className="build-empty" aria-label="还没有工具项目">
      <span className="build-empty-mark" aria-hidden="true"><WrenchIcon /></span>
      <div className="build-empty-copy">
        <strong>还没有工具项目</strong>
        <p>在上面写下需求，AI 会在一个真实目录里把工具做出来；之后每个项目都能继续改、预览、重新安装。</p>
      </div>
      <div className="build-empty-cues" aria-hidden="true"><span>manifest.json</span><span>index.html</span><span>AGENTS.md</span></div>
    </section>;

  async function commitRename() {
    if (!renaming) return;
    const note = await workshop.rename(renaming.dir, {
      name: renaming.name.trim(),
      id: renaming.id.trim(),
    });
    if (note.error) setRenaming({ ...renaming, note: note.text });
    else setRenaming(undefined);
  }

  return <>
    <div className="build-projects-head">
      <span>{rows.length} 个项目</span>
      {/* 根目录是项目落在哪的唯一开关：新建与列表用的是同一个值。 */}
      {root
        ? <ToolPath path={root} label={customRoot ? "自定义根目录" : "根目录"} compact />
        : <span>根目录：AAW 数据目录 / tools / projects</span>}
      {available && (
        <span className="build-root-actions">
          <button type="button" className={btnGhost} onClick={() => void workshop.chooseProjectsRoot()}>
            {customRoot ? "更改目录" : "自定义目录"}
          </button>
          {customRoot && (
            <button type="button" className={btnGhost} onClick={() => workshop.resetProjectsRoot()}>
              恢复默认
            </button>
          )}
        </span>
      )}
    </div>
    <ul aria-label="工具项目" className="build-projects">
      {rows.map((project) => {
        const name = project.name ?? project.dirName;
        const selectable = !project.broken && project.hasHtml;
        const expanded = pathKey(project.dir) === activeKey;
        const entry = installed.find((item) => item.package.id === project.id);
        // 版本号对不上就提示：AI 常常改完内容忘了改版本号，那种情况在展开后
        // 由内容指纹比对，这里只处理版本号已经变了的情况。
        const versionDiffers = !!entry && !!project.version && entry.package.version !== project.version;
        return <li key={project.dir} className={`build-project ${expanded ? "is-open" : ""}`}>
          <div className="build-project-main">
            {/* 标题整块是展开开关：展开 = "我要处理这个项目"，同时它也是
                「AI 停下就校验」的跟踪目标。收起就等于放弃跟踪。 */}
            <button
              type="button"
              className="build-project-toggle"
              aria-expanded={expanded}
              onClick={() => { if (expanded) workshop.dismiss(); else void workshop.select(project.dir); }}
            >
              <span className="build-project-chevron" aria-hidden="true" />
              <strong>{name}</strong>
            </button>
            <span className="build-project-meta">
              {project.version ? `v${project.version}` : "未写版本"}
              {entry
                ? versionDiffers
                  ? <em className="build-drift">装进去的还是 v{entry.package.version}</em>
                  : <em className="build-permission">已安装</em>
                : <em className="build-permission">未安装</em>}
              {project.network && <em className="build-permission">可联网</em>}
              {!project.hasHtml && <em className="build-missing">还没有 index.html</em>}
            </span>
            {project.broken && <span className="build-hint is-error">{project.broken}</span>}
          </div>
          {/* 收起时只有这一行的两个动作：最常做的，其余都在展开之后。 */}
          {!expanded && (
            <div className="build-project-actions">
              <button type="button" className={btnPrimary} disabled={busy || !!project.broken} onClick={() => void workshop.resume(project.dir)}>继续开发</button>
              <button type="button" className={btnSecondary} disabled={!selectable} onClick={() => onPreview(project.dir)}>预览</button>
            </div>
          )}
          {expanded && <>
            <ProjectDetail
              workshop={workshop}
              onPreview={() => onPreview(project.dir)}
              onResume={() => void workshop.resume(project.dir)}
            />
            {renaming?.dir === project.dir ? (
              <form className="build-rename" onSubmit={(event) => { event.preventDefault(); void commitRename(); }}>
                <label>显示名
                  <input value={renaming.name} onChange={(event) => setRenaming({ ...renaming, name: event.target.value })} maxLength={60} />
                </label>
                <label>目录名（= 工具 ID）
                  <input value={renaming.id} onChange={(event) => setRenaming({ ...renaming, id: event.target.value, note: undefined })} spellCheck={false} />
                </label>
                <div className="build-project-actions">
                  <button type="button" className={btnGhost} onClick={() => setRenaming(undefined)}>取消</button>
                  <button type="submit" className={btnPrimary} disabled={!renaming.name.trim() || !renaming.id.trim()}>保存</button>
                </div>
                {renaming.note && <span className="build-hint is-error">{renaming.note}</span>}
              </form>
            ) : confirming === project.dir ? (
              <div className="build-project-actions build-confirm">
                <span className="build-hint">删除会移除项目目录与工具数据，不可恢复。</span>
                <button type="button" className={btnGhost} onClick={() => setConfirming(undefined)}>取消</button>
                <DangerButton onClick={() => {
                  setConfirming(undefined);
                  void workshop.purge(project.id ?? project.dirName);
                }}>确认删除</DangerButton>
              </div>
            ) : (
              // 改名与删除是低频 + 破坏性动作，放在展开后的页脚，不占收起的行。
              <div className="build-project-footer">
                <button type="button" className={btnGhost} onClick={() => setRenaming({ dir: project.dir, name, id: project.id ?? project.dirName })}>改名</button>
                <button type="button" className={btnGhost} onClick={() => setConfirming(project.dir)}>删除</button>
              </div>
            )}
          </>}
        </li>;
      })}
    </ul>
  </>;
}
