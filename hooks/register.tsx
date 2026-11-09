// pi-subagents: run the pi coding agent as background agents that feel like Claude Code's native sub-agents.
// - Registers tools for the main agent: spawn / send / status / log / result / stop (deferred: only their
//   names sit in the ToolSearch list until used)
// - Dormant by default: no process and no polling at session start; it wakes on the first tool call, /pi,
//   or when the pi-subagents skill loads
// - When an agent finishes, only its final answer goes back to the main agent (the transcript stays out of
//   its context). Results that land close together are merged into one notification, and while the main
//   agent is busy they wait until its turn ends
// - The "pi sub-agents" pane (/pi): list, live transcript, and an input box to talk to an agent directly
// - pi workflows: the flow tool exists only after the user types /pi flow in that session; the pane shows
//   phases and every agent
// The real work happens in bin/pisub.mjs (one detached broker process per agent).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Detail, FlowChild, Live, ViewEntry } from '../types'

const P = 'pi-subagents'
const PANE = 'pi-subagents'
const toolName = (n: string) => `mcp__${P}__${n}`

const agentsA = atom({ plugin: 'pi-subagents', key: 'agents' } as const, [] as AgentRow[], { shape: 'agents-2' })
const mineA = atom({ plugin: 'pi-subagents', key: 'mine' } as const, [] as string[], { shape: 'mine-1' })
const notifiedA = atom({ plugin: 'pi-subagents', key: 'notified' } as const, {} as Record<string, number>, { shape: 'notified-1' })
// Agents that finished but have not been reported yet
const pendingA = atom({ plugin: 'pi-subagents', key: 'pending' } as const, [] as string[], { shape: 'pending-1' })
const selectedA = atom({ plugin: 'pi-subagents', key: 'selected' } as const, '')
const showAllA = atom({ plugin: 'pi-subagents', key: 'showAll' } as const, false)
const detailA = atom({ plugin: 'pi-subagents', key: 'detail' } as const, null as Detail | null, { shape: 'detail-2' })
const noticeA = atom({ plugin: 'pi-subagents', key: 'notice' } as const, '')
const sendCountA = atom({ plugin: 'pi-subagents', key: 'sendCount' } as const, 0)
// Whether the user turned workflows on in this session (/pi flow)
const flowOnA = atom({ plugin: 'pi-subagents', key: 'flowOn' } as const, false)

const TERMINAL = new Set(['done', 'error', 'stopped'])
const ICON: Record<string, string> = { starting: '◌', running: '●', retrying: '↻', waiting: '…', done: '✓', error: '✗', stopped: '■' }
const MAX_NOTIFY = 60000
const BATCH_MS = 3000 // wait this long after the last result so results that land together share one notification

type Ctx = { node: string; pisub: string; runs: string; sid: string; lang: string }
let ctx: Ctx | null = null
const cache = new Map<string, { mtime: number; row: AgentRow }>()
let detailSig = ''
let polling = false
let active = false // woken up in this session (only then do processes start and polling run)
let mainBusy = false // the main conversation is in the middle of a turn
let submitting = false
let lastAddedAt = 0

// Language follows pisub's setting ("language" in ~/.pi-subagents/config.json, or PISUB_LANG); English until known
const L = (en: string, zh: string) => (ctx?.lang === 'zh' ? zh : en)
const STATUS: Record<string, [string, string]> = {
  starting: ['starting', '启动中'],
  running: ['running', '运行中'],
  retrying: ['retrying', '重试中'],
  waiting: ['waiting to retry', '等待重试'],
  done: ['done', '完成'],
  error: ['error', '出错'],
  stopped: ['stopped', '已停止'],
}
const statusName = (s: string) => (STATUS[s] ? L(...STATUS[s]!) : s)
const title = () => L('pi sub-agents', 'pi 子代理')

async function activate($: EngineInterface) {
  if (active) return
  active = true
  try {
    await getCtx($)
    $.clock.every(1500, () => void poll($))
  } catch (err) {
    active = false
    throw err
  }
}

// ---------- talking to pisub ----------
async function getCtx($: EngineInterface): Promise<Ctx> {
  if (ctx) return ctx
  const pisub = `${$.plugin.root}/bin/pisub.mjs`
  const sid = await $.session.id()
  let node = 'node'
  const r = await $.process.run([node, pisub, 'paths'], { timeoutMs: 20000 })
  if (r.exitCode !== 0) throw new Error(`pisub failed to start: ${r.stderr || r.stdout}`)
  const paths = JSON.parse(r.stdout) as { runs: string; node: string; lang?: string }
  node = paths.node || node
  ctx = { node, pisub, runs: paths.runs, sid, lang: paths.lang === 'zh' ? 'zh' : 'en' }
  return ctx
}

