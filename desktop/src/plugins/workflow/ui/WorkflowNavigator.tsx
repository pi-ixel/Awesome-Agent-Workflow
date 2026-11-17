/**
 * 画布右上角的流程导航：这一层有几个阶段、各自走到哪，以及嵌在里面的子流程。
 *
 * 从前画布只有「能拖」：想知道整张图走到哪，得自己滚；想进第二层的子流程，
 * 得先找到那张卡。这里把同一份层级路径（flowPath.ts）摊开成一棵树：
 * 点阶段条什么也不做（它是读数），点树项直接换层 —— 根、L2、L3 都是一下。
 *
 * 尺寸不跟画布缩放走：它挂在 GraphCanvas 的浮层宿主上（canvasOverlay.ts）。
 */
import { useState } from "react";
import { ChevronRightIcon, FileTreeIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "../../../shared/ui/icons.tsx";
import { ghostButton } from "./buttons.ts";
import { STATE_LABEL, type NodeState } from "../status/snapshot.ts";
import type { FlowTreeStep } from "./flowPath.ts";

/** 导航里的一个阶段：名字 + 逐个节点的状态格子（用于分段进度条）。 */
export interface NavigatorStage {
  readonly id: string;
  readonly label: string;
  readonly tag: string;
  readonly active: boolean;
  readonly bars: readonly NodeState[];
}

export function WorkflowNavigator({ rootLabel, stages, tree, activePath, onJump, onJumpIndex }: {
  rootLabel: string;
  stages: readonly NavigatorStage[];
  /** 子流程树（根在一层，往下嵌套）。 */
  tree: readonly FlowTreeStep[];
  /** 当前路径上的 flow id，用来高亮「你在这」。 */
  activePath: readonly string[];
  /** 跳到某条层链（点树项）。 */
  onJump: (chain: readonly FlowTreeStep[]) => void;
  /** 回到路径上的第 index 层（点根 / 上级）。 */
  onJumpIndex: (index: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    return <div className="workflow-nav collapsed">
      <button type="button" className={ghostButton} aria-label="展开流程导航" aria-expanded={false} onClick={() => setCollapsed(false)} data-hint="展开流程导航"><PanelRightOpenIcon className="ui-icon-14" /></button>
    </div>;
  }
  const settled = stages.reduce((count, stage) => count + stage.bars.filter((state) => state === "done" || state === "done-findings" || state === "skipped").length, 0);
  const total = stages.reduce((count, stage) => count + stage.bars.length, 0);
  return <nav className="workflow-nav" aria-label="流程导航">
    <div className="top">
      <FileTreeIcon className="ui-icon-14" aria-hidden="true" />
      <b>流程导航</b>
      <button type="button" className={ghostButton} aria-label="收起流程导航" aria-expanded={true} onClick={() => setCollapsed(true)} data-hint="收起流程导航"><PanelRightCloseIcon className="ui-icon-14" /></button>
    </div>
    <div className="body">
      {stages.map((stage) => <div key={stage.id} className={`tile${stage.active ? " is-active" : ""}`}>
        <span className="row">
          <span>{stage.tag && <em>{stage.tag}</em>}{stage.label || rootLabel}</span>
          <span className="n">{stage.bars.filter((state) => state === "done" || state === "done-findings" || state === "skipped").length}/{stage.bars.length}</span>
        </span>
        <span className="bars" aria-hidden="true">{stage.bars.map((state, index) => <i key={index} className={`state-${state}`} data-hint={STATE_LABEL[state]} />)}</span>
      </div>)}
      {total > 0 && <p className="sum">这一层 {settled}/{total} 个节点已结束</p>}
      <div className="tree">
        <p className="cap">嵌套层级</p>
        <Tree items={tree} depth={0} activePath={activePath} trail={[]} onJump={onJump} onJumpIndex={onJumpIndex} />
      </div>
    </div>
  </nav>;
}

function Tree({ items, depth, activePath, trail, onJump, onJumpIndex }: {
  items: readonly FlowTreeStep[];
  depth: number;
  activePath: readonly string[];
  trail: readonly FlowTreeStep[];
  onJump: (chain: readonly FlowTreeStep[]) => void;
  onJumpIndex: (index: number) => void;
}) {
  return <ul className="items">
    {items.map((item) => {
      const chain = [...trail, item];
      const here = activePath[depth] === item.flow && chain.length === activePath.length;
      // 根层（depth 0）在路径里时用「回第 0 层」，子流程直接换整条链。
      const select = () => depth === 0 && activePath.length > 0 ? onJumpIndex(0) : onJump(chain);
      return <li key={item.flow}>
        <button type="button" className={`item${here ? " is-here" : ""}`} style={{ paddingLeft: 6 + depth * 12 }} aria-current={here ? "page" : undefined} onClick={select} data-hint={`进入「${item.label}」`}>
          {depth > 0 && <ChevronRightIcon className="ui-icon-12 branch" aria-hidden="true" />}
          <span className="nm">{item.label}</span>
          <span className="n">{item.stepCount}</span>
        </button>
        {item.children.length > 0 && <Tree items={item.children} depth={depth + 1} activePath={activePath} trail={chain} onJump={onJump} onJumpIndex={onJumpIndex} />}
      </li>;
    })}
  </ul>;
}
