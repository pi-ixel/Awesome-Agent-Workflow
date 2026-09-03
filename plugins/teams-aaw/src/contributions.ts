export interface SlotContribution {
  id: string
  slot: 'navigation' | 'page' | 'settings' | 'command'
  title: string
  href?: string
  command?: string
}

export const bundleId = 'aaw-workflow'

/**
 * Single source of truth for the manifest contributions: pack.ts imports this
 * array so manifest.json on disk always matches what ui.js registers.
 * The host rejects bundles missing any of the four slot kinds.
 */
export const contributions: SlotContribution[] = [
  { id: 'aaw-nav', slot: 'navigation', title: 'AAW 工作流', href: '/plugins/aaw-workflow' },
  { id: 'aaw-page', slot: 'page', title: 'AAW 工作流' },
  { id: 'aaw-settings', slot: 'settings', title: 'AAW 设置' },
  { id: 'aaw-command', slot: 'command', title: 'AAW 插件状态', command: 'aaw-workflow.status' },
]