async function pisub($: EngineInterface, args: string[], stdin?: string, timeoutMs = 60000) {
  const c = await getCtx($)
  const r = await $.process.run([c.node, c.pisub, ...args], { stdin, timeoutMs })
  return { ok: r.exitCode === 0, code: r.exitCode, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

function toRow(s: Record<string, unknown>): AgentRow {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const num = (v: unknown) => (typeof v === 'number' ? v : 0)
  return {
    id: str(s.id),
    name: str(s.name),
    alias: str(s.alias),
    provider: str(s.provider),
    model: str(s.model),
    status: str(s.status),
    task: str(s.task),
    owner: str(s.owner),
    cwd: str(s.cwd),
    createdAt: num(s.createdAt),
    updatedAt: num(s.updatedAt),
    rounds: num(s.rounds),
    lastError: str(s.lastError),
    finalPreview: str(s.finalPreview),
    kind: str(s.kind),
    progress: str(s.progress),
    parent: str(s.parent),
  }
}

function toChildren(v: unknown): FlowChild[] {
  if (!Array.isArray(v)) return []
  return v.map(x => {
    const c = (x || {}) as Record<string, unknown>
    const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '')
    return { index: typeof c.index === 'number' ? c.index : 0, label: s('label'), phase: s('phase'), model: s('model'), status: s('status'), id: s('id'), note: s('note') }
  })
}
// The "model" column in the pane and in notifications
const modelOf = (r: AgentRow) =>
  r.kind === 'flow' ? L('workflow', '工作流') : r.model ? (r.provider ? `${r.provider}/${r.model}` : r.model) : L('pi default', 'pi 默认')

async function loadRow($: EngineInterface, runs: string, id: string): Promise<AgentRow | null> {
  const file = `${runs}/${id}/state.json`
  try {
    const st = await $.fs.stat(file)
    const hit = cache.get(id)
    if (hit && hit.mtime === st.mtimeMs) return hit.row
    const row = toRow(JSON.parse(await $.fs.read(file)) as Record<string, unknown>)
    cache.set(id, { mtime: st.mtimeMs, row })
    return row
  } catch {
    return cache.get(id)?.row ?? null
  }
}

// ---------- polling: refresh the list and the detail view, send completion notices ----------
async function poll($: EngineInterface) {
  if (polling) return
  polling = true
  try {
    const c = await getCtx($)
    const mine = await read($, mineA)
    const showAll = await read($, showAllA)
    let ids = [...mine]
    if (showAll) {
      const ents = await $.fs.list(c.runs).catch(() => [])
      const all = ents.filter(x => x.kind === 'dir').map(x => x.name)
      const known = all.filter(id => cache.has(id))
      const unknown = all.filter(id => !cache.has(id))
      // Known ones: the newest 40 by creation time; unseen ones are read once
      known.sort((a, b) => (cache.get(b)!.row.createdAt || 0) - (cache.get(a)!.row.createdAt || 0))
      ids = [...new Set([...mine, ...known.slice(0, 40), ...unknown])]
    }
    const rows: AgentRow[] = []
    for (const id of ids) {
      const row = await loadRow($, c.runs, id)
      if (row) rows.push(row)
    }
    rows.sort((a, b) => b.createdAt - a.createdAt)
    // Workflow agents are shown under their workflow, not in the main list
    const shown = showAll ? rows.filter(r => !r.parent).slice(0, 40) : rows.filter(r => mine.includes(r.id))
    const before = await read($, agentsA)
    if (JSON.stringify(before) !== JSON.stringify(shown)) await update($, agentsA, () => shown)

    // Completion notices: only for agents this session started; queue first, then send merged
    const notified = await read($, notifiedA)
    for (const r of rows) {
      if (!mine.includes(r.id) || !TERMINAL.has(r.status)) continue
      if (r.rounds <= (notified[r.id] ?? 0)) continue
      await update($, notifiedA, m => ({ ...m, [r.id]: r.rounds }))
      await update($, pendingA, list => [...list.filter(x => x !== r.id), r.id])
      lastAddedAt = await $.clock.now()
    }
    await flushNotifications($, c)

    // Detail view
    const sel = await read($, selectedA)
    if (sel) await refreshDetail($, c, sel)
  } catch (err) {
    $.ui.log(`${P}: poll failed: ${String(err)}`, { to: 'debug' })
  } finally {
    polling = false
  }
}

async function flushNotifications($: EngineInterface, c: Ctx) {
  if (mainBusy || submitting) return
  const pending = await read($, pendingA)
  if (pending.length === 0) return
  if ((await $.clock.now()) - lastAddedAt < BATCH_MS) return
  const rows: AgentRow[] = []
  for (const id of pending) {
    const row = await loadRow($, c.runs, id)
    if (row) rows.push(row)
  }
  await update($, pendingA, list => list.filter(id => !pending.includes(id)))
  if (rows.length === 0) return
  const each = Math.max(4000, Math.floor(MAX_NOTIFY / rows.length))
  const blocks: string[] = []
  for (const r of rows) {
    const path = `${c.runs}/${r.id}/final.md`
    let final = ''
    try {
      final = await $.fs.read(path)
    } catch {
      final = r.finalPreview || L('(no final answer)', '（没有最终回答）')
    }
    if (final.length > each) final = final.slice(0, each) + L(`\n… (truncated; full text in ${path})`, `\n…（太长已截断，全文见 ${path}）`)
    blocks.push(
      `<pi-result id="${r.id}" model="${modelOf(r)}" round="${r.rounds}" status="${r.status}">\n${final.trim()}\n</pi-result>`,
    )
  }
  const head =
    rows.length === 1
      ? L(`${rows[0]!.id} round ${rows[0]!.rounds} ${statusName(rows[0]!.status)}`, `${rows[0]!.id} 第 ${rows[0]!.rounds} 轮${statusName(rows[0]!.status)}`)
      : L(
          `${rows.length} agents have new results: ${rows.map(r => `${r.name || r.id} (${statusName(r.status)})`).join(', ')}`,
          `${rows.length} 个代理有新结果：${rows.map(r => `${r.name || r.id}（${statusName(r.status)}）`).join('、')}`,
        )
  $.ui.toast(`${title()}: ${head}`)
  const text =
    L(
      `[pi sub-agent notification, not a user message] ${head}. Only the final answers are below; ` +
        `use ${toolName('log')} to see the transcript and ${toolName('send')} to add instructions (deferred tools: fetch them with ToolSearch first).\n`,
      `[pi 子代理自动通知，不是用户消息] ${head}。下面只有最终回答；` +
        `看过程用 ${toolName('log')}，追加要求用 ${toolName('send')}（按需加载的工具，先用 ToolSearch 取）。\n`,
    ) + blocks.join('\n')
  submitting = true
  try {
    await $.prompt.submit({ text })
  } catch (err) {
    // Not delivered: put them back and retry on the next poll
    await update($, pendingA, list => [...new Set([...rows.map(r => r.id), ...list])])
    $.ui.log(`${P}: notification not delivered: ${String(err)}`, { to: 'debug' })
  } finally {
    submitting = false
  }
}

function parseView(text: string, tail: number): ViewEntry[] {
  const lines = text.split('\n').filter(Boolean)
  const out: ViewEntry[] = []
  for (const l of lines.slice(-tail)) {
    try {
      out.push(JSON.parse(l) as ViewEntry)
    } catch {}
  }
  return out
}

async function refreshDetail($: EngineInterface, c: Ctx, id: string) {
  const dir = `${c.runs}/${id}`
  let vs = { mtimeMs: 0, size: 0 }
  let ls = { mtimeMs: 0 }
  try { vs = await $.fs.stat(`${dir}/view.jsonl`) } catch {}
  try { ls = await $.fs.stat(`${dir}/live.json`) } catch {}
  // The selection may be a workflow agent that is not in the list: read its state on its own
  const row = await loadRow($, c.runs, id)
  const sig = `${id}:${vs.mtimeMs}:${vs.size}:${ls.mtimeMs}:${row?.updatedAt ?? 0}`
  if (sig === detailSig) return
  detailSig = sig
  let children: FlowChild[] = []
  if (row?.kind === 'flow') {
    try { children = toChildren((JSON.parse(await $.fs.read(`${dir}/state.json`)) as Record<string, unknown>).children) } catch {}
  }
  let entries: ViewEntry[] = []
  if (vs.size > 3_500_000) {
    const r = await pisub($, ['log', id, '--json', '--tail', '300'])
    try { entries = JSON.parse(r.out) as ViewEntry[] } catch {}
  } else if (vs.size > 0) {
    try { entries = parseView(await $.fs.read(`${dir}/view.jsonl`), 300) } catch {}
  }
  let live: Live = { text: '', thinking: '', tool: '' }
  try {
    const l = JSON.parse(await $.fs.read(`${dir}/live.json`)) as Partial<Live>
    live = { text: l.text || '', thinking: l.thinking || '', tool: l.tool || '' }
  } catch {}
  await update($, detailA, () => ({ id, entries, live, children }))
}

// Adopt an agent started elsewhere (CLI, script, another session): its later results are reported here.
// onlyIfFinished: skip agents still running (a script is probably --wait-ing on them; avoids duplicate results).
async function adopt($: EngineInterface, id: string, onlyIfFinished = false) {
  if ((await read($, mineA)).includes(id)) return
  const c = await getCtx($)
  const row = await loadRow($, c.runs, id)
  if (onlyIfFinished && !(row && TERMINAL.has(row.status))) return
  await activate($)
  await update($, mineA, list => (list.includes(id) ? list : [...list, id]))
  await update($, notifiedA, m => ({ ...m, [id]: row?.rounds ?? 0 }))
}

async function select($: EngineInterface, id: string) {
  detailSig = ''
  await update($, selectedA, () => id)
  await update($, noticeA, () => '')
  if (!id) await update($, detailA, () => null)
  void poll($)
}

async function openPane($: EngineInterface, focus = false) {
  const r = await $.ui.open(focus ? { id: PANE, title: title(), focus: true } : { id: PANE, title: title() })
  if (!r.isPlaced) $.ui.log(`${P}: pane not shown: ${'reason' in r ? String(r.reason) : ''}`, { to: 'debug' })
}

// ---------- drawing helpers ----------
function cells(s: string) {
  let n = 0
  for (const ch of s) n += ch.codePointAt(0)! > 0x2e80 ? 2 : 1
  return n
}
function rowsOf(s: string, cols: number) {
  return s.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(cells(line) / Math.max(10, cols))), 0)
}
function cut(s: string | undefined, n: number) {
  const t = (s || '').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return L(`${s}s ago`, `${s}秒前`)
  if (s < 3600) return L(`${Math.round(s / 60)}m ago`, `${Math.round(s / 60)}分前`)
  if (s < 86400) return L(`${Math.round(s / 3600)}h ago`, `${Math.round(s / 3600)}小时前`)
  return L(`${Math.round(s / 86400)}d ago`, `${Math.round(s / 86400)}天前`)
}
type Line = { text: string; color?: string; dim?: boolean; bold?: boolean }
const CHILD_ICON: Record<string, string> = { running: '●', done: '✓', error: '✗', cached: '≡' }
function linesOf(e: ViewEntry): Line {
  switch (e.k) {
    case 'user': {
      const from: Record<string, string> = { claude: 'Claude', user: L('You', '你'), system: L('System', '系统') }
      const tag = `${from[e.from || ''] || e.from}${e.mode === 'steer' ? L('·steer', '·插话') : e.mode === 'follow_up' ? L('·follow-up', '·追加') : ''}`
      return { text: `${L(`[${tag}] `, `【${tag}】`)}${cut(e.text, 600)}`, bold: true }
    }
    case 'thinking':
      return { text: `${L('(thinking) ', '（思考）')}${cut(e.text, 200)}`, dim: true }
    case 'text':
      return { text: cut(e.text, 3000) }
    case 'tool':
      return { text: `→ ${e.name} ${cut(e.args, 160)}`, color: 'subtle' }
    case 'tool_end':
      return {
        text: `${e.ok ? '✓' : '✗'} ${e.name}${e.ms != null ? ` ${(e.ms / 1000).toFixed(1)}s` : ''}  ${cut((e.out || '').split('\n').slice(0, 2).join(' ⏎ '), 160)}`,
        color: e.ok ? undefined : 'error',
        dim: !!e.ok,
      }
    case 'error':
      return { text: `！${cut(e.text, 600)}`, color: 'error' }
    case 'retry':
      return { text: `↻ ${cut(e.text, 300)}`, color: 'warning' }
    case 'done':
      return {
        text: `──── ${L(`round ${e.round} ended: ${statusName(e.status || '')}`, `第 ${e.round} 轮结束：${statusName(e.status || '')}`)} ────`,
        color: e.status === 'done' ? 'success' : 'warning',
      }
    case 'phase':
      return { text: `══ ${L('phase', '阶段')}: ${e.text} ══`, bold: true }
    case 'agent': {
      const evs: Record<string, string> = { start: '▶', done: '✓', error: '✗', cached: L('≡ cached', '≡ 缓存'), retry: L('↻ resubmit', '↻ 重交') }
      const ev = evs[e.ev || ''] || e.ev
      return {
        text: `${ev} ${e.label} ${L(`(${e.model})`, `（${e.model}）`)}${e.text ? ': ' + cut(e.text, 200) : ''}`,
        color: e.ev === 'error' ? 'error' : e.ev === 'retry' ? 'warning' : undefined,
        dim: e.ev === 'start' || e.ev === 'cached',
      }
    }
    case 'sh':
      return { text: `$ ${cut(e.text, 160)} → ${e.code}`, color: e.code === 0 ? 'subtle' : 'warning' }
    default:
      return { text: `· ${cut(e.text, 300)}`, dim: true }
  }
}

