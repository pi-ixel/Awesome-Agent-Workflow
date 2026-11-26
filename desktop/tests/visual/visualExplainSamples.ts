/** 讲解图实测样例：覆盖套件组件、自由 HTML/SVG 与带脚本交互三类写法。 */

export const storageSample = `<v-row>
  <v-box title="我们的存储系统" tone="accent">
    <v-grid cols="4" repeat="12"><v-icon name="file"></v-icon></v-grid>
    <v-text>1000 份业务文件</v-text>
    <v-item tone="good" center>审计：源文件 READ</v-item>
  </v-box>
  <v-arrow label="读取"></v-arrow>
  <v-box title="客户端">
    <v-item center>压缩程序</v-item>
    <v-arrow></v-arrow>
    <v-item icon="zip" tone="warn" center>ZIP</v-item>
    <v-text>本地磁盘</v-text>
  </v-box>
</v-row>
<v-note tone="good">存储侧可见读取，不可见本地压缩包写入</v-note>`;

export const virtualizationSample = `<v-row>
  <v-item icon="monitor" title="业务服务器" sub="虚拟机 A" center></v-item>
  <v-item icon="database" title="数据库服务器" sub="虚拟机 B" center></v-item>
  <v-item icon="mail" title="邮件服务器" sub="虚拟机 C" center></v-item>
</v-row>
<v-col>
  <v-arrow></v-arrow>
  <v-box title="VMware ESXi 虚拟化平台" sub="管理虚拟机及其磁盘 I/O"></v-box>
  <v-arrow label="NFSv3 / NFSv4.1"></v-arrow>
  <v-box title="我们的存储系统" tone="accent">
    <v-item icon="disk" title="app-flat.vmdk" sub="业务服务器磁盘"></v-item>
    <v-item icon="disk" title="database-flat.vmdk" sub="数据库服务器磁盘"></v-item>
    <v-item icon="disk" title="mail-flat.vmdk" sub="邮件服务器磁盘"></v-item>
    <v-item icon="shield" title="数据泄露检测" sub="采集 NFS 文件操作审计" tone="good"></v-item>
  </v-box>
</v-col>`;

export const tabsSample = `<v-tabs>
  <v-tab label="办公文件存储">
    <v-row>
      <v-box title="审计粒度" sub="单个文件"><v-tag tone="good">可还原到具体文档</v-tag></v-box>
      <v-box title="典型操作" sub="打开 / 读取 / 写回"><v-tag>低频、离散</v-tag></v-box>
    </v-row>
  </v-tab>
  <v-tab label="虚拟化存储">
    <v-row>
      <v-box title="审计粒度" sub="整块虚拟磁盘"><v-tag tone="warn">看不到盘内文件</v-tag></v-box>
      <v-box title="典型操作" sub="持续块级读写"><v-tag tone="bad">高频、连续</v-tag></v-box>
    </v-row>
  </v-tab>
</v-tabs>`;

export const stepsSample = `<v-steps>
  <v-step label="收集">
    <v-row><v-item icon="folder" title="多个目录" center></v-item><v-arrow label="复制"></v-arrow><v-item icon="server" title="暂存服务器" center></v-item></v-row>
  </v-step>
  <v-step label="归档">
    <v-row><v-item icon="server" title="暂存服务器" center></v-item><v-arrow label="压缩 + 加密"></v-arrow><v-item icon="zip" title="archive.7z" tone="warn" center></v-item></v-row>
  </v-step>
  <v-step label="外传">
    <v-row><v-item icon="zip" title="archive.7z" tone="warn" center></v-item><v-arrow label="HTTPS"></v-arrow><v-item icon="cloud" title="外部网盘" tone="bad" center></v-item></v-row>
  </v-step>
</v-steps>`;

