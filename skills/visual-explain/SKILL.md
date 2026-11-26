---
name: visual-explain
description: 在 AAW Desktop 会话回答里用 ```visual 代码块画讲解图（分层结构、组件关系、数据流、方案对比、分步过程、可调参数的小演示），应用会直接渲染成统一风格的图。凡是打算用 ASCII/文本字符画示意图、分层图、框图或对比图时，都改用本 skill；解释系统结构、组件关系、数据去向、方案对比或抽象概念时优先使用。纯流程图、时序图、状态图用 Mermaid。
---

# 讲解图（```visual）

在回答正文里写一个 ```visual 代码块，内容是 HTML 片段，AAW Desktop 会把它渲染成卡片式讲解图。不需要调用工具。

## 什么时候画

- 画：结构与边界（谁在哪、谁能看见谁）、数据或请求经过哪些环节、两三种方案/场景对比、分步发生的过程、需要拖动参数才能体会的关系。
- 不画：一句话或一个短列表就能说清；代码、命令、配置本身；只是把正文换个形式重复一遍。
- 标准流程图 / 时序图 / 状态图 / ER 图：用 ```mermaid，不用本 skill。
- 一张图只回答一个问题；图前用一句话说明看什么，图后只补图里表达不了的结论。

## 怎么写

只写片段（不要 `<html>`、`<head>`、`<body>`），优先用套件标签，样式、配色、深浅主题、窄屏换行都由应用负责：

| 标签 | 用途 | 常用属性 |
|---|---|---|
| `v-row` / `v-col` | 横排 / 竖排（横排放不下时自动变竖排，不用自己判断宽度） | — |
| `v-grid` | 网格 | `cols="4"`，`repeat="12"`（把第一个子元素复制到 12 个） |
| `v-box` | 区域、系统、阶段 | `title` `sub` `tone` |
| `v-item` | 区域里的一行条目（文件、服务、步骤） | `icon` `title` `sub` `tone` `center`；也可直接写文字 |
| `v-arrow` | 相邻元素之间的箭头，方向按所在容器自动判断 | `label`，`dir="down/up/left/both"` |
| `v-icon` | 线性图标 | `name` `size="lg/xl"` `tone` |
| `v-tag` | 小标签 | `tone` |
| `v-text` / `v-note` | 说明文字 / 底部结论句 | `tone`（v-note） |
| `v-tabs` > `v-tab` | 切换视角对比 | `label`，`active` |
| `v-steps` > `v-step` | 上一步 / 下一步分步讲解 | `label` |

- `tone`：`accent`（重点/我方）、`good`（正常/可见/安全）、`warn`（注意/中间产物）、`bad`（风险/不可见）、`muted`。只用来表达含义，不为装饰上色。
- 图标 `name`：file file-text folder database server monitor laptop phone cloud user users lock unlock key shield globe network cpu disk zip mail message code terminal settings bot search check x alert info clock chart layers box link download upload play eye bug zap branch list image。
- 箭头放在两个相邻元素之间即可，不写坐标。

普通 HTML 也会自动套用风格：`h3`、`p`、`table`、`code`、`ul`、`button`、`input`。需要自定义颜色时只用变量：`var(--v-ink)` `var(--v-mute)` `var(--v-line)` `var(--v-accent)` `var(--v-good)` `var(--v-warn)` `var(--v-bad)`，图表系列色 `var(--v-c1)` 到 `var(--v-c6)`。不要写具体色值、字体、`vh` 单位。

自绘 SVG：`<svg viewBox="0 0 680 240">`，viewBox 宽度就是显示宽度（窄屏自动等比缩小，不会放大），按 680 左右设计，文字字号 13–14。连线上的节点（圆、方块）用 `fill="var(--v-surface)"` 盖住线，节点里的文字才不会被线穿过；`<text>` 写了 `fill` 就按它着色，不写默认正文色。

## 交互

- 切换、分步优先用 `v-tabs`、`v-steps`，不用写脚本。
- 需要计算或联动时（滑块调参数、点选高亮）直接写 `<script>`，用原生 DOM API；图会进沙箱运行，不能联网、不能加载外部库、不能访问本机。脚本放在片段末尾。

## 示例

结构对比：

```visual
<v-row>
  <v-box title="我们的存储系统" tone="accent">
    <v-grid cols="4" repeat="8"><v-icon name="file"></v-icon></v-grid>
    <v-item tone="good" center>审计：源文件 READ</v-item>
  </v-box>
  <v-arrow label="读取"></v-arrow>
  <v-box title="客户端">
    <v-item center>压缩程序</v-item>
    <v-arrow></v-arrow>
    <v-item icon="zip" tone="warn" center>ZIP（本地磁盘）</v-item>
  </v-box>
</v-row>
<v-note tone="good">存储侧可见读取，不可见本地压缩包写入</v-note>
```

分步过程：

```visual
<v-steps>
  <v-step label="收集"><v-row><v-item icon="folder" title="多个目录"></v-item><v-arrow label="复制"></v-arrow><v-item icon="server" title="暂存服务器"></v-item></v-row></v-step>
  <v-step label="外传"><v-row><v-item icon="zip" title="archive.7z" tone="warn"></v-item><v-arrow label="HTTPS"></v-arrow><v-item icon="cloud" title="外部网盘" tone="bad"></v-item></v-row></v-step>
</v-steps>
```

可调参数：

```visual
<p><label>压缩率 <input type="range" id="r" min="10" max="90" value="60"> <b id="o"></b></label></p>
<v-row><v-box title="原始"><v-text>100 GB</v-text></v-box><v-arrow label="压缩"></v-arrow><v-box title="外传体积" tone="warn"><v-text id="p"></v-text></v-box></v-row>
<script>
  const r = document.getElementById("r");
  const update = () => { o.textContent = r.value + "%"; p.textContent = (100 * (1 - r.value / 100)).toFixed(0) + " GB"; };
  r.addEventListener("input", update); update();
</script>
```
