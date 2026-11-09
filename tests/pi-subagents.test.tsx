import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'pi-subagents',
  component: 'Pane',
  requestId: 'pi-subagents',
  props: {
    title: 'pi sub-agents',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const RUNS = '/home/u/.pi-subagents/runs'
const ID = 'strong-1109-120000-abc'
const ID2 = 'cheap-1109-120001-def'

// The engine normalizes paths to absolute local paths (drive letter and backslashes on Windows); compare normalized
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const WF = 'wf-demo-1109-120002-ghi'
const KID = 'kid-1109-120003-jkl'

type World = {
  files: Record<string, string>
  mtime: number
  calls: { argv: readonly string[]; stdin?: string }[]
  submitted: string[]
  deferred: boolean[]
  tools: string[]
  store: Map<string, unknown>
}

// No real processes or files in tests: these hooks play the engine and pisub
function fakeEngine(on: On, lang = 'en'): World {
  const w: World = { files: {}, mtime: 1, calls: [], submitted: [], deferred: [], tools: [], store: new Map() }
  let spawned = 0
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('command.run', (_, e) => ({ text: `(no plugin handles /${e.command})` }))
  on('command.register', () => ({ value: { command: 'pi' } }))
  on('tool.register', (_, e) => {
    w.deferred.push(e.isDeferred === true)
    w.tools.push(e.name)
    return { value: { tool: `mcp__pi-subagents__${e.name}` } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'sid-test' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    w.calls.push({ argv: e.argv, stdin: e.init?.stdin })
    const cmd = e.argv[2]
    let stdout = ''
    if (cmd === 'paths') stdout = JSON.stringify({ runs: RUNS, node: 'node', lang })
    else if (cmd === 'spawn') stdout = JSON.stringify({ id: spawned++ === 0 ? ID : ID2, model: 'acme/model-a' })
    else if (cmd === 'send') stdout = `Delivered to ${e.argv[3]}`
    else if (cmd === 'models') stdout = '* strong  acme/model-a'
    else if (cmd === 'flow' && e.argv[3] === 'run') stdout = JSON.stringify({ id: WF, name: 'demo', script: `${RUNS}/${WF}/script.mjs` })
    else if (cmd === 'flow') stdout = e.argv[3] === 'enable' ? 'Workflows enabled' : 'Workflows disabled'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', (_, e) => {
    const text = w.files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: text.length, mtimeMs: w.mtime, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const text = w.files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  // Subdirectories of runs = agents that have a state.json
  on('fs.list', () => ({
    value: Object.keys(w.files)
      .filter(p => p.startsWith(`${RUNS}/`) && p.endsWith('/state.json'))
      .map(p => ({ name: p.slice(RUNS.length + 1, -'/state.json'.length), kind: 'dir' as const, isLink: false, size: 0, mtimeMs: 0 })),
  }))
  on('prompt.submit', (_, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  return w
}

function state(id: string, status: string, rounds: number) {
  return JSON.stringify({
    id,
    name: '',
    alias: 'strong',
    provider: 'acme',
    model: 'model-a',
    status,
    task: 'Count the rows in sales.csv',
    owner: 'sid-test',
    cwd: '/w',
    createdAt: 1,
    updatedAt: 2,
    rounds,
  })
}

function finish(w: World, id: string, final: string, rounds = 1) {
  w.mtime += 1
  w.files[`${RUNS}/${id}/state.json`] = state(id, 'done', rounds)
  w.files[`${RUNS}/${id}/final.md`] = final
}

test('the empty pane shows a hint in the terminal and on desktop', async ($, on) => {
  fakeEngine(on)
  mock.clock(on)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /No pi sub-agents yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('dormant at session start: no process, every tool deferred', async ($, on) => {
  const w = fakeEngine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(w.calls.length).toBe(0)
  expect(w.deferred.length).toBe(6)
  expect(w.deferred.every(Boolean)).toBe(true)
})

test('spawn passes the session id to pisub and reports only the final answer', async ($, on) => {
  const w = fakeEngine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })

  const r = await $.tool.call({ tool: 'mcp__pi-subagents__spawn', task: 'Count the rows in sales.csv', model: 'strong' } as never)
  expect(r.text ?? String(r.result)).toContain(ID)
  const spawn = w.calls.find(c => c.argv[2] === 'spawn')
  expect(spawn?.argv).toContain('sid-test')
  expect(spawn?.argv).toContain('strong')
  expect(spawn?.stdin).toBe('Count the rows in sales.csv')

  // Running: no notification
  w.files[`${RUNS}/${ID}/state.json`] = state(ID, 'running', 0)
  await clock.advance(1600)
  expect(w.submitted.length).toBe(0)

  // Finished: wait a moment, then notify once with the final answer
  finish(w, ID, 'Final answer: 1204 rows.')
  await clock.advance(1600)
  expect(w.submitted.length).toBe(0)
  await clock.advance(3200)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('Final answer: 1204 rows.')
  expect(w.submitted[0]).toContain(ID)
  expect(w.submitted[0]).toContain('not a user message')

  // No duplicate notification
  await clock.advance(6000)
  expect(w.submitted.length).toBe(1)

  // It is in the pane list; clicking shows its work; the input box sends through pisub send
  w.files[`${RUNS}/${ID}/view.jsonl`] =
    JSON.stringify({ t: 1, k: 'user', from: 'claude', mode: 'prompt', text: 'Count the rows in sales.csv' }) +
    '\n' +
    JSON.stringify({ t: 2, k: 'tool', name: 'bash', args: 'ls' }) +
    '\n' +
    JSON.stringify({ t: 3, k: 'text', text: 'Final answer: 1204 rows.' }) +
    '\n'
  const surfaces = ['terminal', 'desktop'] as const
  for (const [i, surface] of surfaces.entries()) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: `a-${ID}` })
    await clock.advance(1600)
    expect(await ui.find({ type: 'Text', text: /→ bash ls/ })).toBeDefined()
    // Each message gives the input a new key, which clears it
    await ui.input({ key: `msg-${i}`, text: 'Check it once more' })
    const sent = w.calls.filter(c => c.argv[2] === 'send')
    expect(sent.at(-1)?.stdin).toBe('Check it once more')
    expect(sent.at(-1)?.argv).toContain('user')
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('status with models=true lists the configured aliases', async ($, on) => {
  const w = fakeEngine(on)
  mock.clock(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'mcp__pi-subagents__status', models: true } as never)
  expect(JSON.stringify(r)).toContain('strong')
  expect(w.calls.some(c => c.argv[2] === 'models')).toBe(true)
})

test('agents started by a script: a steer while running does not adopt; resuming after it finished does', async ($, on) => {
  const w = fakeEngine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  // Started from the CLI, not by this session
  w.files[`${RUNS}/${ID}/state.json`] = state(ID, 'running', 0)
  await $.command.run({ command: 'pi', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(1600)
  await ui.press({ key: 'scope' })
  await clock.advance(1600)
  await ui.press({ key: `a-${ID}` })
  await clock.advance(1600)

  // Steer while running: the script gets the result, the plugin does not notify
  await ui.input({ key: 'msg-0', text: 'Also check the edge cases' })
  finish(w, ID, 'first-round answer')
  await clock.advance(8000)
  expect(w.submitted.length).toBe(0)

  // Resume after it finished: adopted into this session, round two is reported
  await ui.input({ key: 'msg-1', text: 'Also break it down by region' })
  await clock.advance(1600)
  finish(w, ID, 'second-round answer', 2)
  await clock.advance(8000)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('second-round answer')
  expect(w.submitted[0]).not.toContain('first-round answer')
  await ui.unmount()
})

test('workflows: no tool and calls refused until /pi flow; then registered and runnable; /pi flow off turns them off', async ($, on) => {
  const w = fakeEngine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(w.tools).not.toContain('flow')
  const denied = await $.tool.call({ tool: 'mcp__pi-subagents__flow', script: 'x' } as never)
  expect(JSON.stringify(denied)).toContain('/pi flow')
  expect(w.calls.some(c => c.argv[2] === 'flow' && c.argv[3] === 'run')).toBe(false)

  await $.command.run({ command: 'pi', args: 'flow' } as never)
  const en = w.calls.find(c => c.argv[2] === 'flow' && c.argv[3] === 'enable')
  expect(en?.argv).toContain('sid-test')
  expect(w.tools).toContain('flow')
  expect(w.deferred.at(-1)).toBe(true)

  const r = await $.tool.call({ tool: 'mcp__pi-subagents__flow', script: 'export const meta = {}', args: { items: [1] } } as never)
  expect(JSON.stringify(r)).toContain(WF)
  const run = w.calls.find(c => c.argv[2] === 'flow' && c.argv[3] === 'run')
  const spec = JSON.parse(run!.stdin!) as { owner: string; args: unknown; script: string }
  expect(spec.owner).toBe('sid-test')
  expect(spec.args).toEqual({ items: [1] })

  // The workflow finishes: one notification with the return value; its agents are not reported separately
  w.mtime += 1
  w.files[`${RUNS}/${WF}/state.json`] = JSON.stringify({
    id: WF, kind: 'flow', name: 'demo', alias: 'flow', provider: '', model: 'workflow', status: 'done', task: 'demo', owner: 'sid-test',
    cwd: '/w', createdAt: 3, updatedAt: 4, rounds: 1, progress: 'phase 1/1 "Analyze" · done 1/1',
    children: [{ index: 1, label: 'Dataset 1', phase: 'Analyze', model: 'cheap', status: 'done', id: KID }],
  })
  w.files[`${RUNS}/${WF}/final.md`] = '(Workflow "demo": …)\n\nreturn value 42'
  w.files[`${RUNS}/${KID}/state.json`] = JSON.stringify({ ...JSON.parse(state(KID, 'done', 1)), parent: WF, owner: WF, name: 'Dataset 1' })
  await clock.advance(6000)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('return value 42')
  expect(w.submitted[0]).toContain('model="workflow"')

  // Pane: the workflow detail lists its agents; open one, then go back to the workflow
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `a-${WF}` })
  await clock.advance(1600)
  expect(await ui.find({ type: 'Text', text: /Agents \(1;/ })).toBeDefined()
  await ui.press({ key: 'c-1' })
  await clock.advance(1600)
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
  await ui.press({ key: 'back' })
  await clock.advance(1600)
  expect(await ui.find({ type: 'Text', text: /Agents \(1;/ })).toBeDefined()
  await ui.unmount()

  await $.command.run({ command: 'pi', args: 'flow off' } as never)
  expect(w.calls.some(c => c.argv[2] === 'flow' && c.argv[3] === 'disable')).toBe(true)
  const denied2 = await $.tool.call({ tool: 'mcp__pi-subagents__flow', script: 'x' } as never)
  expect(JSON.stringify(denied2)).toContain('are off')
})

test('workflows stay on when the same session resumes (no process started); other sessions stay off', async ($, on) => {
  const w = fakeEngine(on)
  mock.clock(on)
  w.store.set('flow:sid-test', Date.now())
  w.store.set('flow:old-session', 1)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(w.tools).toContain('flow')
  expect(w.calls.length).toBe(0)
  // Turning it on also cleans up stale switches of old sessions
  await $.command.run({ command: 'pi', args: 'flow' } as never)
  expect(w.store.has('flow:old-session')).toBe(false)
  await $.command.run({ command: 'pi', args: 'flow off' } as never)
  expect(w.store.has('flow:sid-test')).toBe(false)
})

test('two agents finishing close together share one notification', async ($, on) => {
  const w = fakeEngine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__pi-subagents__spawn', task: 'A' } as never)
  await $.tool.call({ tool: 'mcp__pi-subagents__spawn', task: 'B', model: 'cheap' } as never)
  w.files[`${RUNS}/${ID}/state.json`] = state(ID, 'running', 0)
  w.files[`${RUNS}/${ID2}/state.json`] = state(ID2, 'running', 0)
  await clock.advance(1600)

  finish(w, ID, "A's answer")
  await clock.advance(1600)
  finish(w, ID2, "B's answer")
  await clock.advance(1600)
  expect(w.submitted.length).toBe(0)
  await clock.advance(4000)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain("A's answer")
  expect(w.submitted[0]).toContain("B's answer")
  expect(w.submitted[0]).toContain('2 agents have new results')
})

test('Chinese UI when pisub reports language zh', async ($, on) => {
  const w = fakeEngine(on, 'zh')
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__pi-subagents__spawn', task: '统计 sales.csv 的行数' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(1600)
  w.files[`${RUNS}/${ID}/state.json`] = state(ID, 'running', 0)
  await clock.advance(1600)
  expect(await ui.find({ type: 'Text', text: /本会话的 pi 子代理/ })).toBeDefined()
  finish(w, ID, '成立。')
  await clock.advance(6000)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('pi 子代理自动通知')
  await ui.unmount()
})
