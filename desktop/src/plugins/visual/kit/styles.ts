/**
 * 讲解图套件样式。两条渲染路径共用同一份：
 * - 内联路径（Shadow DOM）：`:host` 把 --v-* 映射到应用语义 token，主题切换随继承自动生效；
 * - 沙箱路径（iframe）：宿主把 --v-* 解析成具体值写进 `:root`，换肤时再推送。
 *
 * Agent 只接触 --v-* 与 tone 属性，不接触应用 token 名，应用 token 改名不影响已生成的图。
 */

/** 套件变量 → 应用 token。 */
export const visualTokenSources: Readonly<Record<string, string>> = {
  "--v-ink": "--color-ink",
  "--v-ink-soft": "--color-ink-soft",
  "--v-mute": "--color-ink-mute",
  "--v-faint": "--color-ink-faint",
  "--v-line": "--color-line",
  "--v-surface": "--color-surface",
  "--v-raised": "--color-raised",
  "--v-base": "--color-base",
  "--v-accent": "--color-accent-ink",
  "--v-good": "--color-ok-ink",
  "--v-warn": "--color-warn-ink",
  "--v-bad": "--color-danger-ink",
  // 应用状态色的底 / 描边，只作推导原料（见 .v-root 的 --v-*-bg / -line）
  "--v-src-accent-bg": "--color-info-bg",
  "--v-src-accent-line": "--color-info-line",
  "--v-src-good-bg": "--color-ok-bg",
  "--v-src-good-line": "--color-ok-line",
  "--v-src-warn-bg": "--color-warn-bg",
  "--v-src-warn-line": "--color-warn-line",
  "--v-src-bad-bg": "--color-danger-bg",
  "--v-src-bad-line": "--color-danger-line",
  "--v-c1": "--color-usage-series-1",
  "--v-c2": "--color-usage-series-2",
  "--v-c3": "--color-usage-series-3",
  "--v-c4": "--color-usage-series-4",
  "--v-c5": "--color-usage-series-5",
  "--v-c6": "--color-usage-series-6",
};

/** 内联路径的变量声明：直接引用应用 token。 */
export const visualHostTokensCss = `:host{${Object.entries(visualTokenSources)
  .map(([name, source]) => `${name}:var(${source});`)
  .join("")}}`;

