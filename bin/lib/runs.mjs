// Run folders: ids, state.json, inboxes, the lock that keeps one broker per agent, the machine-wide slots
// (maxAgents), creating a run, and waiting for or stopping one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DIR_MODE, FILE_MODE, HOME, RUNS, SELF, TERMINAL, appendPrivate, die, errorTitle, isAlive, loadConfig, mkdirp, now, out, readJSON, sleep, trunc, withFileLock, writeJSON, writePrivate } from './core.mjs';
import { L } from '../i18n.mjs';
import { pickProvider, providerAvailable, resolveModel } from './models.mjs';
import { createWorktree, worktreeIntro } from './git.mjs';

// ---------- run directories ----------
export function checkId(id) {
  if (!id || !/^[\w.-]+$/.test(id)) die(L(`invalid agent id: ${id ?? '(empty)'}`, `无效的代理编号：${id ?? '（空）'}`));
  if (!fs.existsSync(path.join(RUNS, id, 'state.json'))) die(L(`no agent named ${id}`, `找不到代理 ${id}`));
  return id;
}
export const runDir = id => path.join(RUNS, id);
export const statePath = id => path.join(runDir(id), 'state.json');
export const inboxDir = id => path.join(runDir(id), 'inbox');
export const readState = id => readJSON(statePath(id), null);
// Several processes write state.json (the broker, a workflow runner, stop/wait commands): every update is a
// locked read-modify-write, carries a version number, and the round counter never goes backwards.
export function saveState(id, patch) {
  return withFileLock(statePath(id), () => {
    const cur = readState(id) || {};
    const st = { ...cur, ...patch, updatedAt: now(), version: (cur.version || 0) + 1 };
    if ((cur.rounds || 0) > (st.rounds || 0)) st.rounds = cur.rounds;
    writeJSON(statePath(id), st);
    return st;
  });
}
export function makeId(alias) {
  const t = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
  // Only ASCII letters, digits, '_', '.', '-' survive, and never at the start a '-' or '.': a name like
  // "审查-接口" would otherwise leave "-", and an id starting with "--" reads as an option on the command line.
  const safe = String(alias).replace(/[^\w.-]/g, '').replace(/^[.-]+|[.-]+$/g, '').slice(0, 24).replace(/[.-]+$/, '') || 'pi';
  return `${safe}-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}
// A new run directory under a fresh id. Created exclusively, so two runs can never share a folder.
export function newRunDir(alias) {
  mkdirp(RUNS);
  for (;;) {
    const id = makeId(alias);
    try {
      fs.mkdirSync(runDir(id), { mode: DIR_MODE });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    mkdirp(inboxDir(id));
    return id;
  }
}
export function inboxFiles(id) {
  try {
    return fs.readdirSync(inboxDir(id)).filter(f => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}
export const hasInbox = id => inboxFiles(id).length > 0;
// Messages are files named so that they sort in sending order: time, then a counter for messages this process
// sent within the same millisecond. A message stays in the inbox until pi has accepted it (see deliver()).
export let enqueueSeq = 0;
export function enqueue(id, msg) {
  mkdirp(inboxDir(id));
  const name = `${String(now()).padStart(14, '0')}-${String(++enqueueSeq).padStart(6, '0')}-${process.pid}`;
  const tmp = path.join(inboxDir(id), name + '.tmp');
  writePrivate(tmp, JSON.stringify({ ...msg, at: now() }));
  fs.renameSync(tmp, path.join(inboxDir(id), name + '.json'));
}

// ---------- lock: one broker per agent ----------
// The holder rewrites its lock every few seconds. A lock whose process is gone, or whose heartbeat stopped
// (the process hung, or the pid now belongs to some other program), no longer counts.
export const lockPath = id => path.join(runDir(id), 'serve.lock');
export const HEARTBEAT_MS = 5000;
export const LOCK_STALE_MS = 60000;
export const LOCK_TOKEN = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
export function lockHolder(id) {
  const l = readJSON(lockPath(id), null);
  const pid = Number(l?.pid);
  return isAlive(pid) && now() - Number(l.at || 0) < LOCK_STALE_MS ? pid : null;
}
export const isServing = id => lockHolder(id) !== null;
export const heartbeats = new Map();
export function acquireLock(id) {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lockPath(id), JSON.stringify({ pid: process.pid, at: now(), token: LOCK_TOKEN }), { flag: 'wx', mode: FILE_MODE });
      heartbeats.set(
        id,
        setInterval(() => {
          // Someone took the lock over (we were hung long enough to look dead): stop at once, never run twice
          const cur = readJSON(lockPath(id), null);
          if (cur?.token && cur.token !== LOCK_TOKEN) {
            process.stderr.write(`pisub: lost the lock of ${id}; exiting\n`);
            process.exit(3);
          }
          try { writeJSON(lockPath(id), { pid: process.pid, at: now(), token: LOCK_TOKEN }); } catch {}
          beatSlot();
        }, HEARTBEAT_MS)
      );
      heartbeats.get(id).unref();
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = lockHolder(id);
      if (holder && holder !== process.pid) return false;
      try { fs.unlinkSync(lockPath(id)); } catch {}
    }
  }
  return false;
}
export function releaseLock(id) {
  clearInterval(heartbeats.get(id));
  heartbeats.delete(id);
  if (readJSON(lockPath(id), {})?.token === LOCK_TOKEN) {
    try { fs.unlinkSync(lockPath(id)); } catch {}
  }
}

// ---------- global limit: pi agents running at once on this machine ----------
// One slot file per running pi process, under ~/.pi-subagents/slots. A slot whose owner died or stopped
// beating is free again. maxAgents = 0 turns the limit off.
export const SLOTS = path.join(HOME, 'slots');
export let mySlot = null;
export let slotWant = null; // { max, id }: to take a slot again if ours was taken over
export let slotError = ''; // set when not one slot file could be written, for a reason other than "taken"
export function slotFree(file) {
  const s = readJSON(file, null);
  return !s || !isAlive(Number(s.pid)) || now() - Number(s.at || 0) > LOCK_STALE_MS;
}
export function tryTakeSlot(max, id) {
  slotWant = { max, id };
  slotError = '';
  mkdirp(SLOTS);
  let errors = 0;
  for (let i = 0; i < max; i++) {
    const file = path.join(SLOTS, `slot-${i}.json`);
    const body = JSON.stringify({ pid: process.pid, id, at: now(), token: LOCK_TOKEN });
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: FILE_MODE });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Windows refuses a file that is being deleted for a moment: that slot is tried again on the next pass
        if (++errors === max) slotError = e.message;
        continue;
      }
      // Take over a dead slot under a lock, so two waiters cannot both take it
      const took = withFileLock(file, () => {
        if (!slotFree(file)) return false;
        writeJSON(file, JSON.parse(body));
        return true;
      });
      if (took) return file;
    }
  }
  return null;
}
export function beatSlot() {
  if (!mySlot) return;
  if (readJSON(mySlot, {})?.token === LOCK_TOKEN) {
    try { writeJSON(mySlot, { ...readJSON(mySlot, {}), at: now() }); } catch {}
    return;
  }
  // Another agent took our slot over (we were hung long enough to look dead): take a free one again, so this
  // agent is counted; while none is free it stays uncounted and tries again on the next beat
  if (slotWant) mySlot = tryTakeSlot(slotWant.max, slotWant.id) || mySlot;
}
// Take a slot for this process (the broker's wait loop); false while none is free
export function takeSlot(max, id) {
  mySlot = tryTakeSlot(max, id);
  return !!mySlot;
}
export const hasSlot = () => !!mySlot;
export function releaseSlot() {
  if (mySlot && readJSON(mySlot, {})?.token === LOCK_TOKEN) try { fs.unlinkSync(mySlot); } catch {}
  mySlot = null;
}
export const runningSlots = () => {
  try {
    return fs.readdirSync(SLOTS).filter(f => f.endsWith('.json') && !slotFree(path.join(SLOTS, f))).length;
  } catch {
    return 0;
  }
};
export function launchServe(id) {
  const st = readState(id);
  if (st?.kind === 'flow' && st.status !== 'starting') {
    // A workflow runner starts once, when the workflow is created. Restarting it would run the script
    // from the top again, so later messages (only "stop") are handled right here.
    for (const f of inboxFiles(id)) try { fs.unlinkSync(path.join(inboxDir(id), f)); } catch {}
    if (!TERMINAL.has(st.status)) {
      stopChildren(id);
      saveState(id, { status: 'stopped', rounds: (st.rounds || 0) + 1, lastError: L('the workflow runner process is gone', '工作流执行进程已不在') });
    }
    return;
  }
  const log = fs.openSync(path.join(runDir(id), 'serve.log'), 'a', FILE_MODE);
  // A workflow script runs in its runner: cap its memory so a runaway script cannot take the machine down
  const nodeArgs = st?.kind === 'flow' ? ['--max-old-space-size=2048'] : [];
  const child = spawn(process.execPath, [...nodeArgs, SELF, st?.kind === 'flow' ? '_flow' : '_serve', id], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    cwd: runDir(id),
  });
  child.on('error', e => {
    try { saveState(id, { status: 'error', lastError: L(`could not start the background process: ${e.message}`, `后台进程启动失败：${e.message}`), rounds: (readState(id)?.rounds || 0) + 1, finishedAt: now() }); } catch {}
  });
  child.unref();
  fs.closeSync(log);
}

// ---------- commands ----------
// Create an agent's run directory and queue its first task (does not start the broker). Throws on error.
// extra: additional state.json fields (workflow children carry parent, phase and label)
export function createRun({ task, model, thinking, cwd, readonly, name, owner, origin, from, extra, isolation }) {
  if (isolation && isolation !== 'worktree' && isolation !== 'none')
    throw new Error(L(`unknown isolation "${isolation}" (only "worktree" is supported)`, `不认识的 isolation「${isolation}」（只支持 "worktree"）`));
  const cfg = loadConfig();
  const m = resolveModel(model, cfg);
  let provider = m.provider;
  if (m.pool.length) {
    provider = provider && providerAvailable(provider) ? provider : pickProvider(m.pool);
    if (!provider)
      throw new Error(
        L(
          `every provider in the pool of "${m.alias}" is cooling down (${m.pool.join(', ')}); see \`pisub accounts\``,
          `「${m.alias}」轮换池里的提供方都在冷却中（${m.pool.join('、')}），用 \`pisub accounts\` 查看`
        )
      );
  }
  cwd = path.resolve(cwd || process.cwd());
  if (!fs.existsSync(cwd)) throw new Error(L(`working directory does not exist: ${cwd}`, `工作目录不存在：${cwd}`));
  const id = newRunDir(name || m.alias);
  // A read-only agent cannot change anything, so it needs no worktree
  let worktree = null;
  if (isolation === 'worktree' && !readonly) {
    try {
      worktree = createWorktree(id, cwd);
    } catch (e) {
      try { fs.rmSync(runDir(id), { recursive: true, force: true }); } catch {}
      throw e;
    }
    task = worktreeIntro(worktree) + task;
  }
  writePrivate(path.join(runDir(id), 'task.md'), task);
  writeJSON(statePath(id), {
    id,
    name: name || '',
    alias: m.alias,
    provider: provider || '',
    model: m.model || '',
    pool: m.pool,
    thinking: thinking || m.thinking || '',
    cwd,
    readonly: !!readonly,
    owner: owner || process.env.PI_SUBAGENTS_OWNER || '',
    origin: origin || 'cli',
    status: 'starting',
    task: trunc(task, 400),
    createdAt: now(),
    updatedAt: now(),
    rounds: 0,
    accountsTried: provider && m.pool.length ? [provider] : [],
    ...(worktree ? { worktree } : {}),
    ...(extra || {}),
  });
  enqueue(id, { text: task, from: from || 'claude', mode: 'prompt' });
  return { id, provider: provider || '', model: m.model || '', alias: m.alias };
}