// ---------- tool descriptions (model-facing, English) ----------
const SPAWN_DESC = `Hand a task to a pi sub-agent (the pi coding agent, running whatever model the user configured) in the background. Returns the agent id immediately.
When it finishes you automatically get one notification containing only its final answer (its transcript never enters your context), so do not poll or wait: carry on with other work or end your turn.
The user can watch it live in the /pi pane and talk to it directly.
model: an alias from the user's pisub config, or any provider/model that pi knows. Omit it to use the configured default (or pi's own default model). The status tool with models=true lists the aliases.
The task must be self-contained: pi cannot see this conversation. Spell out paths, goal, constraints and output format. Put long instructions in a file and tell it to read that file first.
By default it has all of pi's tools (read/write files, run commands); readonly=true limits it to read-only tools. pi's tools run outside Claude Code's permission prompts and rules, so it can change files and run commands without asking: use readonly=true whenever the job only needs to read, and set cwd to the folder the job needs.
Good fits: well-specified backend work, batch jobs, investigations, checks with machine-verifiable output. Keep planning, task breakdown, architecture and UI/design decisions for yourself.`

const FLOW_DESC = `Start a pi workflow: a script that orchestrates many pi sub-agents. The whole flow runs in a background process and you are notified once, with the script's return value (agents are not reported one by one). Only available after the user typed /pi flow in this session.
The script is plain JavaScript (not TypeScript), written like Claude Code's Workflow scripts:
  export const meta = { name: 'x', description: 'one line', phases: [{ title: 'Analyze' }, { title: 'Review' }] }   // must be a pure literal
  phase('Analyze')
  const r = await pipeline(args.items, it => agent('...self-contained task...', { label: 'item ' + it.no }), (ans, it) => agent('...', { model: 'cheap', schema: S }))
  return r
Available:
- agent(prompt, {model, label, phase, readonly, cwd, thinking, schema}) → the full final answer. With schema (a JSON Schema whose root is an object) it returns the validated object and asks the agent to resubmit on mismatch (up to 2 times). Returns null on failure. model is an alias or provider/model, as in spawn.
- pipeline(items, stage1, stage2, ...): each item runs through all stages independently, without waiting for the others (use this by default). Stage arguments: (previous result, original item, index); an item whose stage throws or returns null becomes null.
- parallel([() => ...]): returns when all are done; ones that throw become null.
- phase(title), log(text), args (the value passed at start, as is).
- sh(command string | [program, ...args], {cwd, timeoutSec, input}) → {code, stdout, stderr}: run checking scripts (strings run in bash; Git bash on Windows).
No file or Node APIs; let an agent do file work, or use sh. Concurrency per model alias comes from the user's config (default 4); meta.concurrency overrides it.
pi cannot see this conversation: every prompt must state paths, goal, constraints and output format. Treat answers from weaker models as hints and cross-check them.
Resume: pass resume = the old workflow id; script/scriptPath may be omitted (the old script is reused, and so are its args if none are given). Unchanged agent() calls come from the cache; only changed and new ones run.
The transcript stays out of your context; the user sees phases and every agent in the /pi pane. To debug, use log on the workflow or on one of its agents, and status to list its agents.`