/** 组件与基础元素样式（两条路径共用）。 */
export const visualKitCss = String.raw`
:host{display:block;container-type:inline-size;color:var(--v-ink);}
.v-root{
  /* 色调底 / 描边。亮色直接用应用调好的淡彩；暗色下应用的状态底色是为
     最底层设计的，放在卡片上比卡片还暗（像凹陷），这里在它的基础上混入
     色调文字色提亮：比卡片略亮、保留原有饱和度，warn / bad 的橙红可分 */
  --v-accent-bg:light-dark(var(--v-src-accent-bg),color-mix(in srgb,var(--v-accent) 16%,var(--v-src-accent-bg)));
  --v-accent-line:light-dark(var(--v-src-accent-line),color-mix(in srgb,var(--v-accent) 30%,var(--v-src-accent-line)));
  --v-good-bg:light-dark(var(--v-src-good-bg),color-mix(in srgb,var(--v-good) 16%,var(--v-src-good-bg)));
  --v-good-line:light-dark(var(--v-src-good-line),color-mix(in srgb,var(--v-good) 30%,var(--v-src-good-line)));
  --v-warn-bg:light-dark(var(--v-src-warn-bg),color-mix(in srgb,var(--v-warn) 16%,var(--v-src-warn-bg)));
  --v-warn-line:light-dark(var(--v-src-warn-line),color-mix(in srgb,var(--v-warn) 30%,var(--v-src-warn-line)));
  --v-bad-bg:light-dark(var(--v-src-bad-bg),color-mix(in srgb,var(--v-bad) 16%,var(--v-src-bad-bg)));
  --v-bad-line:light-dark(var(--v-src-bad-line),color-mix(in srgb,var(--v-bad) 30%,var(--v-src-bad-line)));
  --v-tint:color-mix(in srgb,var(--v-ink) 3%,transparent);
  --v-edge:color-mix(in srgb,var(--v-line) 80%,transparent);
  --v-tone:var(--v-ink);
  --v-radius:12px;
  box-sizing:border-box;padding:16px;color:var(--v-ink);line-height:1.55;
  overflow-wrap:break-word;
}
.v-root *,.v-root *::before,.v-root *::after{box-sizing:border-box;}
.v-root>:first-child{margin-top:0;}
.v-root>:last-child{margin-bottom:0;}
[tone=accent]{--v-tint:var(--v-accent-bg);--v-edge:var(--v-accent-line);--v-tone:var(--v-accent);}
[tone=good]{--v-tint:var(--v-good-bg);--v-edge:var(--v-good-line);--v-tone:var(--v-good);}
[tone=warn]{--v-tint:var(--v-warn-bg);--v-edge:var(--v-warn-line);--v-tone:var(--v-warn);}
[tone=bad]{--v-tint:var(--v-bad-bg);--v-edge:var(--v-bad-line);--v-tone:var(--v-bad);}
[tone=muted]{--v-tint:transparent;--v-edge:var(--v-line);--v-tone:var(--v-mute);}

v-row{display:flex;align-items:stretch;gap:12px;}
v-row>*{flex:1 1 0;min-width:0;}
/* 横排箭头最小等宽：结构相同的多行按列对齐；长标签可放宽到 11em，避免断词 */
v-row>v-arrow{flex:0 0 auto;min-width:8em;max-width:11em;}
v-row>v-arrow:not(:has(>.v-label)){min-width:5em;}
v-row>v-tag,v-row>v-icon{flex:0 0 auto;}
v-row:not(:has(>:not(v-tag))){flex-wrap:wrap;justify-content:center;gap:6px;}
v-row[data-stack]>v-tag{align-self:center;}
v-row[data-stack]{flex-direction:column;}
v-col{display:flex;flex-direction:column;align-items:stretch;gap:8px;}
v-grid{display:grid;gap:8px;grid-template-columns:repeat(var(--v-cols,3),minmax(0,1fr));align-items:stretch;}
v-row,v-col,v-grid{margin:0 0 12px;}
v-row:last-child,v-col:last-child,v-grid:last-child{margin-bottom:0;}
v-box v-row,v-box v-col,v-box v-grid{margin:0;}

v-box{display:flex;flex-direction:column;gap:10px;padding:14px;min-width:0;
  border:1px solid var(--v-edge);border-radius:var(--v-radius);background:var(--v-tint);}
v-box>.v-head{display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center;}
v-box>.v-head>.v-title{font-weight:600;font-size:1.08em;color:var(--v-ink);}
v-box>.v-head>.v-sub{font-size:.88em;color:var(--v-mute);}
v-box[tone]>.v-head>.v-title{color:var(--v-tone);}
v-box>v-box{background:color-mix(in srgb,var(--v-surface) 70%,transparent);}

v-item{display:flex;align-items:center;gap:10px;padding:9px 12px;min-width:0;text-align:left;
  border:1px solid var(--v-edge);border-radius:8px;background:color-mix(in srgb,var(--v-surface) 75%,transparent);}
v-item[tone]{background:var(--v-tint);}
/* 色调方框里的普通条目：同色调的极淡底，与方框融为一体，不像灰色补丁 */
v-box[tone]:not([tone=muted]) v-item:not([tone]){background:color-mix(in srgb,var(--v-tone) 6%,var(--v-surface));}
v-item>.v-glyph{flex:none;display:inline-flex;color:var(--v-tone);}
v-item>.v-glyph svg{width:1.3em;height:1.3em;}
v-item>.v-body{display:flex;flex-direction:column;min-width:0;flex:1;}
v-item>.v-body>.v-title{color:var(--v-ink);}
v-item[tone]>.v-body>.v-title{color:var(--v-tone);}
v-item>.v-body>.v-sub{font-size:.86em;color:var(--v-mute);}
v-item[center]{justify-content:center;text-align:center;}
v-item[center]>.v-body{flex:none;align-items:center;}

v-arrow{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  min-width:56px;color:var(--v-faint);font-size:.86em;}
v-arrow[tone]{color:var(--v-tone);}
v-arrow>.v-label{color:var(--v-mute);text-align:center;line-height:1.3;}
v-arrow[tone]>.v-label{color:var(--v-tone);}
v-arrow>svg{overflow:visible;}
v-arrow>.v-h{width:48px;height:16px;}
v-arrow>.v-v{display:none;width:16px;height:32px;}
v-arrow[data-axis=y]>.v-h,v-row[data-stack]>v-arrow>.v-h{display:none;}
v-arrow[data-axis=y]>.v-v,v-row[data-stack]>v-arrow>.v-v{display:block;}
/* 竖向箭头（含横排改竖排后）：三列网格，箭头固定在中线，标签在左列靠右，
   标签长短不影响箭头位置，上下多个箭头纵向对齐 */
v-arrow[data-axis=y],v-row[data-stack]>v-arrow{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);
  align-items:center;column-gap:8px;width:100%;min-width:0;max-width:none;min-height:36px;flex:none;}
v-arrow[data-axis=y]>svg,v-row[data-stack]>v-arrow>svg{grid-column:2;grid-row:1;}
v-arrow[data-axis=y]>.v-label,v-row[data-stack]>v-arrow>.v-label{grid-column:1;grid-row:1;justify-self:end;text-align:right;}


v-icon{display:inline-flex;align-items:center;justify-content:center;vertical-align:-.2em;color:var(--v-tone);}
v-icon>svg{width:1.25em;height:1.25em;}
v-icon[size=lg]>svg{width:2em;height:2em;}
v-icon[size=xl]>svg{width:2.8em;height:2.8em;}
v-box>v-grid{flex:1 1 auto;align-content:center;}
v-grid>v-icon{justify-self:center;padding:6px;border-radius:8px;border:1px solid var(--v-edge);background:color-mix(in srgb,var(--v-surface) 75%,transparent);}
v-grid>v-icon>svg{width:1.6em;height:1.6em;}

v-tag{display:inline-flex;align-items:center;gap:4px;padding:1px 9px;border-radius:999px;font-size:.86em;
  border:1px solid var(--v-edge);background:var(--v-tint);color:var(--v-tone);white-space:nowrap;}
v-box>v-tag,v-col>v-tag{align-self:center;}
v-text{display:block;color:var(--v-ink-soft);text-align:center;}
v-text[left]{text-align:left;}
v-note{display:block;margin-top:12px;text-align:center;font-weight:500;color:var(--v-tone);}
v-note:not([tone]){color:var(--v-ink-soft);}

v-tabs,v-steps{display:block;}
v-tabs>.v-bar{display:flex;flex-wrap:wrap;gap:2px;padding:2px;margin-bottom:12px;width:max-content;max-width:100%;
  border:1px solid var(--v-line);border-radius:8px;background:var(--v-tint);}
v-tabs>.v-bar>button{all:unset;cursor:pointer;padding:3px 12px;border-radius:6px;color:var(--v-mute);font-size:.92em;}
v-tabs>.v-bar>button:hover{color:var(--v-ink);}
v-tabs>.v-bar>button[aria-selected=true]{background:var(--v-surface);color:var(--v-ink);box-shadow:0 0 0 1px var(--v-line);}
v-tabs>.v-bar>button:focus-visible,v-steps>.v-nav>button:focus-visible{outline:2px solid var(--v-accent);outline-offset:1px;}
v-tab,v-step{display:block;}
v-tab[hidden],v-step[hidden]{display:none;}
v-steps>.v-nav{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;}
v-steps>.v-nav>button{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;border-radius:999px;border:1px solid var(--v-line);color:var(--v-ink-soft);}
v-steps>.v-nav>button:hover:not(:disabled){background:var(--v-tint);color:var(--v-ink);}
v-steps>.v-nav>button:disabled{opacity:.35;cursor:default;}
v-steps>.v-nav>button svg{width:16px;height:16px;}
v-steps>.v-nav>.v-progress{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;text-align:center;}
v-steps>.v-nav .v-step-label{color:var(--v-ink-soft);font-size:.92em;}
v-steps>.v-nav .v-dots{display:flex;gap:5px;}
v-steps>.v-nav .v-dots>i{width:6px;height:6px;border-radius:999px;background:var(--v-line);}
v-steps>.v-nav .v-dots>i[data-on]{background:var(--v-accent);}

.v-root h1,.v-root h2,.v-root h3,.v-root h4{margin:0 0 8px;font-weight:600;line-height:1.35;}
.v-root h1{font-size:1.3em;}.v-root h2{font-size:1.18em;}.v-root h3{font-size:1.06em;}.v-root h4{font-size:1em;}
.v-root p{margin:0 0 8px;}
.v-root ul,.v-root ol{margin:0 0 8px;padding-left:1.4em;}
.v-root code{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:.9em;
  padding:1px 5px;border-radius:4px;background:var(--v-tint);}
.v-root table{border-collapse:collapse;width:100%;margin:0 0 8px;font-size:.94em;}
.v-root th,.v-root td{padding:6px 10px;border-bottom:1px solid var(--v-line);text-align:left;vertical-align:top;}
.v-root th{font-weight:600;color:var(--v-ink-soft);background:var(--v-tint);}
.v-root button:not(.v-kbtn){font:inherit;cursor:pointer;padding:4px 12px;border-radius:8px;
  border:1px solid var(--v-line);background:var(--v-surface);color:var(--v-ink);}
.v-root button:not(.v-kbtn):hover{background:var(--v-raised);}
.v-root input,.v-root select,.v-root textarea{font:inherit;color:inherit;accent-color:var(--v-accent);}
.v-root input[type=text],.v-root input[type=number],.v-root select,.v-root textarea{
  padding:3px 8px;border-radius:6px;border:1px solid var(--v-line);background:var(--v-surface);}
.v-root label{display:inline-flex;align-items:center;gap:8px;}
.v-root svg{max-width:100%;}
.v-root>svg,v-box>svg,v-col>svg,v-tab>svg,v-step>svg{display:block;margin-inline:auto;}
v-box>svg,v-col>svg{align-self:center;}
.v-root svg text:not([fill]){fill:var(--v-ink);}
.v-root svg text{font-family:inherit;}
.v-root a{color:var(--v-accent);text-decoration:none;}
.v-root a:hover{text-decoration:underline;}
.v-root hr{border:0;border-top:1px solid var(--v-line);margin:12px 0;}

@container (max-width:520px){
  v-grid{grid-template-columns:repeat(min(var(--v-cols,3),3),minmax(0,1fr));}
}
@media (prefers-reduced-motion:no-preference){
  v-tab:not([hidden]),v-step:not([hidden]){animation:v-fade .18s ease;}
  @keyframes v-fade{from{opacity:0;transform:translateY(2px);}to{opacity:1;transform:none;}}
}
`;
