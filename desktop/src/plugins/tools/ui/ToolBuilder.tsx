import { useStore } from "zustand";
import { btnGhost, btnPrimary, btnSecondary } from "../../../shared/ui/controls.tsx";
import { CopyButton } from "../../../shared/ui/CopyButton.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
// 工具面板的输入框外观由 tools.css 提供（那份规则特异性更高），这里挂上共享
// 样式常量是为了让「编辑框必须走共享规格」的架构守卫能识别到它们。
import { settingsTextareaClass } from "../../../shared/ui/inputStyles.ts";
import { describeViolations } from "../runtime/rules.ts";
import type { ToolViolation } from "../types.ts";
import { ToolPath } from "./ToolPath.tsx";
import type { WorkshopService } from "./workshop.ts";

export function ViolationList({ problems }: { problems: readonly ToolViolation[] }) {
  if (!problems.length) return null;
  return <ul className="build-violations">
    {problems.map((problem, index) => (
      <li key={index} className={problem.level === "block" ? "is-block" : "is-warn"}>
        <span>{problem.ruleId}</span>
        <div><strong>{problem.message}</strong><small>{problem.hint}</small></div>
      </li>
    ))}
  </ul>;
}

/**
 * 开发工具表单：需求描述 + 落在哪。
 *
 * 刻意做成一行而不是半屏卡片——用户打开工具中心的第一诉求通常是"用某个
 * 工具"，不是"再做一个"。需求可以写得很细（功能、界面、边界），所以这里
 * 不再用"一句话"暗示只能随手写一句。
 *
 * 目录只有一处：列表头部的「根目录」。以前这里还有一个「选择目录」，
 * 于是"选目录"和"改根目录"成了两个概念，而列表只扫根目录——建在别处的
 * 项目做完就从列表里消失了。同一个概念只留一个入口。
 */
export function NewToolForm({ workshop, available }: {
  workshop: WorkshopService;
  available: boolean;
}) {
  const { brief, busy, note, project, projectsRoot, customRoot } = useStore(workshop.state);
  // 与列表头部同一个口径：自定义根目录优先。两个地方显示不同路径等于骗人。
  const root = customRoot ?? projectsRoot;
  return <section aria-label="开发工具表单" className="build-new">
    <form onSubmit={(event) => { event.preventDefault(); void workshop.create(); }}>
      <label className="build-new-label" htmlFor="tool-brief">描述你要的工具</label>
      <textarea
        id="tool-brief"
        className={settingsTextareaClass}
        aria-label="描述你要的工具"
        value={brief}
        placeholder="描述你要的工具：功能、界面、边界都可以写清楚。例如：把接口返回的 JSON 转成表格，还能导出 Markdown"
        onChange={(event) => workshop.setBrief(event.target.value)}
        spellCheck={false}
        // 三行：右栏 360px 时两行连占位提示都放不下，用户看不到自己写的是
        // 不是被截断了。仍然可以往下拉。
        rows={3}
        disabled={!available || busy}
      />
      <div className="build-new-row">
        {/* 目录只展示不打开：它是「源码会落在哪」的答案，完整路径可复制。 */}
        <span className="build-target"><span className="build-target-label">目录</span>
          {root ? <ToolPath path={root} compact /> : <code>默认位置</code>}
        </span>
        <button type="submit" className={btnPrimary} disabled={!available || busy || !brief.trim()}>
          {busy ? "正在建项目…" : "开始做"}
        </button>
      </div>
      {!available && <p className="build-hint">需要桌面版并登录后才能建项目。</p>}
      {/* 有展开的项目时，结论在那一行里：说"AI 没修好"的话不该长在新建表单下面。 */}
      {note && !project && <p className={`build-hint ${note.error ? "is-error" : ""}`} aria-live="polite">{note.text}</p>}
    </form>
  </section>;
}

/**
 * 展开后的项目详情：状态 / 路径 / 校验结论 / 验收动作。
 *
 * 以前这是一个独立的浮动卡片（`ActiveProjectCard`），和列表里的同一项目
 * 并排出现——同一个东西两套动作、两个刷新时机，用户得先判断"我该在哪
 * 操作"。现在它只是列表某一行的展开内容：收起即消失，不会再挂着。
 */