// When a tool hook itself fails: hand the reason to the model as an error result
const failed = () => ({ deny: `${P} internal error; the CLI still works: node <plugin dir>/bin/pisub.mjs (see help)` })

// The workflow tool is registered only after the user turns workflows on (deferred)
async function registerFlowTool($: EngineInterface) {
  await $.tool.register({
    name: 'flow',
    description: FLOW_DESC,
    isDeferred: true,
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The complete workflow script (starting with export const meta = {...})' },
        scriptPath: { type: 'string', description: 'Absolute path of a script file (instead of script)' },
        args: { description: 'Passed to the script as args, as is; write arrays and objects as JSON values, not strings' },
        resume: { type: 'string', description: 'Resume: the old workflow id' },
        cwd: { type: 'string', description: 'Working directory, absolute (default: the session directory); agents and sh run here by default' },
      },
    },
  })
}

// /pi flow: turn workflows on or off for this session.
// The switch is kept per session id in the plugin's own store, so it survives restarts and --continue/--resume.
const flowKey = (sid: string) => `flow:${sid}`
const FLOW_KEEP_MS = 30 * 86400000

async function setFlow($: EngineInterface, on: boolean): Promise<string> {
  const c = await getCtx($)
  const r = await pisub($, ['flow', on ? 'enable' : 'disable', '--session', c.sid])
  if (!r.ok) return L(`Failed: ${r.err || r.out}`, `操作失败：${r.err || r.out}`)
  await update($, flowOnA, () => on)
  if (!on) {
    await $.store.delete(flowKey(c.sid))
    return L('pi workflows are now off for this session.', '本会话的 pi 工作流已关闭。')
  }
  const t = Date.now()
  await $.store.set(flowKey(c.sid), t)
  // Clean up switches of sessions older than 30 days
  for (const k of await $.store.keys()) {
    if (!k.startsWith('flow:') || k === flowKey(c.sid)) continue
    const v = await $.store.get(k)
    if (typeof v !== 'number' || t - v > FLOW_KEEP_MS) await $.store.delete(k)
  }
  await registerFlowTool($)
  return L(
    `pi workflows are on for this session: Claude can use ${toolName('flow')} (deferred; fetch it with ToolSearch). This session only; /pi flow off turns it off.`,
    `本会话已开启 pi 工作流：Claude 可以用 ${toolName('flow')}（按需加载，先用 ToolSearch 取）。只对本会话有效，/pi flow off 关闭。`,
  )
}

