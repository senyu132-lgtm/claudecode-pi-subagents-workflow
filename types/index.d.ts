// State contract of the pi-subagents mod: the type of every value it keeps in $.state.
export type AgentRow = {
  id: string
  name: string
  alias: string
  provider: string
  model: string
  status: string
  task: string
  owner: string
  cwd: string
  createdAt: number
  updatedAt: number
  rounds: number
  lastError: string
  finalPreview: string
  // Workflows: kind is 'flow' and progress is a status line; agents inside a workflow have parent set
  kind: string
  progress: string
  parent: string
}

export type FlowChild = { index: number; label: string; phase: string; model: string; status: string; id: string; note: string }

export type ViewEntry = {
  t: number
  k: string
  from?: string
  mode?: string
  text?: string
  name?: string
  args?: string
  ok?: boolean
  ms?: number
  out?: string
  status?: string
  round?: number
  // workflow entries
  ev?: string
  label?: string
  id?: string
  model?: string
  code?: number
}

export type Live = { text: string; thinking: string; tool: string }

export type Detail = { id: string; entries: ViewEntry[]; live: Live; children: FlowChild[] }

declare module 'claude-code' {
  interface PluginState {
    'pi-subagents': {
      agents: Shaped<AgentRow[]>
      mine: Shaped<string[]>
      notified: Shaped<Record<string, number>>
      pending: Shaped<string[]>
      selected: string
      showAll: boolean
      detail: Shaped<Detail | null>
      notice: string
      sendCount: number
      flowOn: boolean
    }
  }
}
