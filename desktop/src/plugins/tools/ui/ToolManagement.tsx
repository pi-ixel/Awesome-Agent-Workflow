import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DangerButton, btnGhost, btnPrimary, btnSecondary, Listbox } from "../../../shared/ui/controls.tsx";
import { CopyButton } from "../../../shared/ui/CopyButton.tsx";
import { SquareTerminalIcon } from "../../../shared/ui/icons.tsx";
// 外观仍由 tools.css 决定（那份规则特异性更高），这里挂共享常量是为了让
// 「编辑框必须走共享规格」的架构守卫能识别到这几个输入框。
import { fieldSurfaceClass, settingsInputClass, settingsNumberInputClass } from "../../../shared/ui/inputStyles.ts";
import { UiIcon } from "../../../shared/ui/UiIcon.tsx";
import type { PersonalTool, ToolSettings } from "../types.ts";
import { readToolCarrier } from "../types.ts";
import { resolveToolSettings } from "../runtime/settings.ts";
import { toolProjectFiles } from "../runtime/projectArchive.ts";
import { toolGlyph, toneOf } from "./mark.ts";
import { ToolPath } from "./ToolPath.tsx";

type SectionKey = "settings" | "source" | "actions" | "info" | "remove";

/**
 * 插件管理页：可折叠的分组设置，不再是一整页说明书。
 *
 * 之前五节全铺开，右栏 360px 时点开「管理」像翻一整页文档，找「导出源码」
 * 要滚半天。现在每节只留一行标题，点一下才展开；默认只展开最常用的
 * 「自定义设置」。标题上带摘要徽标（几项设置 / 几个动作 / 导出几个文件），
 * 收起时也能判断里面有没有自己要找的东西，不用逐个点开确认。
 *
 * 这里只是统一的**展示壳**：设置项、动作、权限、作者都来自工具包 manifest，
 * 安装时间与来源目录来自宿主记录，新增插件不需要为管理页写任何专属 UI。
 * 文件清单也不再写死：直接问导出器 toolProjectFiles 要，界面说导出什么，
 * ZIP 里就真的有什么。
 */
function Section({ id, title, description, badge, flag, open, onToggle, children, last = false }: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly badge?: ReactNode;
  readonly flag?: ReactNode;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
  readonly last?: boolean;
}) {
  return <section className={`mg-section${open ? " is-open" : ""}${last ? " is-last" : ""}`} aria-labelledby={`${id}-title`}>
    <button type="button" className="mg-section-head" aria-expanded={open} aria-controls={`${id}-panel`} onClick={onToggle}>
      <span className="mg-section-title">
        <span className="mg-section-title-line">
          <span className="mg-section-name" id={`${id}-title`} role="heading" aria-level={3}>{title}</span>
          {badge}
          {flag}
        </span>
        <span className="mg-section-desc">{description}</span>
      </span>
      <span className="mg-chevron" aria-hidden="true">
        <UiIcon viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3.5 10.5 8 6 12.5" />
        </UiIcon>
      </span>
    </button>
    <div className="mg-panel" id={`${id}-panel`} hidden={!open}>{children}</div>
  </section>;
}

/** 载体对用户的一句话说明。「Electron 独立窗口」那种说法随 P3 一起作废了。 */
const CARRIER_LABEL = {
  L1: "独立窗口（单个 HTML 页面）",
  L2: "独立窗口（带构建产物）",
  L3: "独立窗口 + 自带的工具进程",
} as const;

