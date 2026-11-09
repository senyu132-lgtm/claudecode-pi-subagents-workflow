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
  // Workflows: how many of its agents failed
  failed: number
  // Tool calls over the agent's life (as of its last finished round), and when it last finished
  toolUses: number
  finishedAt: number
  // Workflows: the phase titles from meta, the current phase, and its agents
  phases: string[]
  phase: string
  kids: FlowChild[]
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
// A running agent's tool calls so far and its last few, for its transcript row
export type Activity = { tools: number; recent: { name: string; args: string }[]; now: string }

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
      expanded: boolean
      flowOn: boolean
      activity: Shaped<Record<string, Activity>>
      calls: Shaped<Record<string, string>>
    }
  }
}
