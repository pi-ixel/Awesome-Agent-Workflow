import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { btnSecondary } from "../../../shared/ui/controls.tsx";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { HostService } from "../../host/service.ts";
import type { ProjectService } from "../../project/service.ts";
import type { ToolsService } from "../service.ts";
import { checkToolProject } from "../runtime/project.ts";
import type { ToolPackage, ToolViolation } from "../types.ts";
import { hostToolIO } from "../runtime/io.ts";
import { toolContentDiffers } from "./workshop.ts";
import { ToolPreview } from "./ToolPreview.tsx";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly tool: ToolPackage; readonly warnings: readonly ToolViolation[] }
  | { readonly kind: "broken"; readonly message: string; readonly blocking: readonly ToolViolation[] };

/**
 * 右栏里的工具预览：会话在中间，工具在右边，改完就能看。
 *
 * 为什么单独做成右栏标签而不是"把整个工具中心换成预览页"：验收是反复的
 * （改一句 → 看一眼），每看一次都要离开工具列表、再点回来，来回三次用户
 * 就不想验收了。做成标签后，预览与工具列表各占一个标签，会话始终在中间。
 *
 * 内容从磁盘读，而不是从安装记录读：这里看的是"项目现在长什么样"，不是
 * "装进去的那一版"。AI 一停下就自动重读一次——用户不需要再点"刷新"。
 */
export function ToolPreviewTab({ dir, host, project, tools, revision = 0 }: {
  dir: string;
  host: HostService;
  /** 用来监听"AI 停了"：同一工作区停下时自动重读。 */
  project?: ProjectService;
  /** 用来对比"预览的这一份"与"装进去的那一份"。 */
  tools?: ToolsService;
  revision?: number;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  /** 只在"内容真的变了"时才 +1，见下面 effect 里的比较。 */
  const [contentRevision, setContentRevision] = useState(0);
  const lastContent = useRef("");
  const installed = useSyncExternalStore(
    tools?.state.subscribe ?? (() => () => {}),
    tools?.state.getState ?? (() => [] as const),
  );

  const reread = () => setReloads((value) => value + 1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const check = await checkToolProject(hostToolIO(host), dir);
        if (cancelled) return;
        if (check.tool) {
          // AI 每次停下都会重读，但"重读"不等于"内容变了"。无脑换 iframe 会
          // 把用户在预览里正在输入的内容清掉；这里按版本 + 正文比对，没变就不动。
          const next = `${check.tool.version}\u0000${check.tool.html}`;
          if (next !== lastContent.current) {
            lastContent.current = next;
            setContentRevision((value) => value + 1);
          }
        }
        setState(check.tool
          ? { kind: "ready", tool: check.tool, warnings: check.warnings }
          : { kind: "broken", message: "这个项目现在读不出可预览的工具。", blocking: check.blocking });
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: "broken",
          message: error instanceof Error ? error.message : String(error),
          blocking: [],
        });
      }
    })();
    return () => { cancelled = true; };
  }, [dir, host, revision, reloads]);

  // AI 在这个项目里停下 → 内容可能变了，安静地重读一次。
  useEffect(() => {
    if (!project) return;
    const session = project.conversation.foreground.session;
    let running = session.getState().isAgentRunning;
    let activeId = session.getState().activeSessionId;
    return session.subscribe((next) => {
      // 切会话不是"停下"：新会话空闲不应该触发重读（会把 iframe 无谓换掉）。
      const switched = next.activeSessionId !== activeId;
      if (switched) activeId = next.activeSessionId;
      const stopped = running && !next.isAgentRunning && !switched;
      running = next.isAgentRunning;
      if (!stopped) return;
      const active = project.projects.workspace.getState().activePath;
      if (active && pathKey(active) === pathKey(dir)) setReloads((value) => value + 1);
    });
  }, [project, dir]);

  if (state.kind === "loading")
    return <p className="build-hint p-3">正在读取 {dir} …</p>;

  if (state.kind === "broken")
    return <div className="p-3">
      <p className="build-hint is-error">{state.message}</p>
      {state.blocking.length > 0 && <ul className="build-violations">
        {state.blocking.slice(0, 6).map((problem, index) => (
          <li key={index} className="is-block"><span>{problem.ruleId}</span>
            <div><strong>{problem.message}</strong><small>{problem.hint}</small></div>
          </li>
        ))}
      </ul>}
      <button type="button" className={btnSecondary} onClick={reread}>重新读取</button>
    </div>;

  const entry = installed.find((item) => item.package.id === state.tool.id);
  // 与工坊同一口径：版本、正文、动作、设置……任何影响行为的变化都算“没装最新”。
  const stale = !!entry && toolContentDiffers(entry.package, state.tool);

  return <div className="flex h-full min-h-0 flex-col">
    {/* 预览看的是磁盘，工具中心看的是快照：不说清楚，用户会以为已经装上了。 */}
    <p className="build-hint px-3 pt-2">
      {!entry
        ? "这是项目里的版本，还没安装——满意后回工具中心点「安装」。"
        : stale
          ? `预览的是项目最新内容；工具中心里还是 v${entry.package.version}，点「安装」才会更新。`
          : null}
    </p>
    {state.warnings.length > 0 && (
      <p className="build-hint px-3 pt-2">{state.warnings.length} 条建议（不影响运行），完整列表在「开发工具」里。</p>
    )}
    <div className="min-h-0 flex-1">
      <ToolPreview
        embedded
        tool={state.tool}
        revision={contentRevision}
        onReload={reread}
      />
    </div>
  </div>;
}