export function listStates(owner) {
  let ids = [];
  try {
    ids = fs.readdirSync(RUNS);
  } catch {}
  return ids
    .map(id => readState(id))
    // Workflow children are listed under their workflow, not on their own
    .filter(st => st && (owner ? st.owner === owner : !st.parent))
    .sort((a, b) => b.createdAt - a.createdAt);
}
export const STATUS_NAMES = {
  starting: ['starting', '启动中'],
  queued: ['waiting for a slot', '排队中'],
  running: ['running', '运行中'],
  retrying: ['retrying', '重试中'],
  waiting: ['waiting to retry', '等待重试'],
  done: ['done', '完成'],
  error: ['error', '出错'],
  stopped: ['stopped', '已停止'],
};
export const statusName = s => (STATUS_NAMES[s] ? L(...STATUS_NAMES[s]) : s);
// A broker that died (crash, killed, machine shut down) leaves its run "running" in state.json for good
export const isLost = st => !TERMINAL.has(st.status) && !isServing(st.id) && now() - (st.updatedAt || 0) > 15000;
// Settle a lost run, once, for whoever looks first (status, wait, the pane): restart it when messages are
// waiting, otherwise record the failure with a final answer, so the side waiting for it gets notified.
export function reconcile(st) {
  if (!st || !isLost(st)) return st;
  if (st.kind !== 'flow' && hasInbox(st.id)) {
    launchServe(st.id);
    return { ...st, status: 'starting' };
  }
  return withFileLock(path.join(runDir(st.id), 'reconcile'), () => {
    const cur = readState(st.id);
    if (!cur || !isLost(cur)) return cur;
    const flow = cur.kind === 'flow';
    if (flow) stopChildren(cur.id);
    const msg = flow
      ? L('the workflow runner process is gone (see serve.log); its agents were stopped', '工作流执行进程已不在（见 serve.log），它的代理已停止')
      : L('the broker process exited unexpectedly (see serve.log and pi-stderr.log)', 'broker 进程意外退出（见 serve.log 和 pi-stderr.log）');
    const round = (cur.rounds || 0) + 1;
    try {
      writePrivate(path.join(runDir(cur.id), 'final.md'), `${errorTitle()}${msg}\n`);
      appendPrivate(path.join(runDir(cur.id), 'view.jsonl'), JSON.stringify({ t: now(), k: 'error', text: msg }) + '\n' + JSON.stringify({ t: now(), k: 'done', status: 'error', round }) + '\n');
    } catch {}
    return saveState(cur.id, { status: 'error', lastError: msg, finishedAt: now(), rounds: round });
  });
}
export async function waitFor(id, before, timeoutSec) {
  const t0 = now();
  for (;;) {
    const st = readState(id);
    if (st && st.rounds > before && TERMINAL.has(st.status) && !hasInbox(id)) return st;
    if (st && isLost(st)) {
      const r = reconcile(st);
      if (r && TERMINAL.has(r.status) && !hasInbox(id)) return r;
    }
    if (timeoutSec && now() - t0 > timeoutSec * 1000) return null;
    // Messages waiting but no broker (e.g. it just exited): start one
    if (hasInbox(id) && !isServing(id) && now() - (readState(id)?.updatedAt || 0) > 5000) launchServe(id);
    await sleep(1000);
  }
}
export async function waitAndPrint(id, before, timeoutSec) {
  const st = await waitFor(id, before, timeoutSec);
  if (!st) {
    out(L(`${id} is still running (wait timed out). Get the result later with \`pisub wait ${id}\` or \`pisub result ${id}\`.`, `${id} 仍在运行（等待超时）。之后用 \`pisub wait ${id}\` 或 \`pisub result ${id}\` 取结果。`));
    process.exit(124);
  }
  const f = path.join(runDir(id), 'final.md');
  out(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : L(`(${id} ended with status ${st.status} and no final answer)`, `（${id} 结束，状态：${st.status}，没有最终回答）`));
  process.exit(st.status === 'done' ? 0 : st.status === 'stopped' ? 2 : 1);
}
export function stopChildren(id) {
  for (const c of readState(id).children || []) {
    if (!c.id) continue;
    const cs = readState(c.id);
    if (!cs || TERMINAL.has(cs.status)) continue;
    if (isServing(c.id)) enqueue(c.id, { control: 'stop' });
    else {
      // Its broker has not started yet: drop its task so it does not start working later
      for (const f of inboxFiles(c.id)) try { fs.unlinkSync(path.join(inboxDir(c.id), f)); } catch {}
      saveState(c.id, { status: 'stopped', rounds: (cs.rounds || 0) + 1 });
    }
  }
}
