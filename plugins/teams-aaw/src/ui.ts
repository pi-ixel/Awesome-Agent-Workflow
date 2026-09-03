import './ui.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { createApp, defineComponent } from 'vue'
import { VueFlow, Handle } from '@vue-flow/core'
import { contributions } from './contributions.js'
import { AawClient } from './ui-client.js'
import { projectStatusToGraph, stateLabel, type GraphProjection, type StatusPayload } from './graph.js'
import type { PlanEdge, PlanNode, Workspace } from './contract.js'

declare const BUNDLE_VERSION: string
declare const UI_STYLES: string

export const version = BUNDLE_VERSION
export { contributions }

const ENTRIES = [
  { value: 'sr', label: 'sr · 完整流程', needsRequirement: true, fields: [] as string[] },
  { value: 'dev', label: 'dev · 个人轻量', needsRequirement: false, fields: [] as string[] },
  { value: 'ar', label: 'ar · AR 快速通道', needsRequirement: false, fields: ['AR', 'TITLE'] },
] as const

const App = defineComponent({
  name: 'AawApp',
  components: { VueFlow, Handle },
  props: { bundleId: { type: String, required: true } },
  data() {
    return {
      client: null as AawClient | null,
      workspaces: [] as Workspace[],
      workspaceId: '',
      srs: [] as string[],
      sr: '',
      projection: null as GraphProjection | null,
      plan: null as { nodes: PlanNode[]; edges: PlanEdge[] } | null,
      busy: false,
      error: '',
      // workspace registration form (replaces the old window.prompt flow)
      showWorkspaceForm: false,
      wsForm: { path: '', interpreter: 'python', script: '' },
      wsError: '',
      // start-workflow form, fields depend on the entry
      showStart: false,
      startError: '',
      startForm: { entry: 'dev', sr: '', requirement: '', ar: '', title: '' },
      refreshTimer: null as ReturnType<typeof setInterval> | null,
      stateLabel,
    }
  },
  computed: {
    entries(): typeof ENTRIES {
      return ENTRIES
    },
    currentEntry() {
      return ENTRIES.find((item) => item.value === this.startForm.entry) ?? ENTRIES[0]!
    },
    /** Materialized steps + dashed template ghosts for the not-yet-generated tail. */
    graph(): { nodes: GraphProjection['nodes']; edges: GraphProjection['edges'] } {
      if (!this.projection) return { nodes: [], edges: [] }
      const nodes = [...this.projection.nodes]
      const edges = [...this.projection.edges]
      if (!this.plan || this.plan.nodes.length === 0) return { nodes, edges }

      const materializedTypes = new Set(nodes.map((node) => node.data.stepType))
      const ghosts = this.plan.nodes.filter((node) => !materializedTypes.has(node.id))
      if (ghosts.length === 0) return { nodes, edges }
      const ghostIds = new Set(ghosts.map((node) => node.id))

      // Longest-path depth over ghost-to-ghost plan edges; ghosts hanging off
      // the materialized frontier start at depth 0.
      const depth = new Map<string, number>()
      const ghostEdges = this.plan.edges.filter((edge) => ghostIds.has(edge.to))
      let changed = true
      while (changed) {
        changed = false
        for (const edge of ghostEdges) {
          const base = ghostIds.has(edge.from) ? (depth.get(edge.from) ?? -1) + 1 : 0
          if ((depth.get(edge.to) ?? -1) < base) {
            depth.set(edge.to, base)
            changed = true
          }
        }
      }

      const maxMatX = nodes.reduce((max, node) => Math.max(max, node.position.x), 0)
      const rowsPerDepth = new Map<number, number>()
      for (const ghost of ghosts) {
        const d = depth.get(ghost.id) ?? 0
        const row = rowsPerDepth.get(d) ?? 0
        rowsPerDepth.set(d, row + 1)
        const incoming = this.plan!.edges.find((edge) => edge.to === ghost.id)
        nodes.push({
          id: `tpl:${ghost.id}`,
          type: 'aaw-step',
          position: { x: maxMatX + 300 * (d + 1), y: 40 + row * 150 },
          draggable: true,
          data: {
            stepId: -1,
            name: ghost.name,
            stepType: ghost.id,
            execution: '',
            state: 'pending',
            attempt: 1,
            startedAt: null,
            endedAt: null,
            isTaskDev: false,
            taskDevPhase: null,
            pendingConfirm: false,
            ghost: true,
            isGate: ghost.is_gate,
            needConfirm: incoming?.user_confirm === 'must',
            edgeKind: incoming?.kind ?? 'direct',
          },
        })
      }

      for (const edge of this.plan.edges) {
        const label = edge.kind === 'foreach' ? 'foreach ×N' : edge.kind === 'choice' ? 'choice' : undefined
        if (ghostIds.has(edge.from) && ghostIds.has(edge.to)) {
          edges.push({
            id: `ge${edge.from}-${edge.to}`,
            source: `tpl:${edge.from}`,
            target: `tpl:${edge.to}`,
            animated: false,
            label,
            style: { stroke: '#94a3b8', strokeDasharray: '6 4' },
          })
        } else if (!ghostIds.has(edge.from) && ghostIds.has(edge.to)) {
          // Hand off from every materialized frontier instance of the source type.
          const outgoing = new Set(edges.map((item) => item.source))
          let sources = nodes.filter(
            (node) => !node.data.ghost && node.data.stepType === edge.from && !outgoing.has(node.id),
          )
          if (sources.length === 0) {
            sources = nodes.filter((node) => !node.data.ghost && node.data.stepType === edge.from)
          }
          for (const source of sources) {
            edges.push({
              id: `ge${source.id}-${edge.to}`,
              source: source.id,
              target: `tpl:${edge.to}`,
              animated: source.data.state === 'running',
              label,
              style: { stroke: '#94a3b8', strokeDasharray: '6 4' },
            })
          }
        }
      }
      return { nodes, edges }
    },
  },
  created() {
    this.client = new AawClient(this.bundleId)
  },
  mounted() {
    void this.refreshAll()
    // v1 keeps a light poll; the controlled plugin-events SSE route will replace it.
    this.refreshTimer = setInterval(() => void this.refreshStatus(), 15_000)
  },
  beforeUnmount() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
  },
  methods: {
    guard(action: () => Promise<void>, errorKey: 'error' | 'wsError' | 'startError' = 'error'): Promise<void> {
      if (this.busy) return Promise.resolve()
      this.busy = true
      if (errorKey === 'wsError') this.wsError = ''
      else if (errorKey === 'startError') this.startError = ''
      else this.error = ''
      return action()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (errorKey === 'wsError') this.wsError = message
          else if (errorKey === 'startError') this.startError = message
          else this.error = message
        })
        .finally(() => {
          this.busy = false
        })
    },
    refreshAll() {
      return this.guard(async () => {
        await this.reloadWorkspaces()
      })
    },
    async reloadWorkspaces() {
      const listed = await this.client!.call<{ workspaces: Workspace[] }>('workspace.list')
      this.workspaces = listed.workspaces
      if (!this.workspaceId && this.workspaces.length > 0) this.workspaceId = this.workspaces[0]!.id
      if (!this.workspaceId) return
      const { srs } = await this.client!.call<{ srs: string[] }>('srs.list', { workspaceId: this.workspaceId })
      this.srs = srs
      if (!this.sr && srs.length > 0) await this.selectSr(srs[0]!)
      if (this.sr && !srs.includes(this.sr)) {
        this.sr = ''
        this.projection = null
        this.plan = null
      }
    },
    onWorkspaceChange() {
      this.sr = ''
      this.projection = null
      this.plan = null
      void this.guard(async () => {
        await this.reloadWorkspaces()
      })
    },
    selectSr(sr: string) {
      this.sr = sr
      return this.refreshStatus()
    },
    refreshStatus() {
      if (!this.sr || !this.workspaceId) return Promise.resolve()
      return this.guard(async () => {
        const [statusResult, planResult] = await Promise.all([
          this.client!.call<{ status: StatusPayload }>('srs.status', { workspaceId: this.workspaceId, sr: this.sr }),
          this.client!.call<{ status: { nodes: PlanNode[]; edges: PlanEdge[] } }>('srs.plan', {
            workspaceId: this.workspaceId,
            sr: this.sr,
          }).catch(() => null),
        ])
        this.projection = projectStatusToGraph(statusResult.status)
        this.plan = planResult?.status ?? null
      })
    },
    submitWorkspace() {
      const path = this.wsForm.path.trim()
      const command = [this.wsForm.interpreter.trim(), this.wsForm.script.trim()].filter(Boolean)
      this.guard(async () => {
        await this.client!.call('workspace.add', { path, aawCommand: command })
        this.showWorkspaceForm = false
        this.wsForm = { path: '', interpreter: 'python', script: '' }
        this.workspaceId = ''
        await this.reloadWorkspaces()
      }, 'wsError')
    },
    submitStart() {
      const form = this.startForm
      const sr = form.sr.trim() || undefined
      const vars: Record<string, string> = {}
      if (form.entry === 'ar') {
        if (!form.ar.trim() || !form.title.trim()) {
          this.startError = 'ar 入口需要 AR 编号和标题'
          return
        }
        vars['AR'] = form.ar.trim()
        vars['TITLE'] = form.title.trim()
      }
      const requirement = this.currentEntry.needsRequirement ? form.requirement : undefined
      let createdSr = ''
      // NOTE: the follow-up select must run OUTSIDE the guard — guard() drops
      // re-entrant calls while busy, so the inner refresh would be lost.
      this.guard(async () => {
        const { started } = await this.client!.call<{ started: Record<string, unknown> }>('srs.start', {
          workspaceId: this.workspaceId,
          entry: form.entry,
          sr,
          vars: Object.keys(vars).length ? vars : undefined,
          requirement,
        })
        this.showStart = false
        this.startForm = { entry: form.entry, sr: '', requirement: '', ar: '', title: '' }
        createdSr = typeof started['sr'] === 'string' ? (started['sr'] as string) : ''
        const { srs } = await this.client!.call<{ srs: string[] }>('srs.list', { workspaceId: this.workspaceId })
        this.srs = srs
      }, 'startError').then(() => {
        if (createdSr && this.srs.includes(createdSr) && this.sr !== createdSr) void this.selectSr(createdSr)
      })
    },
  },
  template: `
    <div class="aaw-app">
      <header class="aaw-bar">
        <b>AAW 工作流</b>
        <span v-if="!workspaces.length" class="aaw-empty">尚未登记工作区</span>
        <select v-else v-model="workspaceId" @change="onWorkspaceChange">
          <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.path }}</option>
        </select>
        <button type="button" @click="showWorkspaceForm = !showWorkspaceForm">登记工作区…</button>
        <button type="button" :disabled="busy" @click="refreshAll">刷新</button>
        <button type="button" class="aaw-primary" :disabled="!workspaceId" @click="showStart = !showStart">新建工作流</button>
        <span v-if="error" class="aaw-error">{{ error }}</span>
      </header>

      <div v-if="showWorkspaceForm" class="aaw-form">
        <b>登记工作区</b>
        <label>仓库绝对路径<input v-model="wsForm.path" placeholder="D:\\dev\\my-project" @keydown.enter="submitWorkspace"></label>
        <label>AAW CLI 命令<input v-model="wsForm.interpreter" placeholder="python / aaw"></label>
        <label>aaw.py 路径（命令为 aaw 时留空）<input v-model="wsForm.script" placeholder="D:\\...\\skills\\aaw-workflow\\scripts\\aaw.py" @keydown.enter="submitWorkspace"></label>
        <div class="aaw-form__actions">
          <button type="button" class="aaw-primary" :disabled="busy || !wsForm.path.trim()" @click="submitWorkspace">登记</button>
          <button type="button" @click="showWorkspaceForm = false">取消</button>
          <span v-if="wsError" class="aaw-error">{{ wsError }}</span>
        </div>
        <p class="aaw-hint">登记时会真实调用一次 aaw status 做冒烟校验；工作区注册表保存在本机插件数据目录。</p>
      </div>

      <div v-if="showStart" class="aaw-form">
        <b>新建工作流</b>
        <label>入口
          <select v-model="startForm.entry">
            <option v-for="e in entries" :key="e.value" :value="e.value">{{ e.label }}</option>
          </select>
        </label>
        <label>SR 编号<input v-model="startForm.sr" placeholder="留空由 CLI 分配"></label>
        <template v-if="currentEntry.value === 'ar'">
          <label>AR 编号<input v-model="startForm.ar" placeholder="AR-001"></label>
          <label>标题<input v-model="startForm.title" placeholder="用户管理"></label>
        </template>
        <label v-if="currentEntry.needsRequirement" class="aaw-form__wide">原始需求<textarea v-model="startForm.requirement" placeholder="粘贴原始需求文本…（CLI 会原文保存为 original-requirement.md）"></textarea></label>
        <div class="aaw-form__actions">
          <button type="button" class="aaw-primary" :disabled="busy" @click="submitStart">创建</button>
          <button type="button" @click="showStart = false">取消</button>
          <span v-if="startError" class="aaw-error">{{ startError }}</span>
        </div>
        <p class="aaw-hint">创建后图谱立即出现；执行由 Chrys 驱动（对话中让它继续该 SR 即可），后续版本提供「创建并开始执行」。</p>
      </div>

      <div class="aaw-main">
        <aside class="aaw-side">
          <div class="aaw-side__head"><span>SR 列表</span><button type="button" :disabled="busy" @click="refreshAll">↻</button></div>
          <button v-for="s in srs" :key="s" type="button" class="aaw-sr" :class="{ active: s === sr }" @click="selectSr(s)">{{ s }}</button>
          <p v-if="!srs.length" class="aaw-empty">{{ workspaceId ? '暂无 SR' : '请先登记工作区' }}</p>
        </aside>

        <section class="aaw-graph">
          <div v-if="projection" class="aaw-summary">
            <span class="aaw-chip">{{ projection.summary.sr }}</span>
            <span class="aaw-chip">entry: {{ projection.summary.entry }}</span>
            <span class="aaw-chip">{{ projection.summary.workflowStatus }}</span>
            <span class="aaw-chip st-done">完成 {{ projection.summary.counts.done }}/{{ projection.summary.total }}</span>
            <span v-if="projection.summary.counts.running" class="aaw-chip st-running">进行中 {{ projection.summary.counts.running }}</span>
            <span v-if="projection.summary.counts.failed" class="aaw-chip st-failed">失败 {{ projection.summary.counts.failed }}</span>
            <span v-if="plan" class="aaw-chip st-ghost">规划 {{ plan.nodes.length }} 步 · 未生成 {{ graph.nodes.filter(n => n.data.ghost).length }}</span>
            <div v-if="projection.summary.pendingConfirmNames.length" class="aaw-confirm-banner">
              等待用户确认：step {{ sr }} → {{ projection.summary.pendingConfirmNames.join('、') }}（请在与 Agent 的对话中确认）
            </div>
            <div v-if="projection.summary.driftMessage" class="aaw-drift">{{ projection.summary.driftMessage }}</div>
          </div>

          <VueFlow
            v-if="graph.nodes.length"
            class="aaw-canvas"
            :nodes="graph.nodes"
            :edges="graph.edges"
            :fit-view-on-init="true"
            :nodes-connectable="false"
            :edges-updatable="false"
          >
            <template #node-aaw-step="p">
              <div v-if="p.data.ghost" class="aaw-node is-ghost">
                <Handle type="target" position="left" />
                <div class="aaw-node__head">{{ p.data.name }}</div>
                <div class="aaw-node__chips">
                  <span class="aaw-chip st-ghost">未生成</span>
                  <span v-if="p.data.isGate" class="aaw-chip st-blocked">门禁</span>
                  <span v-if="p.data.needConfirm" class="aaw-chip st-confirm">需确认</span>
                </div>
                <Handle type="source" position="right" />
              </div>
              <div v-else class="aaw-node" :class="'is-' + p.data.state">
                <Handle type="target" position="left" />
                <div class="aaw-node__head">#{{ p.data.stepId }} {{ p.data.name }}</div>
                <div class="aaw-node__chips">
                  <span class="aaw-chip">{{ p.data.stepType }}</span>
                  <span class="aaw-chip" :class="'st-' + p.data.state">{{ stateLabel(p.data.state) }}</span>
                  <span v-if="p.data.attempt > 1" class="aaw-chip st-retry">重跑 ×{{ p.data.attempt - 1 }}</span>
                  <span v-if="p.data.taskDevPhase" class="aaw-chip st-phase">{{ p.data.taskDevPhase }}</span>
                </div>
                <div v-if="p.data.pendingConfirm" class="aaw-node__confirm">等待用户确认</div>
                <Handle type="source" position="right" />
              </div>
            </template>
          </VueFlow>

          <div v-else class="aaw-empty aaw-graph__empty">
            {{ sr ? '正在加载工作流…' : '从左侧选择一个 SR 查看工作流图谱' }}
          </div>

          <footer v-if="graph.nodes.length" class="aaw-legend">
            <span>实线 = 已物化步骤</span><span>虚线 = 定义规划（随推进生成）</span><span>15s 自动刷新</span>
          </footer>
        </section>
      </div>
    </div>
  `,
})

/**
 * Full-height native page.  The shell calls this with
 * `mount(container, { bundleId, pageId, version })` and expects a cleanup
 * function back.  Styles live in a ShadowRoot so the plugin never leaks CSS
 * into (or from) the Vue shell.
 */
export function mount(container: HTMLElement, context?: { bundleId?: string }) {
  const host = document.createElement('div')
  host.style.cssText = 'height:100%;width:100%'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = UI_STYLES
  const appRoot = document.createElement('div')
  appRoot.className = 'aaw-root'
  shadow.append(style, appRoot)
  container.appendChild(host)

  const app = createApp(App, { bundleId: context?.bundleId || 'aaw-workflow' })
  app.mount(appRoot)
  return () => {
    app.unmount()
    host.remove()
  }
}

/** Cordis UI plugin: registers the slot contributions with the shell. */
export default function aawUi(_context: unknown, config: { register(value: unknown): () => void }) {
  return contributions.map(config.register)
}