export function ToolManagement({ entry, onBack, onOpen, onExport, onUpdate, onSave, onRemove, onRollback, busy, feedback }: {
  entry: PersonalTool; onBack: () => void; onOpen: () => void; onExport: () => void; onUpdate: (file: File) => void;
  onSave: (values: ToolSettings) => boolean; onRemove: () => void; onRollback?: () => void; busy: boolean;
  feedback?: { text: string; error?: true };
}) {
  const tool = entry.package;
  const [values, setValues] = useState<ToolSettings>(() => resolveToolSettings(tool, entry.settings));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pending, setPending] = useState<{ label: string; confirmLabel: string; run: () => void }>();
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({ settings: true, source: false, actions: false, info: false, remove: false });
  const continueEditing = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(values) !== JSON.stringify(resolveToolSettings(tool, entry.settings));
  const fields = tool.settingsSchema ?? [];
  // 界面上的文件清单 = 导出 ZIP 的真实内容。写死四个名字会撒谎（例如随手记
  // 根本没有 AGENTS.md），也会在导出器增删脚手架时悄悄过期。
  const archiveFiles = useMemo(() => {
    const names = Object.keys(toolProjectFiles(tool));
    const core = ["manifest.json", "index.html"];
    return [...core.filter((name) => names.includes(name)), ...names.filter((name) => !core.includes(name)).sort()];
  }, [tool]);
  useEffect(() => { if (pending) continueEditing.current?.focus(); }, [pending]);
  function requestAction(label: string, run: () => void, confirmLabel = "放弃修改并继续") {
    if (dirty) setPending({ label, run, confirmLabel });
    else run();
  }
  function toggle(key: SectionKey) {
    setOpen((current) => ({ ...current, [key]: !current[key] }));
  }
  return <section aria-label={`${tool.name} 管理`} className="aaw-tools tool-management flex h-full min-h-0 flex-col bg-base">
    <header className="management-nav"><button type="button" className={btnGhost} onClick={() => requestAction("返回工具中心", onBack, "放弃修改并返回")}>← 返回工具中心</button><span>插件管理</span></header>
    <div className="management-scroll">
      <div className="management-inner">
        <div className="management-hero">
          <span aria-hidden="true" className={`management-icon tone-${toneOf(tool.id)}`}>{toolGlyph(tool)}</span>
          <div className="management-hero-copy"><h2>{tool.name}</h2><p>v{tool.version} <span>·</span> 个人插件{tool.author ? ` · ${tool.author}` : ""}</p></div>
          <button type="button" className={btnPrimary} onClick={onOpen} disabled={busy}>打开插件 ↗</button>
        </div>
        {feedback && <p className={`management-feedback ${feedback.error ? "is-error" : ""}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
        {pending && <div className="management-feedback" role="alert"><p>还有未保存的设置，继续{pending.label}将放弃这些修改。</p><div className="mg-actions"><button ref={continueEditing} type="button" className={btnSecondary} onClick={() => setPending(undefined)}>继续编辑</button><DangerButton onClick={() => { setPending(undefined); pending.run(); }}>{pending.confirmLabel}</DangerButton></div></div>}

        <div className="mg-sections">
          <Section id="settings" title="自定义设置" description="按你的使用习惯调整这个插件" badge={<span className="mg-badge">{fields.length} 项</span>}
            flag={dirty ? <span className="mg-dirty">● 未保存</span> : undefined} open={open.settings} onToggle={() => toggle("settings")}>
            <div className="mg-content">
              {fields.length ? <form onSubmit={(event) => { event.preventDefault(); onSave(values); }}>
                <div className="mg-fields">{fields.map((field) => <div className={`mg-field ${field.type === "boolean" ? "is-toggle" : ""}`} key={field.id}>
                  <label htmlFor={`setting-${field.id}`}>{field.label}{field.description && <small>{field.description}</small>}</label>
                  {field.type === "boolean" ? <input id={`setting-${field.id}`} type="checkbox" role="switch" checked={values[field.id] === true} onChange={(event) => setValues({ ...values, [field.id]: event.target.checked })} />
                    : field.type === "select" ? <Listbox label={field.label} value={String(values[field.id])} options={field.options} onChange={(value) => setValues({ ...values, [field.id]: value })} fullWidth className="py-2 text-sm" />
                    : <input id={`setting-${field.id}`} type={field.type === "number" ? "number" : "text"} className={field.type === "number" ? settingsNumberInputClass : settingsInputClass} value={Number.isNaN(values[field.id]) ? "" : String(values[field.id] ?? "")}
                      min={field.type === "number" ? field.min : undefined} max={field.type === "number" ? field.max : undefined} step={field.type === "number" ? "any" : undefined} maxLength={field.type === "text" ? 4096 : undefined}
                      onChange={(event) => setValues({ ...values, [field.id]: field.type === "number" ? event.target.value === "" ? NaN : Number(event.target.value) : event.target.value })} />}
                </div>)}</div>
                <div className="mg-form-footer"><span>{dirty ? "有未保存的修改" : "保存后，重新打开插件生效"}</span><div className="mg-actions"><button type="button" className={btnGhost} onClick={() => setValues(resolveToolSettings(tool))}>恢复默认</button><button type="submit" className={btnPrimary} disabled={!dirty}>保存设置</button></div></div>
              </form> : <p className="mg-empty">此插件暂未提供自定义设置。作者添加设置项后，它们会自动出现在这里。</p>}
            </div>
          </Section>

          <Section id="source" title="源码与开发" description="导出完整源码，交给你或 AI 继续开发" badge={<span className="mg-badge">{archiveFiles.length} 个文件</span>}
            open={open.source} onToggle={() => toggle("source")}>
            <div className="mg-content">
              <div className="mg-files">{archiveFiles.slice(0, 6).map((name) => <code key={name}>{name}</code>)}{archiveFiles.length > 6 && <span>+ 另外 {archiveFiles.length - 6} 个文件</span>}</div>
              <div className="mg-actions"><button type="button" className={btnSecondary} onClick={onExport} disabled={busy}>导出源码 ZIP</button><button type="button" className={btnGhost} onClick={() => picker.current?.click()} disabled={busy}>更新源码</button>{entry.previousVersion && onRollback && <button type="button" className={btnGhost} disabled={busy} onClick={() => {
                // 退版会让设置表单按上一版的 schema 重挂载：没保存的草稿会没。
                // 与「更新源码」「返回」走同一个放弃确认，别让退版成为唯一的例外。
                const rollback = onRollback;
                requestAction("退回上一版", rollback, "放弃修改并退回");
              }}>退回上一版 v{entry.previousVersion}</button>}</div>
              <p className="mg-note">导出的是可直接导入的源码包：不需要 Node、不需要构建；要装回去时在工具中心点「导入工具」选中这个 ZIP。不包含你的个人设置。</p>
              {entry.sourceDir && <div className="mg-source-dir">
                <p className="mg-note">这一版是从下面的开发目录装进来的，装的是一份快照。在那里改完内容要回工具中心点一次「安装」才会生效——已安装的工具不会跟着目录自动变。</p>
                <ToolPath path={entry.sourceDir} compact />
              </div>}
              <input ref={picker} type="file" className={fieldSurfaceClass} accept=".zip,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) requestAction("更新源码", () => onUpdate(file)); }} />
            </div>
          </Section>

          <Section id="actions" title="AI 动作" description="你和 AI 走的是同一个函数" badge={<span className="mg-badge">{tool.actions?.length ?? 0} 个</span>}
            open={open.actions} onToggle={() => toggle("actions")}>
            <div className="mg-content">
              {tool.actions?.length ? <ul className="mg-actions-list">{tool.actions.map((action) => {
                // 以前这里显示 `aaw-tools run <工具> <动作>`——那是个随 Electron 一起
                // 删掉的命令行入口。现在 AI 走宿主的能力通道（`tool_act`），没有一个
                // 用户能自己在终端敲的等价命令；继续显示它会让人去安装目录找一个
                // 不存在的文件，所以只标出"动作 id"，复制它用于跟作者对话。
                return <li key={action.id} className="mg-action">
                  <div className="mg-action-head"><code>{action.id}</code><CopyButton getText={() => `${tool.id}.${action.id}`} label="复制动作 ID" /></div>
                  <p>{action.description}</p>
                </li>;
              })}</ul> : <p className="mg-empty">此插件暂未声明动作。声明 actions 后，AI 就能调用与界面按钮同一个函数。</p>}
              {!!tool.actions?.length && <p className="mg-note">AI 通过宿主的 <code>tool_act</code> 调用这些动作：同一个工具、同一个函数，和你点的按钮走同一条链。参数与返回值上限 512 KB，20 秒内返回，重复调用结果相同。</p>}
            </div>
          </Section>

          <Section id="info" title="插件信息" description="运行能力与标识" open={open.info} onToggle={() => toggle("info")}>
            <div className="mg-content">
              <dl className="mg-meta">
                <div><dt>插件 ID</dt><dd><code>{tool.id}</code></dd></div>
                <div><dt>运行方式</dt><dd>{CARRIER_LABEL[readToolCarrier(tool)]}</dd></div>
                <div><dt>运行能力</dt><dd>{tool.permissions?.network ? "会联网（http/https）" : "仅本地，不联网"}</dd></div>
                <div><dt>AI 接口</dt><dd><SquareTerminalIcon className="ui-icon-14" />{tool.actions?.length ? `${tool.actions.length} 个动作` : "暂未声明"}</dd></div>
                {tool.author && <div><dt>作者</dt><dd>{tool.author}</dd></div>}
                {tool.source && <div><dt>来源</dt><dd className="mg-source">{tool.source}</dd></div>}
                {entry.installedAt && <div><dt>安装于</dt><dd>{new Date(entry.installedAt).toLocaleString("zh-CN")}</dd></div>}
                {entry.updatedAt && <div><dt>最近更新</dt><dd>{new Date(entry.updatedAt).toLocaleString("zh-CN")}{entry.previousVersion ? `（上一版 v${entry.previousVersion}）` : ""}</dd></div>}
              </dl>
            </div>
          </Section>

          <Section id="remove" title="卸载插件" description="移除本账号中的插件与设置，可先导出源码保留项目" open={open.remove} onToggle={() => toggle("remove")} last>
            <div className="mg-content mg-remove">{confirmRemove ? <div className="mg-actions"><button type="button" className={btnGhost} onClick={() => setConfirmRemove(false)}>取消</button><DangerButton onClick={onRemove}>确认卸载</DangerButton></div> : <button type="button" className={`${btnGhost} remove-button`} onClick={() => setConfirmRemove(true)}>卸载</button>}</div>
          </Section>
        </div>
      </div>
    </div>
  </section>;
}
