import './ui.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { createApp, defineComponent } from 'vue'
import { VueFlow, Handle } from '@vue-flow/core'
import { contributions } from './contributions.js'
import { AawClient } from './ui-client.js'
import { projectStatusToGraph, stateLabel, type GraphProjection, type StatusPayload } from './graph.js'
import type { Workspace } from './contract.js'

declare const BUNDLE_VERSION: string
declare const UI_STYLES: string

export const version = BUNDLE_VERSION
export { contributions }

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
      busy: false,
      error: '',
      showStart: false,
      startError: '',
      form: { entry: 'sr', sr: '', requirement: '', varsText: '' },
      refreshTimer: null as ReturnType<typeof setInterval> | null,
      stateLabel,
    }
  },
  computed: {
    workspaceOptions(): Workspace[] {
      return this.workspaces
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
    guard(action: () => Promise<void>, errorKey: 'error' | 'startError' = 'error'): Promise<void> {
      if (this.busy) return Promise.resolve()
      this.busy = true
      if (errorKey === 'startError') this.startError = ''
      else this.error = ''
      return action()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (errorKey === 'startError') this.startError = message
          else this.error = message
        })
        .finally(() => {
          this.busy = false
        })
    },
    refreshAll() {
      return this.guard(async () => {
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
        }
      })
    },
    selectSr(sr: string) {
      this.sr = sr
      return this.refreshStatus()
    },
    refreshStatus() {
      if (!this.sr || !this.workspaceId) return Promise.resolve()
      return this.guard(async () => {
        const { status } = await this.client!.call<{ status: StatusPayload }>('srs.status', {
          workspaceId: this.workspaceId,
          sr: this.sr,
        })
        this.projection = projectStatusToGraph(status)
      })
    },
    async addWorkspace() {
      const path = window.prompt('工作区 repo 的绝对路径：')
      if (!path) return
      const aawCommand = window.prompt('AAW CLI 命令（空格分隔；例如 python D:\\dev\\...\\aaw.py）：', 'aaw')
      if (aawCommand === null) return
      await this.guard(async () => {
        await this.client!.call('workspace.add', { path, aawCommand: aawCommand.trim() ? aawCommand.trim().split(/\s+/) : [] })
        await this.refreshAllDirect()
      })
    },
    async refreshAllDirect() {
      const listed = await this.client!.call<{ workspaces: Workspace[] }>('workspace.list')
      this.workspaces = listed.workspaces
      if (!this.workspaceId && this.workspaces.length > 0) this.workspaceId = this.workspaces[0]!.id
      if (this.workspaceId) {
        const { srs } = await this.client!.call<{ srs: string[] }>('srs.list', { workspaceId: this.workspaceId })
        this.srs = srs
      }
    },
    submitStart() {
      this.startError = ''
      const vars: Record<string, string> = {}
      for (const line of this.form.varsText.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) {
          this.startError = `变量行格式应为 key=value：${trimmed}`
          return
        }
        vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1)
      }
      const sr = this.form.sr.trim() || undefined
      const requirement = this.form.entry === 'sr' ? this.form.requirement : undefined
      this.guard(async () => {
        const { started } = await this.client!.call<{ started: Record<string, unknown> }>('srs.start', {
          workspaceId: this.workspaceId,
          entry: this.form.entry,
          sr,
          vars: Object.keys(vars).length ? vars : undefined,
          requirement,
        })
        this.showStart = false
        this.form = { entry: 'sr', sr: '', requirement: '', varsText: '' }
        const newSr = typeof started['sr'] === 'string' ? (started['sr'] as string) : ''
        const { srs } = await this.client!.call<{ srs: string[] }>('srs.list', { workspaceId: this.workspaceId })
        this.srs = srs
        if (newSr && srs.includes(newSr)) await this.selectSr(newSr)
      }, 'startError')
    },
  },
  template: `
    <div class="aaw-app">
      <header class="aaw-bar">
        <b>AAW 工作流</b>
        <span v-if="!workspaces.length" class="aaw-empty">尚未登记工作区</span>
        <select v-else v-model="workspaceId">
          <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.path }}</option>
        </select>
        <button type="button" @click="addWorkspace">登记工作区…</button>
        <button type="button" :disabled="busy" @click="refreshAll">刷新</button>
        <button type="button" @click="showStart = !showStart">新建工作流</button>
        <span v-if="error" class="aaw-error">{{ error }}</span>
      </header>

      <div v-if="showStart" class="aaw-start">
        <label>入口
          <select v-model="form.entry">
            <option value="sr">sr（完整流程，需需求文本）</option>
            <option value="dev">dev（个人轻量）</option>
            <option value="ar">ar（AR 快速通道）</option>
          </select>
        </label>
        <label>SR 编号<input v-model="form.sr" placeholder="SR-001（可留空自动生成）"></label>
        <label v-if="form.entry === 'sr'">原始需求<textarea v-model="form.requirement" placeholder="粘贴原始需求文本…"></textarea></label>
        <label v-else>变量（每行 key=value）<textarea v-model="form.varsText" placeholder="AR=AR-001&#10;TITLE=用户管理"></textarea></label>
        <div class="aaw-start__actions">
          <button type="button" :disabled="busy" @click="submitStart">创建</button>
          <button type="button" @click="showStart = false">取消</button>
        </div>
        <span v-if="startError" class="aaw-error">{{ startError }}</span>
      </div>

      <div class="aaw-main">
        <aside class="aaw-side">
          <div class="aaw-side__head"><span>SR 列表</span><button type="button" :disabled="busy" @click="refreshAll">↻</button></div>
          <button v-for="s in srs" :key="s" type="button" class="aaw-sr" :class="{ active: s === sr }" @click="selectSr(s)">{{ s }}</button>
          <p v-if="!srs.length" class="aaw-empty">暂无 SR</p>
        </aside>

        <section class="aaw-graph">
          <div v-if="projection" class="aaw-summary">
            <span class="aaw-chip">{{ projection.summary.sr }}</span>
            <span class="aaw-chip">entry: {{ projection.summary.entry }}</span>
            <span class="aaw-chip">{{ projection.summary.workflowStatus }}</span>
            <span class="aaw-chip st-done">完成 {{ projection.summary.counts.done }}/{{ projection.summary.total }}</span>
            <span v-if="projection.summary.counts.running" class="aaw-chip st-running">进行中 {{ projection.summary.counts.running }}</span>
            <span v-if="projection.summary.counts.failed" class="aaw-chip st-failed">失败 {{ projection.summary.counts.failed }}</span>
            <div v-if="projection.summary.pendingConfirmNames.length" class="aaw-confirm-banner">
              等待用户确认：step {{ sr }} → {{ projection.summary.pendingConfirmNames.join('、') }}（请在与 Agent 的对话中确认）
            </div>
            <div v-if="projection.summary.driftMessage" class="aaw-drift">{{ projection.summary.driftMessage }}</div>
          </div>

          <VueFlow
            v-if="projection && projection.nodes.length"
            class="aaw-canvas"
            :nodes="projection.nodes"
            :edges="projection.edges"
            :fit-view-on-init="true"
            :nodes-connectable="false"
            :edges-updatable="false"
          >
            <template #node-aaw-step="p">
              <div class="aaw-node" :class="'is-' + p.data.state">
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