// ---------- registration ----------
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'pi',
      description: 'Open the pi sub-agents pane (/pi all shows every agent; /pi flow turns on workflows for this session, /pi flow off turns them off)',
      argumentHint: '[all | flow | flow off]',
    })
    // Workflows were turned on in this session before (mod reload or resumed session): register the tool again.
    // Reads the store only; starts no process.
    const sid = await $.session.id()
    if ((await read($, flowOnA)) || (await $.store.get(flowKey(sid))) !== undefined) {
      await update($, flowOnA, () => true)
      await registerFlowTool($)
    }
    await $.tool.register({
      name: 'spawn',
      description: SPAWN_DESC,
      isDeferred: true,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Self-contained task description' },
          model: { type: 'string', description: 'Model alias from the pisub config, or provider/model; omit for the default' },
          name: { type: 'string', description: 'Short name shown in the pane (optional)' },
          cwd: { type: 'string', description: "pi's working directory, absolute (default: the session directory)" },
          readonly: { type: 'boolean', description: 'true = read-only tools only' },
          thinking: { type: 'string', description: 'Thinking level off|minimal|low|medium|high|xhigh|max (default: per model)' },
        },
        required: ['task'],
      },
    })
    await $.tool.register({
      name: 'send',
      description:
        'Send a message to a pi sub-agent. While it runs: by default it is a steer (delivered after its current step); mode=follow_up waits until it finishes the current task. After it finished: it resumes its previous session, and you are notified again when done.',
      isDeferred: true,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          message: { type: 'string' },
          mode: { type: 'string', enum: ['steer', 'follow_up'] },
        },
        required: ['id', 'message'],
      },
    })
    await $.tool.register({
      name: 'status',
      description:
        "Show pi sub-agent status. Without id: the agents this session started; all=true: every agent. models=true: list the model aliases configured for pisub (use them as spawn's model).",
      isDeferred: true,
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, all: { type: 'boolean' }, models: { type: 'boolean' } } },
    })
    await $.tool.register({
      name: 'log',
      description:
        "Show what a pi sub-agent did: tool calls, errors, thinking summaries. Use it only when a result looks wrong or failed and needs debugging; the output enters your context.",
      isDeferred: true,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, tail: { type: 'number', description: 'How many recent entries (default 60)' }, full: { type: 'boolean' } },
        required: ['id'],
      },
    })
    await $.tool.register({
      name: 'result',
      description: "Get a pi sub-agent's latest final answer. Only needed if a notification got lost.",
      isDeferred: true,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    await $.tool.register({
      name: 'stop',
      description: 'Stop a pi sub-agent.',
      isDeferred: true,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    // Dormant by default; wake right away only if this session already has agents (e.g. after a mod reload),
    // so no notification is missed
    if ((await read($, mineA)).length > 0) {
      void activate($).catch(err => $.ui.log(`${P}: failed to wake up: ${String(err)}`))
    }
    return started
  })

  // Start and end of a main-conversation turn: notifications wait while a turn is running
  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) mainBusy = true
    return r
  })
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      mainBusy = false
      if (active) void poll($)
    }
    return r
  })

  // Loading the pi-subagents skill means pi is about to be used: wake up
  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    if (e.pluginName !== P && !/pi-subagents/.test(e.skill)) return r
    // Show the real CLI path in place of the {{PISUB}} placeholder
    const text = r.text.split('{{PISUB}}').join(`${$.plugin.root}/bin/pisub.mjs`)
    try {
      await activate($)
    } catch (err) {
      return { ...r, text: `${text}\n\n(pi-subagents failed to wake up: ${String(err)}; the pisub CLI still works.)` }
    }
    return { ...r, text }
  })

  on('command.run', { command: 'pi' }, async ($, e) => {
    await activate($)
    const args = (e.args || '').trim()
    if (/^(flow\b|工作流)/i.test(args)) {
      const msg = await setFlow($, !/(\boff\b|关)/i.test(args))
      return { text: msg }
    }
    if (/all|全部/.test(args)) await update($, showAllA, () => true)
    await openPane($, true)
    void poll($)
    return { text: L('pi sub-agents pane opened.', 'pi 子代理面板已打开。') }
  })

  // ----- tools -----
  on('tool.call', { tool: /^mcp__pi-subagents__spawn$/ }, async ($, e) => {
    await activate($)
    const input = e as unknown as { task?: string; model?: string; name?: string; cwd?: string; readonly?: boolean; thinking?: string }
    if (!input.task || !input.task.trim()) return { deny: 'task must not be empty' }
    const c = await getCtx($)
    const args = ['spawn', '--json', '--stdin', '--owner', c.sid, '--origin', 'claude']
    if (input.model) args.push('--model', input.model)
    if (input.name) args.push('--name', input.name)
    if (input.thinking) args.push('--thinking', input.thinking)
    if (input.readonly) args.push('--readonly')
    if (input.cwd) args.push('--cwd', input.cwd)
    const r = await pisub($, args, input.task)
    if (!r.ok) return { deny: L(`spawn failed: ${r.err || r.out}`, `派出失败：${r.err || r.out}`) }
    const info = JSON.parse(r.out) as { id: string; model: string }
    await update($, mineA, list => [...list.filter(x => x !== info.id), info.id])
    await update($, notifiedA, m => ({ ...m, [info.id]: 0 }))
    await openPane($)
    void poll($)
    return {
      result: L(
        `Started pi sub-agent ${info.id} (${info.model}); it runs in the background. You will be notified with its final answer automatically, so no polling is needed. The user can watch it live in the /pi pane.`,
        `已派出 pi 子代理 ${info.id}（${info.model}），正在后台运行。它做完会自动通知你最终回答，不需要轮询。用户可在 /pi 面板看实时过程。`,
      ),
    }
  }).catch(failed)

  on('tool.call', { tool: /^mcp__pi-subagents__send$/ }, async ($, e) => {
    await activate($)
    const input = e as unknown as { id?: string; message?: string; mode?: string }
    if (!input.id || !input.message) return { deny: 'id and message are required' }
    const r = await pisub($, ['send', input.id, '--stdin', '--from', 'claude', '--mode', input.mode === 'follow_up' ? 'follow_up' : 'steer'], input.message)
    if (!r.ok) return { deny: r.err || r.out }
    await adopt($, input.id)
    void poll($)
    return { result: `${r.out}\n${L('You will be notified when it is done.', '做完会自动通知你。')}` }
  }).catch(failed)

  on('tool.call', { tool: /^mcp__pi-subagents__status$/ }, async ($, e) => {
    await activate($)
    const input = e as unknown as { id?: string; all?: boolean; models?: boolean }
    const c = await getCtx($)
    const args = input.models ? ['models'] : input.id ? ['status', input.id] : input.all ? ['status'] : ['status', '--owner', c.sid]
    const r = await pisub($, args)
    return r.ok ? { result: r.out || L('(no pi sub-agents)', '（没有 pi 子代理）') } : { deny: r.err || r.out }
  }).catch(failed)

  on('tool.call', { tool: /^mcp__pi-subagents__log$/ }, async ($, e) => {
    await activate($)
    const input = e as unknown as { id?: string; tail?: number; full?: boolean }
    if (!input.id) return { deny: 'id is required' }
    const args = ['log', input.id]
    if (input.full) args.push('--full')
    else if (input.tail) args.push('--tail', String(input.tail))
    const r = await pisub($, args)
    return r.ok ? { result: r.out || L('(nothing recorded yet)', '（还没有记录）') } : { deny: r.err || r.out }
  }).catch(failed)

  on('tool.call', { tool: /^mcp__pi-subagents__result$/ }, async ($, e) => {
    await activate($)
    const input = e as unknown as { id?: string }
    if (!input.id) return { deny: 'id is required' }
    const r = await pisub($, ['result', input.id])
    return r.ok ? { result: r.out } : { deny: r.err || r.out }
  }).catch(failed)

  on('tool.call', { tool: /^mcp__pi-subagents__stop$/ }, async ($, e) => {
    await activate($)
    const input = e as unknown as { id?: string }
    if (!input.id) return { deny: 'id is required' }
    const r = await pisub($, ['stop', input.id])
    void poll($)
    return r.ok ? { result: r.out } : { deny: r.err || r.out }
  }).catch(failed)

  on('tool.call', { tool: /^mcp__pi-subagents__flow$/ }, async ($, e) => {
    await activate($)
    if (!(await read($, flowOnA)))
      return {
        deny: L(
          'pi workflows are off in this session. The user turns them on by typing /pi flow (each session separately).',
          '本会话没有开启 pi 工作流。要用户输入 /pi flow 开启后才能用（每个会话单独开启）。',
        ),
      }
    const input = e as unknown as { script?: string; scriptPath?: string; args?: unknown; resume?: string; cwd?: string }
    if (!input.script && !input.scriptPath && !input.resume) return { deny: 'one of script, scriptPath or resume is required' }
    const c = await getCtx($)
    const spec = { script: input.script, scriptPath: input.scriptPath, args: input.args, resume: input.resume, cwd: input.cwd, owner: c.sid, origin: 'claude' }
    const r = await pisub($, ['flow', 'run', '--stdin-json', '--json'], JSON.stringify(spec))
    if (!r.ok) return { deny: L(`the workflow did not start: ${r.err || r.out}`, `工作流没有启动：${r.err || r.out}`) }
    const info = JSON.parse(r.out) as { id: string; name: string; script: string }
    await update($, mineA, list => [...list.filter(x => x !== info.id), info.id])
    await update($, notifiedA, m => ({ ...m, [info.id]: 0 }))
    await openPane($)
    void poll($)
    return {
      result: L(
        `Started workflow ${info.id} (${info.name}) in the background. You will be notified with the script's return value automatically, so no polling is needed. ` +
          `The script is saved at ${info.script}; to change and rerun it, edit that file and pass scriptPath plus resume=${info.id}. The user can follow progress in the /pi pane.`,
        `已启动工作流 ${info.id}（${info.name}），在后台运行。跑完会自动通知你脚本的返回值，不需要轮询。` +
          `脚本存在 ${info.script}；要改了重跑，就编辑它，再用 scriptPath 加 resume=${info.id} 续跑。用户可在 /pi 面板看进度。`,
      ),
    }
  }).catch(failed)

  // ----- pane -----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const cols = e.props.bodyColumns || 60
    const budget = Math.max(6, (e.props.scroll?.bodyRows || 20) - 1)
    const selected = await read($, selectedA)
    const agents = await read($, agentsA)
    const showAll = await read($, showAllA)

    if (!selected) {
      return (
        <Box flexDirection="column">
          <Box>
            <Text bold>{showAll ? L('All pi sub-agents', '全部 pi 子代理') : L('pi sub-agents in this session', '本会话的 pi 子代理')} </Text>
            <Button
              key="scope"
              dimColor
              label={showAll ? L('This session only', '只看本会话') : L('Show all', '显示全部')}
              onPress={() => void update($, showAllA, v => !v).then(() => poll($))}
            />
          </Box>
          {agents.length === 0 && (
            <Text dimColor>
              {L(
                'No pi sub-agents yet. They appear here once Claude hands out work; click one to watch it live and talk to it.',
                '还没有 pi 子代理。Claude 派活后会出现在这里，点一行可看实时过程并直接跟它对话。',
              )}
            </Text>
          )}
          {agents.map(r => (
            <Button key={`a-${r.id}`} onPress={() => void select($, r.id)}>
              {ICON[r.status] || '?'} {r.kind === 'flow' ? `⚙ ${r.name}` : r.name || r.alias}{' '}
              <Text dimColor>
                {statusName(r.status)} · {r.kind === 'flow' ? r.progress || L('workflow', '工作流') : modelOf(r)} · {ago(r.createdAt)} ·{' '}
                {cut(r.task.replace(/\s+/g, ' '), 40)}
              </Text>
            </Button>
          ))}
        </Box>
      )
    }

    const row = agents.find(r => r.id === selected) || cache.get(selected)?.row
    const isFlow = row?.kind === 'flow'
    const parent = row?.parent || ''
    const detail = await read($, detailA)
    const notice = await read($, noticeA)
    const sendCount = await read($, sendCountA)
    const running = row ? !TERMINAL.has(row.status) : false
    const lines = (detail && detail.id === selected ? detail.entries : []).map(linesOf)
    const live = detail && detail.id === selected ? detail.live : null
    const liveText = live
      ? live.tool
        ? L(`calling ${live.tool}…`, `正在调用 ${live.tool}…`)
        : live.text
          ? cut(live.text.slice(-400), 400)
          : live.thinking
            ? `${L('(thinking) ', '（思考中）')}${cut(live.thinking.slice(-200), 200)}`
            : ''
      : ''
    // Workflow: the agent list takes at most about half the pane; running and failed ones come first when space is short
    const kids = isFlow && detail && detail.id === selected ? detail.children : []
    const kidRoom = Math.min(kids.length, Math.max(3, Math.floor(budget * 0.45)))
    const rank = (c: FlowChild) => (c.status === 'running' ? 0 : c.status === 'error' ? 1 : 2)
    const kidsShown = [...kids]
      .sort((a, b) => rank(a) - rank(b) || b.index - a.index)
      .slice(0, kidRoom)
      .sort((a, b) => a.index - b.index)
    // Draw only the last entries that fit
    let room = budget - 3 - (liveText ? rowsOf(liveText, cols) : 0) - (notice ? 1 : 0) - (kids.length ? kidRoom + 1 : 0)
    const shown: Line[] = []
    for (let i = lines.length - 1; i >= 0 && room > 0; i--) {
      const line = lines[i]!
      room -= rowsOf(line.text, cols)
      shown.unshift(line)
    }
    const hidden = lines.length - shown.length

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="back" dimColor label={parent ? L('← Workflow', '← 工作流') : L('← List', '← 列表')} onPress={() => void select($, parent)} />
          <Text bold> {row ? `${ICON[row.status] || ''} ${isFlow ? '⚙ ' : ''}${row.name || row.id}` : selected} </Text>
          <Text dimColor>
            {row
              ? `${statusName(row.status)} · ${isFlow ? row.progress || L('workflow', '工作流') : `${modelOf(row)} · ${L(`round ${row.rounds}`, `第 ${row.rounds} 轮`)}`}`
              : ''}{' '}
          </Text>
          {running && (
            <Button
              key="stop"
              label={L('Stop', '停止')}
              onPress={() =>
                void pisub($, ['stop', selected]).then(r => update($, noticeA, () => r.out || r.err)).then(() => poll($))
              }
            />
          )}
        </Box>
        {hidden > 0 && (
          <Text dimColor>
            {L(`(${hidden} earlier entries; full transcript: pisub log ${selected} --full)`, `（前面还有 ${hidden} 条，完整过程：pisub log ${selected} --full）`)}
          </Text>
        )}
        {shown.map(l => (
          <Text color={l.color} dimColor={l.dim} bold={l.bold}>
            {l.text}
          </Text>
        ))}
        {liveText && <Text dimColor>… {liveText}</Text>}
        {kids.length > 0 && (
          <Text bold>
            {L(
              `Agents (${kids.length}${kidsShown.length < kids.length ? `, showing ${kidsShown.length}` : ''}; click one to see its work and talk to it)`,
              `子代理（共 ${kids.length} 个${kidsShown.length < kids.length ? `，显示 ${kidsShown.length} 个` : ''}，点一行看过程、跟它对话）`,
            )}
          </Text>
        )}
        {kidsShown.map(k => (
          <Button key={`c-${k.index}`} onPress={() => (k.id ? void select($, k.id) : undefined)}>
            {CHILD_ICON[k.status] || '·'} {k.label}{' '}
            <Text dimColor>
              {k.model}
              {k.phase ? ` · ${k.phase}` : ''}
              {k.note ? ` · ${cut(k.note, 60)}` : ''}
            </Text>
          </Button>
        ))}
        {notice && <Text color="suggestion">{notice}</Text>}
        {Input && !isFlow && (
          <Input
            key={`msg-${sendCount}`}
            placeholder={
              running
                ? L('Steer it (Enter to send)', '给它插话（Enter 发送）')
                : L('It has finished: send a message to resume its previous session', '它已结束：发消息让它接着原会话续做')
            }
            submitLabel={L('Send', '发送')}
            onSubmit={value => {
              const text = value.trim()
              if (!text) return
              // The user resumes a finished agent: adopt it into this session so the result reaches the main agent
              void adopt($, selected, true)
                .then(() => pisub($, ['send', selected, '--stdin', '--from', 'user', '--mode', 'steer'], text))
                .then(r => update($, noticeA, () => (r.ok ? L(`Sent: ${cut(text, 40)}`, `已发送：${cut(text, 40)}`) : L(`Send failed: ${r.err || r.out}`, `发送失败：${r.err || r.out}`))))
                .then(() => update($, sendCountA, n => n + 1))
                .then(() => poll($))
            }}
          />
        )}
      </Box>
    )
  })
}