export const svgChartSample = `<h3>受调查勒索入侵涉及虚拟化基础设施的比例</h3>
<svg viewBox="0 0 360 160" width="100%" role="img" aria-label="2024 年 29%，2025 年 43%">
  <line x1="40" y1="130" x2="340" y2="130" stroke="var(--v-line)"/>
  <rect x="80" y="${130 - 29 * 2.4}" width="70" height="${29 * 2.4}" rx="6" fill="var(--v-c1)"/>
  <rect x="220" y="${130 - 43 * 2.4}" width="70" height="${43 * 2.4}" rx="6" fill="var(--v-c4)"/>
  <text x="115" y="${130 - 29 * 2.4 - 8}" text-anchor="middle">29%</text>
  <text x="255" y="${130 - 43 * 2.4 - 8}" text-anchor="middle">43%</text>
  <text x="115" y="150" text-anchor="middle" fill="var(--v-mute)">2024</text>
  <text x="255" y="150" text-anchor="middle" fill="var(--v-mute)">2025</text>
</svg>
<v-note>比例统计的是攻击目标，不等于数据泄露事件占比</v-note>`;

export const scriptSample = `<h3>压缩率估算</h3>
<p><label>原始数据量 <input type="range" id="size" min="1" max="500" value="120"> <b id="sizeOut"></b></label></p>
<p><label>压缩率 <input type="range" id="ratio" min="10" max="90" value="60"> <b id="ratioOut"></b></label></p>
<v-row>
  <v-box title="原始"><v-text id="raw"></v-text></v-box>
  <v-arrow label="压缩"></v-arrow>
  <v-box title="外传体积" tone="warn"><v-text id="packed"></v-text></v-box>
</v-row>
<script>
  const size = document.getElementById("size");
  const ratio = document.getElementById("ratio");
  function update() {
    const gb = Number(size.value);
    const r = Number(ratio.value) / 100;
    document.getElementById("sizeOut").textContent = gb + " GB";
    document.getElementById("ratioOut").textContent = Math.round(r * 100) + "%";
    document.getElementById("raw").textContent = gb + " GB";
    document.getElementById("packed").textContent = (gb * (1 - r)).toFixed(1) + " GB";
  }
  size.addEventListener("input", update);
  ratio.addEventListener("input", update);
  update();
</script>`;

export const tableSample = `<table>
  <tr><th>ATT&amp;CK</th><th>行为</th><th>存储侧可见</th></tr>
  <tr><td><code>T1560</code></td><td>归档收集到的数据</td><td><v-tag tone="warn">部分</v-tag></td></tr>
  <tr><td><code>T1074.001</code></td><td>本地暂存</td><td><v-tag tone="bad">否</v-tag></td></tr>
  <tr><td><code>T1074.002</code></td><td>远程暂存</td><td><v-tag tone="good">是</v-tag></td></tr>
</table>`;

export const errorSample = `<v-text id="t">脚本报错时图标提示</v-text><script>missingFunction();</script>`;

/** 三栏都含条目、箭头带长标签：常规聊天宽度下应自动改竖排，避免逐字换行。 */
export const crowdedSample = `<v-row>
  <v-box title="桌面应用" sub="ACP Client" tone="accent">
    <v-item icon="monitor">spawn 子进程</v-item>
    <v-item icon="code" sub="带上 cwd 和 mcpServers 配置">session/new</v-item>
  </v-box>
  <v-arrow label="stdio · JSON-RPC"></v-arrow>
  <v-box title="Agent 子进程"><v-item icon="bot">返回 sessionId</v-item><v-item icon="link">按配置连接 MCP</v-item></v-box>
  <v-arrow label="stdio / HTTP"></v-arrow>
  <v-box title="MCP 服务器 ×N"><v-item icon="list" sub="把工具清单交给 Agent">tools/list</v-item></v-box>
</v-row>`;

export const visualSamples: readonly {
  readonly id: string;
  readonly code: string;
}[] = [
  { id: "storage", code: storageSample },
  { id: "virtualization", code: virtualizationSample },
  { id: "tabs", code: tabsSample },
  { id: "steps", code: stepsSample },
  { id: "svg", code: svgChartSample },
  { id: "script", code: scriptSample },
  { id: "table", code: tableSample },
  { id: "error", code: errorSample },
  { id: "crowded", code: crowdedSample },
];