export function ProjectDetail({ workshop, onPreview, onResume }: {
  workshop: WorkshopService;
  onPreview: () => void;
  onResume: () => void;
}) {
  const snapshot = useStore(workshop.state);
  const project = snapshot.project;
  if (!project) return null;
  const check = snapshot.check;
  const problems = check ? [...check.blocking, ...check.warnings] : [];
  const status = snapshot.missing
    ? "已失效"
    : snapshot.running
      ? "AI 正在写…"
      : check?.ready
        ? "可以验收"
        : check
          ? "待修复"
          // 没读出来要看得出是"失败"还是"还没读"：后者等一会儿就好，
          // 前者再等也不会变。
          : snapshot.note?.error ? "读取失败" : "读取中…";
  const statusTone = snapshot.missing
    ? "is-missing"
    : snapshot.running || check?.ready
      ? snapshot.running ? "is-running" : "is-ready"
      : "is-pending";

  return <div className="build-project-body">
    <div className="build-detail-head">
      <ToolPath path={project.dir} label="源码位置" />
      <span className={`build-status ${statusTone}`}>{status}</span>
    </div>

    {/* 提示条自己带关闭：一条不再成立的提示不该靠下一次操作才消失。 */}
    {snapshot.note && <p className={`build-note ${snapshot.note.error ? "is-error" : ""}`} aria-live="polite">
      <span>{snapshot.note.text}</span>
      <IconButton className="build-note-close" aria-label="关闭提示" iconSize="compact" onClick={() => workshop.clearNote()}>×</IconButton>
    </p>}

    {snapshot.missing ? <div className="build-stalled" role="group" aria-label="项目目录不在了">
      <div>
        <strong>这个项目的目录已经不在了</strong>
        <p>可能被移动、改名或删除了。把目录放回根目录后刷新列表；如果确实不要了，从工作台移除（不会删任何文件）。</p>
      </div>
      <div className="build-stalled-actions">
        <button type="button" className={btnSecondary} onClick={() => void workshop.refreshProjects()}>刷新列表</button>
        <button type="button" className={btnGhost} onClick={() => workshop.dismiss()}>从工作台移除</button>
      </div>
    </div> : <>
      {snapshot.stalled && (
        <div className="build-stalled" role="group" aria-label="需要你接手">
          <div>
            <strong>按这个路径自己改</strong>
            <p>目录里的 index.html 与 manifest.json 就是源码，直接改；改完点「我改完了，重新校验」。路径右侧的按钮可复制完整路径。</p>
            <ToolPath path={project.dir} label="源码目录" />
          </div>
          <div className="build-stalled-actions">
            <button type="button" className={btnPrimary} onClick={() => void workshop.verify()}>我改完了，重新校验</button>
          </div>
        </div>
      )}
        {/* AI 正在写的时候不列旧的校验问题：新建项目的第一秒必然报「html 必填」，
            这时把它摆成红字，用户会以为出错了，其实只是还没写完。 */}
      {check && !snapshot.running && <>
        <ViolationList problems={check.blocking} />
        <ViolationList problems={check.warnings} />
      </>}
      {check && snapshot.running && check.blocking.length > 0 && (
        <p className="build-hint">AI 正在写，写完后会自动校验（现在这 {check.blocking.length} 条是上一轮留下的）。</p>
      )}
      {/* 装进去的是快照：改了项目却没重装，打开工具看到的还是旧版。
          这条提示和下面的按钮必须成对出现——只说不动手，用户会去别处找按钮。 */}
      {snapshot.drift && (
        <p className="build-hint">{check?.ready
          ? "项目里的内容跟已安装的那一版不一样了——点「更新到这一版」把内容装进去，否则打开工具看到的还是旧的。"
          : "项目改过了，但这一版还有必须修的问题——修完再点「更新到这一版」。"}</p>
      )}
      <div className="build-active-actions">
        {/* 权重给「确认安装」：这一页存在的意义就是把项目变成能用的工具，
            打包出货才是主操作；「继续开发」是回到会话里的次级入口。
            disabled 不再挂 `check`：清单读不出来的时候，正是要回去让 AI 修
            的时候——按钮灰掉等于把唯一出口也关上了。 */}
        <button type="button" className={btnSecondary} disabled={snapshot.busy} onClick={onResume}>继续开发</button>
        <button type="button" className={btnSecondary} onClick={onPreview} disabled={snapshot.busy}>预览</button>
        {/* 交接块里已经有「我改完了，重新校验」，这里就不再重复一个同名动作。
            没有校验结论（还在读 / 读失败）时也要有这一条：否则整块只剩灰按钮。 */}
        {!snapshot.stalled && (problems.length > 0 || !check) && (
          <button type="button" className={btnSecondary} onClick={() => void workshop.verify()} disabled={snapshot.busy}>重新校验</button>
        )}
        {/* 文案一直说"把问题复制给 AI"，却只有一段不能一键复制的列表——这里补上按钮。 */}
        {problems.length > 0 && (
          <CopyButton
            tone="soft"
            label="复制问题给 AI"
            getText={() => describeViolations([...check!.blocking, ...check!.warnings])}
          />
        )}
        {/* 已安装且内容一致 = 这里没有可出货的东西，给个状态说明就够；
            内容变了（drift）必须还能再装一次，否则提示条指向一个不存在的按钮。 */}
        {snapshot.installed && !snapshot.drift
          ? <span className="build-hint">已安装到工具中心</span>
          : <button type="button" className={btnPrimary} onClick={() => void workshop.install()} disabled={!check?.ready}>
            {snapshot.drift ? "更新到这一版" : "确认安装"}
          </button>}
      </div>
    </>}
  </div>;
}
