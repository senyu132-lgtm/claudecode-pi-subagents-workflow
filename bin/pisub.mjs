#!/usr/bin/env node
// pisub: run the pi coding agent as a background "sub-agent" for Claude Code.
// Each agent is a broker process detached from the Claude session; the broker drives `pi --mode rpc`.
// Run directories live in ~/.pi-subagents/runs/<id>/ (set PI_SUBAGENTS_HOME to move the root).
//
// Usage (full help: `node pisub.mjs help`):
//   spawn  [--model alias|provider/model] [--thinking lvl] [--cwd dir] [--readonly] [--worktree]
//          [--name name] [--owner session-id] [--wait] [--timeout sec] [--json]
//          (--task-file file | --stdin | task text...)
//   send   <id> [--mode steer|follow_up] [--from claude|user] [--wait] (--stdin | text...)
//   status [id] [--owner session-id] [--json] [--limit N]
//   log    <id> [--tail N] [--full]
//   result <id> | wait <id> [--timeout sec] | stop <id>
//   models [--json] | models --pi [search]
//   accounts [reset [provider]]
//   flow   run|enable|disable ...  (pi workflows, see help)
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkScript, extractJSON, runFlow, validate } from './flow.mjs';
import { L, language, setLanguage } from './i18n.mjs';

const SELF = fileURLToPath(import.meta.url);
const HOME = process.env.PI_SUBAGENTS_HOME || path.join(os.homedir(), '.pi-subagents');
const RUNS = path.join(HOME, 'runs');
const ACCOUNTS_FILE = path.join(HOME, 'accounts.json');
const CONFIG_FILE = path.join(HOME, 'config.json');
const TERMINAL = new Set(['done', 'error', 'stopped']);

const DEFAULT_CONFIG = {
  language: 'en', // 'en' or 'zh'; the env var PISUB_LANG overrides it
  defaultAlias: '', // alias used when no model is given; empty = pi's own default model
  // name -> { provider?, providers?, model, thinking? }
  //   provider:  pi provider name, e.g. "anthropic"
  //   providers: a rotation pool of pi providers serving the same model (e.g. several accounts);
  //              when one hits its usage limit the agent switches to the next and carries on
  aliases: {},
  contextFiles: false, // true = let pi load AGENTS.md / CLAUDE.md context files as it normally does
  exhaustedCooldownMin: 60, // how long a provider rests after a usage-limit error that names no reset time
  overloadBackoffSec: [20, 40, 80, 160, 300, 300], // broker retries after pi's own retries give up
  flowConcurrency: { default: 4 }, // workflows: agents running at once, per model alias
  flowStaggerMs: {}, // workflows: minimum gap between agent starts, per model alias (ms)
  maxAgents: 16, // pi agents running at once on this machine, across every session and workflow (0 = no limit)
  rpcTimeoutSec: 60, // how long to wait for pi to answer a command before treating it as hung
  stallTimeoutMin: 20, // a working agent that sends nothing for this long (no tool running) is stopped as hung (0 = off)
  toolTimeoutMin: 120, // a single tool call that runs longer than this is treated as hung (0 = off)
  keepRunsDays: 30, // finished runs older than this are deleted automatically (0 = keep forever)
};

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const out = s => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
function die(msg, code = 1) {
  process.stderr.write(`pisub: ${msg}\n`);
  process.exit(code);
}
// A missing file gives the fallback. With strict, a file that exists but cannot be read or parsed throws
// instead of being taken for "empty", so a broken config is reported rather than silently ignored.
function readJSON(file, fallback, strict = false) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (!strict || e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    if (!strict) return fallback;
    throw new Error(L(`${file} is not valid JSON: ${e.message}`, `${file} 不是合法的 JSON：${e.message}`));
  }
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// Runs hold tasks, transcripts and tool output: keep them readable by this user only (no effect on Windows,
// where the user profile folder is already private)
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const mkdirp = dir => fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
const writePrivate = (file, data) => fs.writeFileSync(file, data, { mode: FILE_MODE });
const appendPrivate = (file, data) => fs.appendFileSync(file, data, { mode: FILE_MODE });
// Cross-process lock for a read-modify-write of a shared file: an exclusive "<file>.lock". A holder that
// died or hung for staleMs loses it, so a crash never blocks everyone else for good.
function withFileLock(file, fn, staleMs = 10000) {
  const lock = `${file}.lock`;
  const t0 = now();
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid} ${now()}`, { flag: 'wx', mode: FILE_MODE });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      let age = 0;
      try {
        age = now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > staleMs || now() - t0 > staleMs * 2) try { fs.unlinkSync(lock); } catch {}
      else sleepSync(5 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch {}
  }
}
// Kill a process and everything it started (pi's shell commands, sh() children)
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGKILL'); // its process group (children are started detached, as group leaders)
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
}
function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: FILE_MODE });
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // On Windows, rename can fail with EPERM while another process reads the target; retry briefly
      if (i >= 40) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      sleepSync(25);
    }
  }
}
function trunc(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + L(`… (${s.length} chars, truncated)`, `…（共 ${s.length} 字，已截断）`) : s;
}
function loadConfig() {
  let user;
  try {
    user = readJSON(CONFIG_FILE, {}, true) || {};
  } catch (e) {
    die(L(`cannot use the config file: ${e.message}`, `配置文件有问题：${e.message}`));
  }
  return {
    ...DEFAULT_CONFIG,
    ...user,
    aliases: user.aliases && typeof user.aliases === 'object' ? user.aliases : {},
    flowConcurrency: { ...DEFAULT_CONFIG.flowConcurrency, ...(user.flowConcurrency || {}) },
    flowStaggerMs: { ...(user.flowStaggerMs || {}) },
  };
}
setLanguage(process.env.PISUB_LANG || loadConfig().language);

// Sent to pi after the broker recovered from a usage limit or an overload
// The tool calls made before the interruption already happened: the notice asks the model to check before
// repeating anything that changes files or outside systems (exactly-once is not something we can promise).
const continueText = () =>
  L(
    '(System notice: the previous request was interrupted by a usage limit or a service overload and has now recovered. Continue the original task from where it stopped. Steps you already ran did take effect: before repeating anything that writes files, runs commands with side effects or calls outside services, check whether it was already done, and do not do it twice.)',
    '（系统通知：刚才的请求因额度用尽或服务过载而中断，现已恢复。请从中断处继续完成原任务。中断前执行过的步骤已经生效：凡是写文件、执行有副作用的命令、调用外部服务的操作，重做之前先检查是否已经做过，不要做两遍。）'
  );

// ---------- locating pi ----------
const PI_PACKAGES = ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent', 'pi-coding-agent'];
function globalRoots() {
  const exeDir = path.dirname(process.execPath);
  return [
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
    process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(exeDir, '..', 'lib', 'node_modules'), // nvm, fnm, volta, official tarballs
    path.join(exeDir, 'node_modules'), // Windows installer layout
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean);
}
function binOf(dir) {
  const pkg = readJSON(path.join(dir, 'package.json'), null);
  if (!pkg) return null;
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin.pi || Object.values(pkg.bin)[0]);
  const p = bin && path.join(dir, bin);
  return p && fs.existsSync(p) ? p : null;
}
function findCli() {
  if (process.env.PI_CLI && fs.existsSync(process.env.PI_CLI)) return process.env.PI_CLI;
  const search = roots => {
    for (const r of roots) for (const name of PI_PACKAGES) {
      const p = binOf(path.join(r, name));
      if (p) return p;
    }
    return null;
  };
  let p = search(globalRoots());
  if (p) return p;
  // Last resort: ask npm where global packages live
  try {
    const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 20000,
      shell: process.platform === 'win32',
      windowsHide: true,
    }).trim();
    if (root) p = search([root]);
  } catch {}
  return p;
}
const noCli = () =>
  L(
    "cannot find pi's CLI. Install pi globally with npm, or set the env var PI_CLI to the path of pi's cli.js",
    '找不到 pi 的 CLI。请用 npm 全局安装 pi，或把环境变量 PI_CLI 设为 pi 的 cli.js 路径'
  );
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---------- run directories ----------
function checkId(id) {
  if (!id || !/^[\w.-]+$/.test(id)) die(L(`invalid agent id: ${id ?? '(empty)'}`, `无效的代理编号：${id ?? '（空）'}`));
  if (!fs.existsSync(path.join(RUNS, id, 'state.json'))) die(L(`no agent named ${id}`, `找不到代理 ${id}`));
  return id;
}
const runDir = id => path.join(RUNS, id);
const statePath = id => path.join(runDir(id), 'state.json');
const inboxDir = id => path.join(runDir(id), 'inbox');
const readState = id => readJSON(statePath(id), null);
// Several processes write state.json (the broker, a workflow runner, stop/wait commands): every update is a
// locked read-modify-write, carries a version number, and the round counter never goes backwards.
function saveState(id, patch) {
  return withFileLock(statePath(id), () => {
    const cur = readState(id) || {};
    const st = { ...cur, ...patch, updatedAt: now(), version: (cur.version || 0) + 1 };
    if ((cur.rounds || 0) > (st.rounds || 0)) st.rounds = cur.rounds;
    writeJSON(statePath(id), st);
    return st;
  });
}
function makeId(alias) {
  const t = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
  const safe = String(alias).replace(/[^\w.-]/g, '').slice(0, 24) || 'pi';
  return `${safe}-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}
// A new run directory under a fresh id. Created exclusively, so two runs can never share a folder.
function newRunDir(alias) {
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
function inboxFiles(id) {
  try {
    return fs.readdirSync(inboxDir(id)).filter(f => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}
const hasInbox = id => inboxFiles(id).length > 0;
// Messages are files named so that they sort in sending order: time, then a counter for messages this process
// sent within the same millisecond. A message stays in the inbox until pi has accepted it (see deliver()).
let enqueueSeq = 0;
function enqueue(id, msg) {
  mkdirp(inboxDir(id));
  const name = `${String(now()).padStart(14, '0')}-${String(++enqueueSeq).padStart(6, '0')}-${process.pid}`;
  const tmp = path.join(inboxDir(id), name + '.tmp');
  writePrivate(tmp, JSON.stringify({ ...msg, at: now() }));
  fs.renameSync(tmp, path.join(inboxDir(id), name + '.json'));
}

// ---------- lock: one broker per agent ----------
// The holder rewrites its lock every few seconds. A lock whose process is gone, or whose heartbeat stopped
// (the process hung, or the pid now belongs to some other program), no longer counts.
const lockPath = id => path.join(runDir(id), 'serve.lock');
const HEARTBEAT_MS = 5000;
const LOCK_STALE_MS = 60000;
const LOCK_TOKEN = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
function lockHolder(id) {
  const l = readJSON(lockPath(id), null);
  const pid = Number(l?.pid);
  return isAlive(pid) && now() - Number(l.at || 0) < LOCK_STALE_MS ? pid : null;
}
const isServing = id => lockHolder(id) !== null;
const heartbeats = new Map();
function acquireLock(id) {
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
function releaseLock(id) {
  clearInterval(heartbeats.get(id));
  heartbeats.delete(id);
  if (readJSON(lockPath(id), {})?.token === LOCK_TOKEN) {
    try { fs.unlinkSync(lockPath(id)); } catch {}
  }
}

// ---------- global limit: pi agents running at once on this machine ----------
// One slot file per running pi process, under ~/.pi-subagents/slots. A slot whose owner died or stopped
// beating is free again. maxAgents = 0 turns the limit off.
const SLOTS = path.join(HOME, 'slots');
let mySlot = null;
function slotFree(file) {
  const s = readJSON(file, null);
  return !s || !isAlive(Number(s.pid)) || now() - Number(s.at || 0) > LOCK_STALE_MS;
}
function tryTakeSlot(max, id) {
  mkdirp(SLOTS);
  for (let i = 0; i < max; i++) {
    const file = path.join(SLOTS, `slot-${i}.json`);
    const body = JSON.stringify({ pid: process.pid, id, at: now(), token: LOCK_TOKEN });
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: FILE_MODE });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') continue;
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
function beatSlot() {
  if (mySlot && readJSON(mySlot, {})?.token === LOCK_TOKEN) try { writeJSON(mySlot, { ...readJSON(mySlot, {}), at: now() }); } catch {}
}
function releaseSlot() {
  if (mySlot && readJSON(mySlot, {})?.token === LOCK_TOKEN) try { fs.unlinkSync(mySlot); } catch {}
  mySlot = null;
}
const runningSlots = () => {
  try {
    return fs.readdirSync(SLOTS).filter(f => f.endsWith('.json') && !slotFree(path.join(SLOTS, f))).length;
  } catch {
    return 0;
  }
};
function launchServe(id) {
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
function ensureServing(id) {
  if (!isServing(id)) launchServe(id);
}

// ---------- models and provider pools ----------
function loadCooldowns() {
  try {
    return readJSON(ACCOUNTS_FILE, {}, true) || {};
  } catch (e) {
    // Do not lose it silently: keep the broken file aside and say so
    const keep = `${ACCOUNTS_FILE}.broken-${now()}`;
    try { fs.renameSync(ACCOUNTS_FILE, keep); } catch {}
    process.stderr.write(`pisub: ${e.message}; moved it to ${keep} and started with no cooldowns\n`);
    return {};
  }
}
function providerAvailable(p, acc = loadCooldowns()) {
  const a = acc[p];
  return !a || !a.until || a.until <= now();
}
function pickProvider(pool, exclude = []) {
  const acc = loadCooldowns();
  return pool.find(p => !exclude.includes(p) && providerAvailable(p, acc)) || null;
}
function markExhausted(p, minutes, reason) {
  mkdirp(HOME);
  withFileLock(ACCOUNTS_FILE, () => {
    const acc = loadCooldowns();
    acc[p] = { until: now() + minutes * 60000, at: now(), reason: trunc(reason, 300) };
    writeJSON(ACCOUNTS_FILE, acc);
  });
}
const allPoolProviders = cfg => [...new Set(Object.values(cfg.aliases).flatMap(a => (Array.isArray(a?.providers) ? a.providers : [])))];
function aliasInfo(name, a) {
  const pool = Array.isArray(a.providers) ? a.providers.filter(x => typeof x === 'string' && x) : [];
  return { alias: name, provider: a.provider || pool[0] || null, model: a.model || null, pool, thinking: a.thinking };
}
function resolveModel(spec, cfg) {
  spec = String(spec || cfg.defaultAlias || '').trim();
  // Nothing configured: let pi pick its own default model
  if (!spec) return { alias: 'pi', provider: null, model: null, pool: [], thinking: undefined };
  const a = cfg.aliases[spec];
  if (a && typeof a === 'object') return aliasInfo(spec, a);
  // A full provider/model that an alias already covers: use the alias (keeps its pool and thinking level)
  const same = Object.entries(cfg.aliases).find(
    ([, v]) => v && v.model && [v.provider, ...(Array.isArray(v.providers) ? v.providers : [])].filter(Boolean).some(p => `${p}/${v.model}` === spec)
  );
  if (same) return aliasInfo(same[0], same[1]);
  const i = spec.indexOf('/');
  if (i > 0) return { alias: spec.slice(i + 1), provider: spec.slice(0, i), model: spec.slice(i + 1), pool: [], thinking: undefined };
  // Anything else goes to pi's --model as a pattern (pi does fuzzy matching)
  return { alias: spec, provider: null, model: spec, pool: [], thinking: undefined };
}
const modelLabel = st => (st.model ? (st.provider ? `${st.provider}/${st.model}` : st.model) : L('(pi default)', '（pi 默认）'));
const isUsageLimit = e => /usage.?limit|usage_not_included|insufficient_quota|quota.?exceeded/i.test(e || '');
const isTransient = e =>
  /overload|too many requests|rate.?limit|server_busy|capacity|(?<![\d])(429|500|502|503|504|520|524)(?![\d])|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|network|terminated|timed? ?out|connection error/i.test(
    e || ''
  );
function minutesFrom(e) {
  const m = /try again in ~?\s*(\d+)\s*min/i.exec(e || '');
  return m ? Math.max(1, Number(m[1])) : null;
}

// ---------- git ----------
function git(cwd, args, { input, raw } = {}) {
  const r = spawnSync('git', args, { cwd, input, windowsHide: true, maxBuffer: 512 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' });
  return { ok: r.status === 0, out: r.stdout ?? (raw ? Buffer.alloc(0) : ''), err: String(r.stderr || r.error?.message || '').trim() };
}
const gitOut = (cwd, args) => {
  const r = git(cwd, args);
  return r.ok ? r.out.trim() : null;
};
// Commits made for you use your git identity if you have one. Hooks and signing are skipped: nobody is
// there to type a passphrase, and a slow pre-commit hook should not hold up an agent.
function gitCommit(cwd, message) {
  const named = gitOut(cwd, ['config', 'user.email']);
  const who = named ? [] : ['-c', 'user.name=pi-subagents', '-c', 'user.email=pi-subagents@localhost'];
  return git(cwd, [...who, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message]);
}

// What the repository around cwd looks like now: HEAD plus a hash of every uncommitted change (path, status,
// size, modification time). Cheap, and writes nothing. null outside a repository.
function gitSignature(cwd) {
  const root = gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const head = gitOut(root, ['rev-parse', '-q', '--verify', 'HEAD']) || '';
  const st = git(root, ['--no-optional-locks', '-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!st.ok) return null;
  const h = crypto.createHash('sha1');
  const entries = st.out.split('\0').filter(Boolean);
  for (const e of entries) {
    let f = 'x';
    try {
      const s = fs.statSync(path.join(root, e.slice(3)));
      f = `${s.size}:${Math.round(s.mtimeMs)}`;
    } catch {}
    h.update(`${e}\0${f}\n`);
  }
  return { root, head, dirty: entries.length, sig: h.digest('hex').slice(0, 16) };
}

// ---------- workflow inputs: fingerprint of the files an agent reads ----------
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
const HASH_FULL_MAX = 64 * 1024 * 1024; // bigger files are fingerprinted by size and modification time
function hashInputs(paths, cwd) {
  const h = crypto.createHash('sha1');
  let files = 0;
  const walk = (abs, rel) => {
    let s;
    try {
      s = fs.lstatSync(abs);
    } catch {
      return h.update(`missing ${rel}\n`);
    }
    if (s.isSymbolicLink()) return h.update(`link ${rel} ${fs.readlinkSync(abs)}\n`);
    if (s.isDirectory()) {
      h.update(`dir ${rel}\n`);
      for (const name of fs.readdirSync(abs).sort()) if (!SKIP_DIRS.has(name)) walk(path.join(abs, name), `${rel}/${name}`);
      return;
    }
    if (!s.isFile()) return;
    if (++files > 100000) throw new Error(L(`inputs cover more than 100000 files; name narrower paths`, `inputs 涵盖的文件超过 100000 个，请写得更具体`));
    h.update(`file ${rel} ${s.size}\n`);
    if (s.size > HASH_FULL_MAX) h.update(`mtime ${Math.round(s.mtimeMs)}\n`);
    else h.update(fs.readFileSync(abs));
  };
  for (const p of paths) walk(path.resolve(cwd, p), p.replace(/\\/g, '/'));
  return h.digest('hex').slice(0, 16);
}

// ---------- worktrees: agents that change files without touching yours ----------
const MAX_UNTRACKED = 50 * 1024 * 1024; // untracked files bigger than this are not copied into a worktree

// A new branch pi/<id> checked out under the agent's run directory. It starts from HEAD plus your
// uncommitted changes (edits to tracked files and untracked, non-ignored files), committed on the branch as
// a "snapshot" commit, so the agent sees what you see. Ignored files (node_modules, build output, ignored
// data) are not there. Throws when it cannot be done.
function createWorktree(id, cwd) {
  const root = gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error(L(`isolation "worktree" needs a working directory inside a git repository (${cwd} is not)`, `isolation "worktree" 要求工作目录在 git 仓库里（${cwd} 不是）`));
  const head = gitOut(root, ['rev-parse', '-q', '--verify', 'HEAD']);
  if (!head) throw new Error(L('isolation "worktree" needs a repository with at least one commit', 'isolation "worktree" 要求仓库里至少有一次提交'));
  const prefix = gitOut(cwd, ['rev-parse', '--show-prefix']) || '';
  const dir = path.join(runDir(id), 'wt');
  const branch = `pi/${id}`;
  let r;
  for (let i = 0; i < 4; i++) {
    r = git(root, ['worktree', 'add', '-q', '-b', branch, dir, head]);
    if (r.ok) break;
    // Another agent may be holding a git lock: clean up the half-made attempt and try again
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    git(root, ['worktree', 'prune']);
    git(root, ['branch', '-q', '-D', branch]);
    sleepSync(300 * (i + 1));
  }
  if (!r.ok) throw new Error(L(`could not create a git worktree: ${r.err}`, `创建 git worktree 失败：${r.err}`));

  const notes = [];
  let staged = false;
  // Edits to tracked files: applied to the index (in git's own line endings), checked out below
  const diff = git(root, ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff'], { raw: true });
  if (diff.ok && diff.out.length) {
    const a = git(dir, ['apply', '--cached', '--binary', '--whitespace=nowarn'], { input: diff.out });
    if (a.ok) staged = true;
    else notes.push(L(`your uncommitted edits to tracked files could not be copied in (${trunc(a.err, 200)})`, `你对已跟踪文件的未提交修改没能复制进来（${trunc(a.err, 200)}）`));
  }
  // Untracked, non-ignored files: copied as they are
  const list = git(root, ['-c', 'core.quotePath=false', 'ls-files', '-o', '--exclude-standard', '-z']);
  const copied = [];
  const skipped = [];
  for (const rel of list.ok ? list.out.split('\0').filter(Boolean) : []) {
    try {
      const src = path.join(root, rel);
      const s = fs.statSync(src);
      if (!s.isFile()) continue;
      if (s.size > MAX_UNTRACKED) {
        skipped.push(rel);
        continue;
      }
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(src, path.join(dir, rel));
      copied.push(rel);
    } catch {}
  }
  if (copied.length) {
    const a = git(dir, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: copied.join('\0') });
    if (a.ok) staged = true;
  }
  if (skipped.length)
    notes.push(L(`untracked files over 50 MB were not copied in: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ' …' : ''}`, `超过 50 MB 的未跟踪文件没有复制进来：${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? ' …' : ''}`));
  let base = head;
  if (staged && !git(dir, ['diff', '--cached', '--quiet']).ok) {
    const c = gitCommit(dir, 'pi-subagents: snapshot of uncommitted changes');
    if (c.ok) {
      base = gitOut(dir, ['rev-parse', 'HEAD']) || head;
      git(dir, ['reset', '-q', '--hard']);
    } else notes.push(L(`your uncommitted changes could not be committed in the worktree (${trunc(c.err, 200)})`, `未提交的修改没能在 worktree 里提交（${trunc(c.err, 200)}）`));
  }
  return { root, dir, branch, head, base, prefix, notes };
}
// Before a round: bring back a worktree removed after an earlier round. Returns an error message or ''.
function ensureWorktree(w) {
  if (fs.existsSync(w.dir)) return '';
  git(w.root, ['worktree', 'prune']);
  const has = git(w.root, ['rev-parse', '-q', '--verify', `refs/heads/${w.branch}`]).ok;
  let r = git(w.root, has ? ['worktree', 'add', '-q', w.dir, w.branch] : ['worktree', 'add', '-q', '-b', w.branch, w.dir, w.base]);
  // A snapshot commit nothing points to any more may have been garbage-collected: start from HEAD then
  if (!r.ok && !has) r = git(w.root, ['worktree', 'add', '-q', '-b', w.branch, w.dir, w.head]);
  return r.ok ? '' : r.err;
}
// After a round: commit what the agent changed on its branch. Returns { changed, stat, error? } or null.
function commitWorktree(st) {
  const w = st.worktree;
  if (!w || !fs.existsSync(w.dir)) return null;
  git(w.dir, ['add', '-A']);
  let error = '';
  if (!git(w.dir, ['diff', '--cached', '--quiet']).ok) {
    const c = gitCommit(w.dir, `pi-subagents: ${st.name || st.id} (round ${(st.rounds || 0) + 1})`);
    if (!c.ok) error = c.err;
  }
  const stat = gitOut(w.root, ['diff', '--shortstat', w.base, w.branch]) || '';
  return { changed: !!stat || !!error, stat, ...(error ? { error: trunc(error, 300) } : {}) };
}
function removeWorktree(w) {
  if (!git(w.root, ['worktree', 'remove', '--force', w.dir]).ok) {
    try { fs.rmSync(w.dir, { recursive: true, force: true }); } catch {}
    git(w.root, ['worktree', 'prune']);
  }
  git(w.root, ['branch', '-q', '-D', w.branch]);
}
// Tells the agent where it is working. Prepended to its first task.
function worktreeIntro(w) {
  const here = path.join(w.dir, w.prefix || '');
  return (
    L(
      `(Isolation: you are working in your own git worktree, ${here}, a copy of the repository ${w.root} on branch ${w.branch}. Make every change inside this worktree: when the task names a path under ${w.root}, use the same relative path under ${w.dir}. Do not commit; your changes are committed for review when you finish.`,
      `（隔离说明：你在自己的 git worktree 里工作，目录 ${here}，它是仓库 ${w.root} 的一份拷贝，分支 ${w.branch}。所有修改都在这个 worktree 里做：任务里提到 ${w.root} 下的路径时，改用 ${w.dir} 下相同的相对路径。不要自己提交，你做完后改动会自动提交，供人审查。`
    ) +
    (w.notes.length ? ' ' + L('Note: ', '注意：') + w.notes.join(L('; ', '；')) : '') +
    L(')\n\n', '）\n\n')
  );
}
// What happened to an agent's worktree, for its final answer and the notification
function worktreeReport(w, rep, id) {
  if (!w || !rep) return '';
  w = { ...w, id };
  if (!rep.changed) return L(`(No files were changed, so the worktree and branch ${w.branch} were removed.)`, `（没有改动文件，worktree 和分支 ${w.branch} 已删除。）`);
  const q = `git -C "${w.root}"`;
  const base = w.base.slice(0, 12);
  return L(
    `Changes are committed on branch ${w.branch}${rep.stat ? ` (${rep.stat})` : ''}${rep.error ? `, but the last commit failed: ${rep.error}` : ''}. Worktree: ${w.dir}\n` +
      `  review:  ${q} diff ${base} ${w.branch}\n` +
      `  apply to your working tree:  pisub apply ${w.id}   (check first: pisub apply ${w.id} --check)\n` +
      `  clean up afterwards:  pisub clean ${w.id} --branches`,
    `改动已提交到分支 ${w.branch}${rep.stat ? `（${rep.stat}）` : ''}${rep.error ? `，但最后一次提交失败：${rep.error}` : ''}。worktree：${w.dir}\n` +
      `  查看：  ${q} diff ${base} ${w.branch}\n` +
      `  应用到你的工作区：  pisub apply ${w.id}   （先检查：pisub apply ${w.id} --check）\n` +
      `  用完清理：  pisub clean ${w.id} --branches`
  );
}

// ---------- arguments ----------
function parseArgs(argv, booleans) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      o._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (booleans.includes(k)) o[k] = true;
      else o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
async function getText(o) {
  if (o['task-file']) return fs.readFileSync(o['task-file'], 'utf8');
  if (o['text-file']) return fs.readFileSync(o['text-file'], 'utf8');
  if (o.stdin) return readStdin();
  return o._.join(' ');
}

// ---------- commands ----------
// Create an agent's run directory and queue its first task (does not start the broker). Throws on error.
// extra: additional state.json fields (workflow children carry parent, phase and label)
function createRun({ task, model, thinking, cwd, readonly, name, owner, origin, from, extra, isolation }) {
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

async function cmdSpawn(argv) {
  const o = parseArgs(argv, ['readonly', 'wait', 'json', 'stdin', 'worktree']);
  const task = await getText(o);
  if (!task.trim()) die(L('no task given (use --task-file, --stdin, or write it after the options)', '没有任务描述（用 --task-file、--stdin 或直接写在后面）'));
  let r;
  try {
    r = createRun({ task, model: o.model, thinking: o.thinking, cwd: o.cwd, readonly: o.readonly, name: o.name, owner: o.owner, origin: o.origin, from: o.from, isolation: o.worktree ? 'worktree' : o.isolation });
  } catch (e) {
    die(e.message);
  }
  launchServe(r.id);
  if (o.wait) return waitAndPrint(r.id, 0, Number(o.timeout) || 0);
  if (o.json) out(JSON.stringify({ id: r.id, dir: runDir(r.id), model: modelLabel(r) }));
  else out(r.id);
}

async function cmdSend(argv) {
  const o = parseArgs(argv, ['wait', 'stdin']);
  const id = checkId(o._.shift());
  if (readState(id).kind === 'flow')
    die(L(`${id} is a workflow and cannot be messaged. Message one of its agents instead (\`pisub status ${id}\` lists them).`, `${id} 是工作流，不能直接对话。请发给它下面的某个子代理（\`pisub status ${id}\` 可列出）。`));
  const text = await getText(o);
  if (!text.trim()) die(L('empty message', '没有消息内容'));
  const mode = o.mode === 'follow_up' || o.mode === 'followUp' ? 'follow_up' : 'steer';
  const before = readState(id).rounds || 0;
  const running = isServing(id);
  enqueue(id, { text, from: o.from || 'claude', mode });
  ensureServing(id);
  if (o.wait) return waitAndPrint(id, before, Number(o.timeout) || 0);
  out(
    running
      ? L(`Delivered to ${id}: it is running, so the message arrives as ${mode === 'steer' ? 'a steer' : 'a follow-up'}.`, `已送达 ${id}：它正在运行，消息作为${mode === 'steer' ? '插话' : '追加任务'}交给它。`)
      : L(`Delivered to ${id}: it had finished, so it resumes its previous session.`, `已送达 ${id}：它已结束，将接着原会话续做。`)
  );
}

function listStates(owner) {
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
function ago(t) {
  const s = Math.round((now() - t) / 1000);
  if (s < 60) return L(`${s}s ago`, `${s}秒前`);
  if (s < 3600) return L(`${Math.round(s / 60)}m ago`, `${Math.round(s / 60)}分前`);
  if (s < 86400) return L(`${Math.round(s / 3600)}h ago`, `${Math.round(s / 3600)}小时前`);
  return L(`${Math.round(s / 86400)}d ago`, `${Math.round(s / 86400)}天前`);
}
const STATUS_NAMES = {
  starting: ['starting', '启动中'],
  queued: ['waiting for a slot', '排队中'],
  running: ['running', '运行中'],
  retrying: ['retrying', '重试中'],
  waiting: ['waiting to retry', '等待重试'],
  done: ['done', '完成'],
  error: ['error', '出错'],
  stopped: ['stopped', '已停止'],
};
const statusName = s => (STATUS_NAMES[s] ? L(...STATUS_NAMES[s]) : s);
// A broker that died (crash, killed, machine shut down) leaves its run "running" in state.json for good
const isLost = st => !TERMINAL.has(st.status) && !isServing(st.id) && now() - (st.updatedAt || 0) > 15000;
// Settle a lost run, once, for whoever looks first (status, wait, the pane): restart it when messages are
// waiting, otherwise record the failure with a final answer, so the side waiting for it gets notified.
function reconcile(st) {
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
function cmdStatus(argv) {
  const o = parseArgs(argv, ['json', 'all']);
  const id = o._[0];
  const list = (id ? [readState(checkId(id))] : listStates(o.owner).slice(0, Number(o.limit) || 30)).map(reconcile);
  if (o.json) return out(JSON.stringify(id ? list[0] : list));
  if (!list.length) return out(L('(no pi sub-agents)', '（没有 pi 子代理）'));
  for (const st of list) {
    if (st.kind === 'flow') {
      out(`${st.id}  ${statusName(st.status)}  ${L('workflow', '工作流')} ${st.name}  ${ago(st.createdAt)}  ${st.progress || ''}`);
      if (st.lastError && st.status === 'error') out(`    ${L('error', '错误')}: ${trunc(st.lastError, 300)}`);
      // When one workflow is asked for, list its agents
      if (id)
        for (const c of st.children || []) {
          const icon = c.status === 'done' ? '✓' : c.status === 'error' ? '✗' : c.status === 'cached' ? '≡' : '●';
          const meta = `${c.model}${c.phase ? ', ' + c.phase : ''}`;
          out(`    ${icon} ${c.label} ${L(`(${meta})`, `（${meta}）`)}${c.id ? '  ' + c.id : ''}${c.note ? '  ' + trunc(c.note, 100) : ''}`);
        }
      continue;
    }
    out(`${st.id}  ${statusName(st.status)}  ${modelLabel(st)}  ${ago(st.createdAt)}  ${L(`round ${st.rounds}`, `第${st.rounds}轮`)}  ${trunc(st.task.replace(/\s+/g, ' '), 60)}`);
    if (st.lastError && st.status === 'error') out(`    ${L('error', '错误')}: ${trunc(st.lastError, 200)}`);
    if (st.worktree?.report?.changed) out(`    ${L('branch', '分支')}: ${st.worktree.branch} ${st.worktree.report.stat ? `(${st.worktree.report.stat})` : ''}`);
  }
}

function readView(id) {
  return readLines(path.join(runDir(id), 'view.jsonl'));
}
function renderEntry(e, full) {
  const FROM = { claude: 'Claude', user: L('User', '用户'), system: L('System', '系统') };
  const AGENT_EV = {
    start: L('▶ start', '▶ 开始'),
    done: L('✓ done', '✓ 完成'),
    error: L('✗ failed', '✗ 失败'),
    cached: L('≡ cached', '≡ 用缓存'),
    retry: L('↻ bad format, asked to resubmit', '↻ 格式不对，让它重交'),
  };
  const t = new Date(e.t).toTimeString().slice(0, 8);
  const cut = (s, n) => (full ? String(s ?? '') : trunc(s, n));
  switch (e.k) {
    case 'user': {
      const tag = `${FROM[e.from] || e.from}${e.mode && e.mode !== 'prompt' ? '·' + (e.mode === 'steer' ? L('steer', '插话') : L('follow-up', '追加')) : ''}`;
      return `[${t}] ${L(`[${tag}] `, `【${tag}】`)}${cut(e.text, 800)}`;
    }
    case 'thinking': return `[${t}] ${L('(thinking) ', '（思考）')}${cut(e.text, 300)}`;
    case 'text': return `[${t}] ${L('[pi] ', '【pi】')}${cut(e.text, 2000)}`;
    case 'tool': return `[${t}] → ${e.name} ${cut(e.args, 300)}`;
    case 'tool_end': return `[${t}] ${e.ok ? '✓' : '✗'} ${e.name}${e.ms != null ? ` (${Math.round(e.ms / 100) / 10}s)` : ''} ${cut(e.out, 400)}`;
    case 'error': return `[${t}] ${L('! error: ', '！错误：')}${cut(e.text, 1000)}`;
    case 'done': return `[${t}] ==== ${L(`round ${e.round} ended: ${statusName(e.status)}`, `第${e.round}轮结束：${statusName(e.status)}`)} ====`;
    case 'phase': return `[${t}] ==== ${L('phase', '阶段')}: ${e.text} ====`;
    case 'agent': return `[${t}] ${AGENT_EV[e.ev] || e.ev} ${e.label} ${L(`(${e.model})`, `（${e.model}）`)}${e.id ? ' ' + e.id : ''}${e.text ? ': ' + cut(e.text, 400) : ''}`;
    case 'sh': return `[${t}] $ ${cut(e.text, 300)} → ${L('exit code', '退出码')} ${e.code}`;
    default: return `[${t}] · ${cut(e.text, 500)}`;
  }
}
function cmdLog(argv) {
  const o = parseArgs(argv, ['full', 'json']);
  const id = checkId(o._[0]);
  let v = readView(id);
  const tail = o.full ? 0 : Number(o.tail) || 60;
  if (tail && v.length > tail) v = v.slice(-tail);
  if (o.json) return out(JSON.stringify(v));
  for (const e of v) out(renderEntry(e, o.full));
  const live = readJSON(path.join(runDir(id), 'live.json'), {});
  if (live.text || live.thinking || live.tool)
    out(`${L('[live] ', '[进行中] ')}${live.tool ? L(`calling ${live.tool} `, `准备调用 ${live.tool} `) : ''}${trunc(live.text || live.thinking || '', 400)}`);
}
function cmdResult(argv) {
  const id = checkId(argv[0]);
  const f = path.join(runDir(id), 'final.md');
  if (!fs.existsSync(f)) die(L(`${id} has no final answer yet (status: ${statusName(readState(id).status)})`, `${id} 还没有最终结果（状态：${statusName(readState(id).status)}）`), 3);
  out(fs.readFileSync(f, 'utf8'));
}
async function waitFor(id, before, timeoutSec) {
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
async function waitAndPrint(id, before, timeoutSec) {
  const st = await waitFor(id, before, timeoutSec);
  if (!st) {
    out(L(`${id} is still running (wait timed out). Get the result later with \`pisub wait ${id}\` or \`pisub result ${id}\`.`, `${id} 仍在运行（等待超时）。之后用 \`pisub wait ${id}\` 或 \`pisub result ${id}\` 取结果。`));
    process.exit(124);
  }
  const f = path.join(runDir(id), 'final.md');
  out(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : L(`(${id} ended with status ${st.status} and no final answer)`, `（${id} 结束，状态：${st.status}，没有最终回答）`));
  process.exit(st.status === 'done' ? 0 : st.status === 'stopped' ? 2 : 1);
}
async function cmdWait(argv) {
  const o = parseArgs(argv, []);
  const id = checkId(o._[0]);
  const st = readState(id);
  // Already finished with nothing queued: print the result right away
  const before = TERMINAL.has(st.status) && !hasInbox(id) ? st.rounds - 1 : st.rounds;
  return waitAndPrint(id, before, Number(o.timeout) || 0);
}
function stopChildren(id) {
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
async function cmdStop(argv) {
  const id = checkId(argv[0]);
  // Workflow: if its runner is alive it winds down by itself; if the runner is gone, stop the agents here
  if (readState(id).kind === 'flow' && !isServing(id)) stopChildren(id);
  if (isServing(id)) {
    enqueue(id, { control: 'stop' });
    // Watchdog: a process stuck in a busy loop (say, a workflow script with an endless loop) never reads its
    // inbox and stops beating. If its heartbeat goes stale before it stops, kill it and clean up here.
    const pid = lockHolder(id);
    const t0 = now();
    let hung = false;
    while (now() - t0 < 60000) {
      const st = readState(id);
      if (TERMINAL.has(st.status) || !isAlive(pid)) break;
      if (now() - Number(readJSON(lockPath(id), {})?.at || 0) > 3 * HEARTBEAT_MS) {
        hung = true;
        break;
      }
      await sleep(500);
    }
    if (hung) {
      killTree(pid);
      const piPid = Number(readState(id).piPid);
      if (isAlive(piPid)) killTree(piPid);
      try { fs.unlinkSync(lockPath(id)); } catch {}
      if (readState(id).kind === 'flow') stopChildren(id);
      const st = readState(id);
      saveState(id, { status: 'stopped', rounds: (st.rounds || 0) + 1, finishedAt: now(), lastError: L('it did not respond, so its process was killed', '它没有响应，进程已被强制结束') });
      return out(L(`${id} did not respond; its process was killed`, `${id} 没有响应，已强制结束进程`));
    }
    out(L(`Stop requested for ${id}`, `已请求停止 ${id}`));
  } else {
    for (const f of inboxFiles(id)) try { fs.unlinkSync(path.join(inboxDir(id), f)); } catch {}
    const st = readState(id);
    if (!TERMINAL.has(st.status)) saveState(id, { status: 'stopped', rounds: (st.rounds || 0) + 1 });
    out(L(`${id} is not running`, `${id} 当前没有在运行`));
  }
}
function cmdAccounts(argv) {
  const cfg = loadConfig();
  if (argv[0] === 'reset') {
    const acc = loadCooldowns();
    if (argv[1]) delete acc[argv[1]];
    else for (const k of Object.keys(acc)) delete acc[k];
    mkdirp(HOME);
    writeJSON(ACCOUNTS_FILE, acc);
    return out(L('Reset.', '已重置'));
  }
  const acc = loadCooldowns();
  const names = [...new Set([...allPoolProviders(cfg), ...Object.keys(acc)])];
  if (!names.length) return out(L('(no provider pools configured: see "providers" in the README)', '（没有配置提供方轮换池：见 README 里的 providers）'));
  for (const p of names) {
    const a = acc[p];
    if (providerAvailable(p, acc)) out(`${p}  ${L('available', '可用')}`);
    else out(`${p}  ${L(`cooling down until ${new Date(a.until).toLocaleString()} (${trunc(a.reason, 120)})`, `冷却到 ${new Date(a.until).toLocaleString()}（${trunc(a.reason, 120)}）`)}`);
  }
}
function cmdModels(argv) {
  const o = parseArgs(argv, ['pi', 'json']);
  if (o.pi) {
    // Pass through to pi's own model list
    const cli = findCli();
    if (!cli) die(noCli());
    const r = spawnSync(process.execPath, [cli, '--list-models', ...o._], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    process.exit(r.status ?? 1);
  }
  const cfg = loadConfig();
  const rows = Object.entries(cfg.aliases)
    .filter(([, a]) => a && typeof a === 'object')
    .map(([name, a]) => aliasInfo(name, a));
  if (o.json) return out(JSON.stringify({ defaultAlias: cfg.defaultAlias || '', aliases: rows, config: CONFIG_FILE }));
  if (!rows.length) {
    out(
      L(
        `No model aliases configured. Without --model, pi uses its own default model.\nAdd aliases in ${CONFIG_FILE} (see the README), or pass any provider/model that pi knows (\`pisub models --pi\` lists them).`,
        `没有配置模型别名。不指定 --model 时用 pi 自己的默认模型。\n可以在 ${CONFIG_FILE} 里加别名（见 README），也可以直接写 pi 认识的 provider/model（\`pisub models --pi\` 列出）。`
      )
    );
    return;
  }
  out(L(`Model aliases (${CONFIG_FILE}); * = default:`, `模型别名（${CONFIG_FILE}），* 为默认：`));
  for (const r of rows) {
    const target = r.model ? (r.pool.length ? `[${r.pool.join(' → ')}]/${r.model}` : r.provider ? `${r.provider}/${r.model}` : r.model) : L('(pi default)', '（pi 默认）');
    out(`${r.alias === cfg.defaultAlias ? "*" : " "} ${r.alias}  ${target}${r.thinking ? `  thinking=${r.thinking}` : ''}`);
  }
  out(L('Any provider/model that pi knows also works (`pisub models --pi` lists them).', '也可以直接写 pi 认识的任何 provider/model（`pisub models --pi` 列出）。'));
}

// ---------- workflows ----------
// Per-session switch: the mod writes a marker when the user types /pi flow in that Claude session
const FLOW_GATE = path.join(HOME, 'flow-enabled');
const gateFile = sid => path.join(FLOW_GATE, String(sid).replace(/[^\w.-]/g, '_'));
const flowEnabled = sid => !!sid && fs.existsSync(gateFile(sid));

// Appended to every workflow agent's prompt
function flowFooter(schema) {
  const note = L(
    '(Workflow note: you are one step of an automated workflow. The full text of your last reply is handed to a script as the return value; no human reads it: ',
    '（工作流说明：你在执行一个自动化工作流里的一步。你最后一条回答的全文会原样作为返回值交给脚本处理，不是给人看的：'
  );
  return schema
    ? `\n\n---\n${note}${L(
        'your last reply must be a single JSON object (a ```json code block is fine) and nothing else, because a program parses it. It must match this JSON Schema:',
        '最后一条回答只能是一个 JSON 对象（可以放在 ```json 代码块里），不要有别的文字，它会被程序解析。必须符合这个 JSON Schema：'
      )}\n${JSON.stringify(schema, null, 2)}${L(')', '）')}`
    : `\n\n---\n${note}${L('give the result directly, with no greetings and without restating the task.)', '直接给出结果，不要寒暄，不要复述任务。）')}`;
}

// Find Git bash on Windows (not the WSL bash in System32)
let bashPath = null;
function findBash() {
  if (process.env.PISUB_BASH) return process.env.PISUB_BASH;
  if (process.platform !== 'win32') return '/bin/bash';
  if (bashPath) return bashPath;
  const cands = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    if (/\\windows\\system32/i.test(dir)) continue;
    // git.exe on PATH (e.g. C:\Program Files\Git\cmd): bash.exe lives in bin\ of the same install
    if (fs.existsSync(path.join(dir, 'git.exe'))) cands.push(path.join(dir, '..', 'bin', 'bash.exe'), path.join(dir, '..', '..', 'bin', 'bash.exe'));
    cands.push(path.join(dir, 'bash.exe'));
  }
  cands.push(
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  );
  bashPath = cands.find(p => p && fs.existsSync(p)) || 'bash';
  return bashPath;
}

function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function cmdFlow(argv) {
  const [sub, ...a] = argv;
  if (sub === 'enable' || sub === 'disable') {
    const o = parseArgs(a, []);
    if (!o.session) die(L('--session <session-id> is required', '需要 --session <会话id>'));
    mkdirp(FLOW_GATE);
    if (sub === 'enable') fs.writeFileSync(gateFile(o.session), String(now()));
    else try { fs.unlinkSync(gateFile(o.session)); } catch {}
    return out(sub === 'enable' ? L('Workflows enabled', '工作流已开启') : L('Workflows disabled', '工作流已关闭'));
  }
  if (sub === 'run') return cmdFlowRun(a);
  die(L('usage: pisub flow run ... | pisub flow enable|disable --session <session-id> (see help)', '用法：pisub flow run ... | pisub flow enable|disable --session <会话id>（help 看详情）'));
}

async function cmdFlowRun(argv) {
  const o = parseArgs(argv, ['json', 'wait', 'stdin-json']);
  let spec = {};
  if (o['stdin-json']) {
    try {
      spec = JSON.parse(await readStdin());
    } catch (e) {
      die(L(`--stdin-json input is not valid JSON: ${e.message}`, `--stdin-json 的内容不是合法 JSON：${e.message}`));
    }
  }
  const owner = o.owner || spec.owner || process.env.PI_SUBAGENTS_OWNER || '';
  if (!flowEnabled(owner))
    die(L('workflows are off for this session: the user turns them on by typing /pi flow in that Claude Code session (each session separately).', '工作流没有开启：要用户在 Claude Code 会话里输入 /pi flow 开启（每个会话单独开启）。'), 4);
  const resume = o.resume || spec.resume || '';
  let old = null;
  if (resume) {
    old = readState(checkId(resume));
    if (old.kind !== 'flow') die(L(`${resume} is not a workflow`, `${resume} 不是工作流`));
    if (isServing(resume)) die(L(`${resume} is still running; \`pisub stop ${resume}\` first, then resume`, `${resume} 还在运行，先 \`pisub stop ${resume}\` 再续跑`));
  }
  let src = spec.script || '';
  const scriptPath = o['script-file'] || spec.scriptPath;
  if (scriptPath) {
    try {
      src = fs.readFileSync(path.resolve(scriptPath), 'utf8');
    } catch (e) {
      die(L(`cannot read script file ${scriptPath}: ${e.message}`, `读不了脚本文件 ${scriptPath}：${e.message}`));
    }
  }
  if (!src && old) src = fs.readFileSync(path.join(runDir(resume), 'script.mjs'), 'utf8');
  if (!src) die(L('no script: use --script-file, script/scriptPath in --stdin-json, or --resume <old id>', '没有脚本：用 --script-file、--stdin-json 里的 script/scriptPath，或 --resume 旧编号'));
  let args = spec.args;
  if (o.args !== undefined) {
    try {
      args = JSON.parse(o.args);
    } catch {
      args = o.args;
    }
  }
  if (o['args-file']) args = readJSON(o['args-file'], undefined);
  if (args === undefined && old) args = readJSON(path.join(runDir(resume), 'args.json'), {}).value;
  let meta;
  try {
    meta = checkScript(src);
  } catch (e) {
    die(e.message);
  }
  const cwd = path.resolve(o.cwd || spec.cwd || old?.cwd || process.cwd());
  if (!fs.existsSync(cwd)) die(L(`working directory does not exist: ${cwd}`, `工作目录不存在：${cwd}`));
  const id = newRunDir(`wf-${meta.name}`);
  writePrivate(path.join(runDir(id), 'script.mjs'), src);
  writeJSON(path.join(runDir(id), 'args.json'), { value: args });
  writeJSON(statePath(id), {
    id,
    kind: 'flow',
    name: meta.name,
    alias: 'flow',
    provider: '',
    model: 'workflow',
    status: 'starting',
    task: trunc(meta.description || meta.name, 400),
    owner,
    origin: o.origin || spec.origin || 'cli',
    cwd,
    createdAt: now(),
    updatedAt: now(),
    rounds: 0,
    phases: meta.phases,
    children: [],
    progress: '',
    resumeFrom: resume || undefined,
  });
  launchServe(id);
  if (o.wait) return waitAndPrint(id, 0, Number(o.timeout) || 0);
  if (o.json) out(JSON.stringify({ id, dir: runDir(id), name: meta.name, script: path.join(runDir(id), 'script.mjs') }));
  else out(id);
}

async function cmdFlowServe(argv) {
  const id = checkId(argv[0]);
  if (!acquireLock(id)) return;
  try {
    await new FlowRun(id).run();
  } catch (e) {
    const st = readState(id);
    saveState(id, { status: 'error', lastError: String(e?.stack || e), rounds: (st.rounds || 0) + 1 });
  } finally {
    releaseLock(id);
  }
}

const fmtValue = v =>
  v === undefined ? L('(the script returned nothing)', '（脚本没有返回值）') : typeof v === 'string' ? v : '```json\n' + JSON.stringify(v, null, 2) + '\n```';
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return L(`${s}s`, `${s} 秒`);
  if (s < 3600) return L(`${Math.floor(s / 60)}m ${s % 60}s`, `${Math.floor(s / 60)} 分 ${s % 60} 秒`);
  return L(`${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`, `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`);
}

class FlowRun {
  constructor(id) {
    this.id = id;
    this.dir = runDir(id);
    this.st = readState(id);
    this.cfg = loadConfig();
    this.aborted = false;
    this.children = [];
    this.phase = '';
    this.t0 = now();
    this.journal = path.join(this.dir, 'journal.jsonl');
    // Results of the run being resumed. Key = hash of the call + which repeat of that same call
    this.prev = new Map();
    if (this.st.resumeFrom)
      for (const e of readLines(path.join(runDir(this.st.resumeFrom), 'journal.jsonl'))) this.prev.set(`${e.key}#${e.n}`, { value: e.value, modelKey: e.mk });
    // How the repository looked when the run being resumed ended, to warn about stale cached results
    this.prevGit = this.st.resumeFrom ? readState(this.st.resumeFrom)?.gitEnd || null : null;
    this.warnings = []; // about cached results being stale: shown when something came from the cache
    this.notes = []; // always shown in the summary
    this.fatalMsg = '';
    this.writers = new Map(); // working directory -> agents writing there right now (not readonly, not isolated)
    this.sharedWarned = false;
  }
  view(e) {
    appendPrivate(path.join(this.dir, 'view.jsonl'), JSON.stringify({ t: now(), ...e }) + '\n');
  }
  counts() {
    const n = s => this.children.filter(c => c.status === s).length;
    return { done: n('done'), cached: n('cached'), failed: n('error'), running: n('running') };
  }
  progress() {
    const k = this.counts();
    const phases = this.st.phases || [];
    const i = phases.findIndex(p => p.title === this.phase);
    const ph = !this.phase ? '' : i >= 0 ? L(`phase ${i + 1}/${phases.length} "${this.phase}" · `, `阶段 ${i + 1}/${phases.length}「${this.phase}」· `) : L(`"${this.phase}" · `, `「${this.phase}」· `);
    return (
      ph +
      L(`done ${k.done + k.cached}/${this.children.length}`, `完成 ${k.done + k.cached}/${this.children.length}`) +
      (k.failed ? L(`, failed ${k.failed}`, `，失败 ${k.failed}`) : '') +
      (k.running ? L(`, running ${k.running}`, `，进行中 ${k.running}`) : '')
    );
  }
  save(patch = {}) {
    this.st = saveState(this.id, { children: this.children, progress: this.progress(), currentPhase: this.phase, failed: this.counts().failed, ...patch });
  }
  child(info, patch) {
    let c = this.children.find(x => x.index === info.index);
    if (!c) {
      c = { index: info.index, label: info.label, phase: info.phase, model: info.model };
      this.children.push(c);
    }
    Object.assign(c, patch);
    this.save();
  }
  pollInbox() {
    for (const f of inboxFiles(this.id)) {
      const msg = readJSON(path.join(inboxDir(this.id), f), {});
      try { fs.unlinkSync(path.join(inboxDir(this.id), f)); } catch {}
      if (msg.control === 'stop') this.abort();
    }
  }
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.view({ k: 'info', text: L('Stop requested: stopping every agent', '收到停止请求：停止所有子代理') });
    this.save();
    stopChildren(this.id);
  }

  // Agents that write into the same folder at the same time can overwrite each other's edits: say so once
  async runAgent(prompt, opts, info) {
    const cwd = opts.cwd ? path.resolve(this.st.cwd, opts.cwd) : this.st.cwd;
    const writes = !opts.readonly && opts.isolation !== 'worktree';
    if (writes) {
      const n = this.writers.get(cwd) || 0;
      if (n > 0 && !this.sharedWarned) {
        this.sharedWarned = true;
        const w = L(
          `Several agents that can edit files are working in ${cwd} at the same time, so they may overwrite each other's changes. Give writing agents isolation: 'worktree', or readonly: true when they only read.`,
          `有多个能改文件的代理同时在 ${cwd} 里工作，可能互相覆盖改动。会写文件的代理请加 isolation: 'worktree'，只读的加 readonly: true。`
        );
        this.notes.push(w);
        this.view({ k: 'error', text: w });
      }
      this.writers.set(cwd, n + 1);
    }
    try {
      return await this.runOneAgent(prompt, opts, info);
    } finally {
      if (writes) this.writers.set(cwd, this.writers.get(cwd) - 1);
    }
  }
  async runOneAgent(prompt, opts, info) {
    const schema = opts.schema && typeof opts.schema === 'object' ? opts.schema : null;
    const ev = (ev, extra) => this.view({ k: 'agent', ev, label: info.label, model: info.model, ...extra });
    let r;
    try {
      r = createRun({
        task: prompt + flowFooter(schema),
        model: opts.model,
        thinking: opts.thinking,
        cwd: opts.cwd ? path.resolve(this.st.cwd, opts.cwd) : this.st.cwd,
        readonly: opts.readonly,
        isolation: opts.isolation,
        name: info.label,
        owner: this.id,
        origin: 'flow',
        from: 'system',
        extra: { parent: this.id, phase: info.phase, label: info.label },
      });
    } catch (e) {
      this.child(info, { status: 'error', note: e.message });
      ev('error', { text: e.message });
      return null;
    }
    launchServe(r.id);
    this.child(info, { id: r.id, status: 'running', note: '', branch: undefined, review: undefined, ...(info.attempt ? { attempt: info.attempt } : {}) });
    ev('start', { id: r.id });
    // An agent in a worktree that changed files: its branch, for the panel and the summary
    const branchOf = () => {
      const w = readState(r.id)?.worktree;
      if (!w?.report?.changed) return {};
      return { branch: w.branch, note: `${w.branch}${w.report.stat ? ' · ' + w.report.stat : ''}`, review: `git -C "${w.root}" diff ${w.base.slice(0, 12)} ${w.branch}` };
    };
    let before = 0;
    for (let attempt = 0; ; attempt++) {
      const st = await waitFor(r.id, before, 0);
      if (this.aborted || st.status !== 'done') {
        const note = this.aborted
          ? L('workflow stopped', '工作流已停止')
          : this.fatalMsg && st.status === 'stopped'
            ? L('stopped because the workflow failed', '工作流失败，已停止')
            : trunc(st.lastError || statusName(st.status), 300);
        const b = branchOf();
        this.child(info, { status: 'error', ...b, note: b.note ? `${note} (${b.note})` : note });
        ev('error', { id: r.id, text: note });
        return null;
      }
      let text = '';
      try { text = fs.readFileSync(path.join(runDir(r.id), 'final.md'), 'utf8'); } catch {}
      // No answer at all is not a result (answerChars: length of pi's own answer, without notes added to it)
      if (st.answerChars === 0 || (st.answerChars === undefined && !text.trim())) {
        const note = L('it finished without writing a final answer', '它结束了，但没有写最终回答');
        const b = branchOf();
        this.child(info, { status: 'error', ...b, note: b.note ? `${note} (${b.note})` : note });
        ev('error', { id: r.id, text: note });
        return null;
      }
      if (!schema) {
        this.child(info, { status: 'done', ...branchOf() });
        ev('done', { id: r.id });
        return text;
      }
      const parsed = extractJSON(text);
      const err = parsed.ok ? validate(schema, parsed.value) : parsed.error;
      if (!err) {
        this.child(info, { status: 'done', ...branchOf() });
        ev('done', { id: r.id });
        return parsed.value;
      }
      if (attempt >= 2) {
        const note = L(`output does not match the schema (after 2 resubmits): ${err}`, `输出不符合格式（已重交 2 次）：${err}`);
        this.child(info, { status: 'error', note });
        ev('error', { id: r.id, text: note });
        return null;
      }
      ev('retry', { id: r.id, text: err });
      before = st.rounds;
      enqueue(r.id, {
        text: L(
          `Your final answer does not meet the requirement: ${err}. Answer again with only a JSON object that matches the JSON Schema below, and nothing else.\n${JSON.stringify(schema)}`,
          `你的最终回答不符合要求：${err}。请重新输出：只输出一个符合下面 JSON Schema 的 JSON 对象，不要别的文字。\n${JSON.stringify(schema)}`
        ),
        from: 'system',
        mode: 'steer',
      });
      ensureServing(r.id);
    }
  }

  runSh(cmd, opts) {
    const shown = Array.isArray(cmd) ? cmd.join(' ') : cmd;
    const cwd = opts.cwd ? path.resolve(this.st.cwd, opts.cwd) : this.st.cwd;
    const [file, argv] = Array.isArray(cmd) ? [cmd[0], cmd.slice(1)] : [findBash(), ['-c', cmd]];
    const limitSec = Number(opts.timeoutSec) || 600;
    return new Promise(resolve => {
      const outB = [];
      const errB = [];
      let size = 0;
      let note = '';
      let finished = false;
      // Declared before spawning, so a failed spawn can call finish() without touching uninitialized timers
      let timer = null;
      let watch = null;
      const finish = code => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(watch);
        const res = { code, stdout: Buffer.concat(outB).toString('utf8'), stderr: Buffer.concat(errB).toString('utf8') + note };
        this.view({ k: 'sh', text: shown, code });
        resolve(res);
      };
      let child;
      try {
        child = spawn(file, argv, {
          cwd,
          windowsHide: true,
          detached: process.platform !== 'win32', // its own process group, so killTree reaches its children
          env: { ...process.env, PISUB_FLOW_ID: this.id, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
      } catch (e) {
        note = e.message;
        return finish(-1);
      }
      const take = arr => d => {
        if (size < 4_000_000) arr.push(d);
        size += d.length;
      };
      child.stdout.on('data', take(outB));
      child.stderr.on('data', take(errB));
      child.on('error', e => {
        note += `\n${e.message}`;
        finish(-1);
      });
      child.on('close', code => finish(code ?? -1));
      timer = setTimeout(() => {
        note += L(`\n(killed after ${limitSec}s)`, `\n（超过 ${limitSec} 秒，已终止）`);
        killTree(child.pid);
      }, limitSec * 1000);
      watch = setInterval(() => {
        if (this.aborted || this.fatalMsg) {
          note += L('\n(killed: the workflow was stopped)', '\n（工作流已停止，已终止）');
          killTree(child.pid);
        }
      }, 1000);
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input != null ? String(opts.input) : undefined);
    });
  }

  async run() {
    this.save({ status: 'running', startedAt: now() });
    this.view({
      k: 'info',
      text: this.st.resumeFrom
        ? L(`Workflow "${this.st.name}" started (resuming ${this.st.resumeFrom}, ${this.prev.size} cached results available)`, `工作流「${this.st.name}」开始（从 ${this.st.resumeFrom} 续跑，可用缓存 ${this.prev.size} 条）`)
        : L(`Workflow "${this.st.name}" started`, `工作流「${this.st.name}」开始`),
    });
    if (this.prevGit) {
      const cur = gitSignature(this.st.cwd);
      if (cur && (cur.head !== this.prevGit.head || cur.sig !== this.prevGit.sig)) {
        const what = cur.head !== this.prevGit.head ? `HEAD ${(this.prevGit.head || '-').slice(0, 7)} → ${cur.head.slice(0, 7)}` : L('uncommitted changes differ', '未提交的改动不一样了');
        const w = L(
          `The repository changed after ${this.st.resumeFrom} finished (${what}). Cached agent() results were made from the old files and may be out of date. Calls that list their files in inputs re-run by themselves; for the others use cache: false, or start the workflow fresh instead of resuming.`,
          `仓库在 ${this.st.resumeFrom} 结束后有变动（${what}）。缓存的 agent() 结果是按旧文件做的，可能已经过时。写了 inputs 的调用会自己重跑；其余的请加 cache: false，或者不要续跑、重新开始。`
        );
        this.warnings.push(w);
        this.view({ k: 'error', text: w });
      }
    }
    const src = fs.readFileSync(path.join(this.dir, 'script.mjs'), 'utf8');
    const args = readJSON(path.join(this.dir, 'args.json'), {}).value;
    const meta = checkScript(src);
    const mc = meta.concurrency;
    const limits =
      typeof mc === 'number'
        ? Object.fromEntries(Object.keys(this.cfg.flowConcurrency).map(k => [k, mc]))
        : { ...this.cfg.flowConcurrency, ...(mc && typeof mc === 'object' ? mc : {}) };
    const inboxTimer = setInterval(() => this.pollInbox(), 1000);
    let result = null;
    let error = null;
    try {
      result = await runFlow({
        src,
        args,
        defaultModel: this.cfg.defaultAlias || '',
        limits,
        stagger: this.cfg.flowStaggerMs || {},
        failFast: meta.failFast,
        hooks: {
          runAgent: (p, o, info) => this.runAgent(p, o, info),
          fingerprint: (paths, o) => hashInputs(paths, o.cwd ? path.resolve(this.st.cwd, o.cwd) : this.st.cwd),
          onFatal: msg => {
            this.fatalMsg = msg;
            this.view({ k: 'error', text: msg });
            this.save();
            stopChildren(this.id);
          },
          runSh: (c, o) => this.runSh(c, o),
          log: text => this.view({ k: 'info', text }),
          phase: title => {
            this.phase = title;
            this.view({ k: 'phase', text: title });
            this.save();
          },
          onError: text => this.view({ k: 'error', text }),
          onCached: info => {
            this.child(info, { status: 'cached' });
            this.view({ k: 'agent', ev: 'cached', label: info.label, model: info.model });
          },
          isAborted: () => this.aborted,
          cached: (key, n) => this.prev.get(`${key}#${n}`) ?? null,
          record: (key, n, value, info) =>
            appendPrivate(this.journal, JSON.stringify({ key, n, value, index: info.index, label: info.label, cached: !!info.cached, mk: info.modelKey }) + '\n'),
          // What an alias stands for now (provider pools rotate, so the provider is left out)
          modelKey: m => {
            const r = resolveModel(m, this.cfg);
            return r.model ? `${r.model}${r.thinking ? '@' + r.thinking : ''}` : 'pi-default';
          },
        },
      });
    } catch (e) {
      error = e;
    }
    clearInterval(inboxTimer);
    this.pollInbox();
    // Nothing of this workflow may keep running after it ended with an error
    if (error) stopChildren(this.id);
    const unawaited = result?.stats?.unawaited || 0;
    if (unawaited)
      this.notes.push(
        L(
          `The script returned before ${unawaited} agent()/sh() calls had finished (a missing await?). The workflow waited for them, but the script's return value does not contain their results.`,
          `脚本在 ${unawaited} 个 agent()/sh() 调用结束前就返回了（漏了 await？）。工作流等它们结束了，但脚本的返回值里没有它们的结果。`
        )
      );
    const k = this.counts();
    const took = fmtDuration(now() - this.t0);
    const summary = L(
      `(Workflow "${this.st.name}": ${this.children.length} agent() calls, ${k.done} done, ${k.failed} failed, ${k.cached} from cache; took ${took})`,
      `（工作流「${this.st.name}」：agent() 调用 ${this.children.length} 次，完成 ${k.done}，失败 ${k.failed}，缓存命中 ${k.cached}；用时 ${took}）`
    );
    const head = [summary];
    const failed = this.children.filter(c => c.status === 'error');
    if (failed.length) {
      head.push(L(`Failed agents (${failed.length}):`, `失败的代理（${failed.length} 个）：`));
      for (const c of failed.slice(0, 20)) head.push(`  ✗ #${c.index} ${c.label} (${c.model}): ${trunc(c.note || '', 200)}${c.id ? `  [${c.id}]` : ''}`);
      if (failed.length > 20) head.push('  …');
    }
    const changed = this.children.filter(c => c.branch);
    if (changed.length) {
      head.push(L(`Agents that changed files, each on its own branch (review with the command shown; apply one to your working tree with pisub apply <agent id>):`, `改了文件的代理，各在自己的分支上（用下面的命令查看；要应用到你的工作区，用 pisub apply <代理编号>）：`));
      for (const c of changed) head.push(`  #${c.index} ${c.label}: ${c.note}  [${c.id}]\n      ${c.review}`);
    }
    if (k.cached) for (const w of this.warnings) head.push(L('Warning: ', '注意：') + w);
    for (const w of this.notes) head.push(L('Warning: ', '注意：') + w);
    let status;
    let body;
    if (this.aborted) {
      status = 'stopped';
      body = L('The workflow was stopped.', '工作流被停止。') + (result ? L(`\n\nThe script's return value before stopping:\n`, `\n\n停止前脚本的返回值：\n`) + fmtValue(result.value) : '');
    } else if (error) {
      status = 'error';
      body = error.fatal ? L('The workflow failed: ', '工作流失败：') + error.message : L('The workflow script failed:\n', '工作流脚本出错：\n') + String(error?.stack || error);
    } else {
      status = 'done';
      body = fmtValue(result.value);
      writeJSON(path.join(this.dir, 'result.json'), { value: result.value ?? null });
    }
    writePrivate(path.join(this.dir, 'final.md'), `${head.join('\n')}\n\n${body}\n`);
    this.view({ k: 'done', round: (this.st.rounds || 0) + 1, status });
    this.save({
      status,
      rounds: (this.st.rounds || 0) + 1,
      finishedAt: now(),
      lastError: error ? trunc(error.fatal ? error.message : String(error?.stack || error), 2000) : '',
      finalPreview: trunc(body, 300),
      gitEnd: gitSignature(this.st.cwd) || undefined,
    });
  }
}

// ---------- broker: the part that actually drives pi ----------
async function cmdServe(argv) {
  const id = checkId(argv[0]);
  for (;;) {
    if (!acquireLock(id)) return;
    try {
      while (hasInbox(id)) {
        const s = new PiSession(id);
        await s.run();
        if (s.fatal) break;
      }
    } catch (e) {
      const st = readState(id);
      if (isAlive(Number(st.piPid))) killTree(st.piPid);
      const msg = L(`the broker failed: ${e?.message || e}`, `broker 出错：${e?.message || e}`);
      try { writePrivate(path.join(runDir(id), 'final.md'), `${errorTitle()}${msg}\n`); } catch {}
      saveState(id, { status: 'error', lastError: String(e?.stack || e), rounds: (st.rounds || 0) + 1, finishedAt: now() });
    } finally {
      releaseSlot();
      releaseLock(id);
    }
    // Check the inbox once more after releasing the lock, so a message that arrived as we exited is not lost
    if (!hasInbox(id)) return maybeAutoClean();
  }
}

// ---------- applying an isolated agent's work, and removing old runs ----------
// pisub apply <id> [--check] [--3way]: bring an agent's branch into the repository it was started from.
// Plain apply changes only the working tree and refuses as a whole when anything conflicts; --3way merges what
// it can and leaves conflict markers (like git apply --3way, it also stages the result).
function cmdApply(argv) {
  const o = parseArgs(argv, ['check', '3way']);
  const id = checkId(o._[0]);
  const w = readState(id).worktree;
  if (!w) die(L(`${id} did not work in a worktree, so there is nothing to apply (its changes are already in its folder)`, `${id} 不是在 worktree 里工作的，没有要应用的东西（它的改动本来就在它的目录里）`));
  const ref = `refs/heads/${w.branch}`;
  if (!git(w.root, ['rev-parse', '--verify', '-q', ref]).ok) die(L(`branch ${w.branch} no longer exists in ${w.root}`, `${w.root} 里已经没有分支 ${w.branch}`));
  const diff = git(w.root, ['diff', '--binary', '--no-color', '--no-ext-diff', w.base, ref], { raw: true });
  if (!diff.ok) die(diff.err);
  if (!diff.out.length) return out(L(`${w.branch} has no changes; nothing to apply`, `${w.branch} 没有改动，不用应用`));
  const files = (gitOut(w.root, ['diff', '--name-only', w.base, ref]) || '').split('\n').filter(Boolean);
  const args = ['apply', '--binary', '--whitespace=nowarn', ...(o.check ? ['--check'] : []), ...(o['3way'] ? ['--3way'] : [])];
  const r = git(w.root, args, { input: diff.out });
  const list = files.slice(0, 30).map(f => `  ${f}`).join('\n') + (files.length > 30 ? '\n  …' : '');
  if (!r.ok) {
    if (r.err) process.stderr.write(r.err + '\n');
    die(
      o['3way']
        ? L(`merged ${w.branch} into ${w.root} with conflicts: fix the conflict markers in the files listed above`, `已把 ${w.branch} 合入 ${w.root}，但有冲突：请处理上面列出的文件里的冲突标记`)
        : L(
            `${w.branch} does not apply cleanly to ${w.root}${o.check ? '' : ', so nothing was changed'}. Your files have moved on since the agent started. Options: pisub apply ${id} --3way (merge, leaving conflict markers), or review with git -C "${w.root}" diff ${w.base.slice(0, 12)} ${w.branch}`,
            `${w.branch} 不能干净地应用到 ${w.root}${o.check ? '' : '，所以什么都没改'}。代理开始之后你的文件又改过了。可以：pisub apply ${id} --3way（合并，冲突处留下标记），或者用 git -C "${w.root}" diff ${w.base.slice(0, 12)} ${w.branch} 查看`
          )
    );
  }
  if (o.check) return out(L(`${w.branch} applies cleanly to ${w.root} (${files.length} ${files.length === 1 ? 'file' : 'files'}):\n${list}`, `${w.branch} 可以干净地应用到 ${w.root}（${files.length} 个文件）：\n${list}`));
  out(
    L(
      `Applied ${w.branch} to ${w.root} (${files.length} ${files.length === 1 ? 'file' : 'files'}, not committed):\n${list}\nThe branch is kept; remove it with pisub clean ${id} --branches`,
      `已把 ${w.branch} 应用到 ${w.root}（${files.length} 个文件，没有提交）：\n${list}\n分支还保留着，不需要了用 pisub clean ${id} --branches 删除`
    )
  );
}

// Remove finished runs: their folders (task, transcript, tool output) and worktrees. Branches with changes are
// kept unless branches is set, since they may hold work nobody applied yet.
function cleanRuns({ days = 0, ids = null, dryRun = false, branches = false } = {}) {
  const cutoff = now() - days * 86400000;
  let names = ids;
  if (!names) {
    try { names = fs.readdirSync(RUNS); } catch { names = []; }
  }
  const removed = [];
  const busy = [];
  const kept = [];
  for (const id of names) {
    const st = readState(id);
    if (!st) continue;
    if (!TERMINAL.has(st.status) || isServing(id) || hasInbox(id)) {
      if (ids) busy.push(id);
      continue;
    }
    if (!ids && (st.finishedAt || st.updatedAt || st.createdAt || 0) > cutoff) continue;
    removed.push(id);
    if (dryRun) continue;
    const w = st.worktree;
    const repo = w && fs.existsSync(w.root);
    if (repo && fs.existsSync(w.dir)) git(w.root, ['worktree', 'remove', '--force', w.dir]);
    if (repo && git(w.root, ['rev-parse', '--verify', '-q', `refs/heads/${w.branch}`]).ok) {
      if (branches) git(w.root, ['branch', '-q', '-D', w.branch]);
      else kept.push(`${w.branch} (${w.root})`);
    }
    try { fs.rmSync(runDir(id), { recursive: true, force: true }); } catch {}
    if (repo) git(w.root, ['worktree', 'prune']);
  }
  return { removed, busy, kept };
}
function cmdClean(argv) {
  const o = parseArgs(argv, ['dry-run', 'branches', 'json']);
  const ids = o._.length ? o._.map(checkId) : null;
  const days = o.days !== undefined ? Number(o.days) : Number(loadConfig().keepRunsDays) || 0;
  if (!ids && !(days >= 0)) die(L('--days must be a number of days', '--days 必须是天数'));
  if (!ids && !days && o.days === undefined) die(L('keepRunsDays is 0 in config.json, so say how old with --days N (0 = every finished run)', 'config.json 里 keepRunsDays 是 0，请用 --days N 指定多少天以前的（0 = 所有已结束的）'));
  const r = cleanRuns({ days, ids, dryRun: !!o['dry-run'], branches: !!o.branches });
  if (o.json) return out(JSON.stringify(r));
  out(
    o['dry-run']
      ? L(`Would remove ${r.removed.length} finished ${r.removed.length === 1 ? 'run' : 'runs'}`, `将删除 ${r.removed.length} 个已结束的运行`)
      : L(`Removed ${r.removed.length} finished ${r.removed.length === 1 ? 'run' : 'runs'}`, `已删除 ${r.removed.length} 个已结束的运行`)
  );
  if (r.busy.length) out(L(`Not finished, left alone: ${r.busy.join(', ')}`, `还没结束，没动：${r.busy.join('、')}`));
  if (r.kept.length) out(L(`Branches kept (they may hold changes nobody applied; add --branches to delete them):\n  `, `保留的分支（里面可能有还没应用的改动；加 --branches 一起删）：\n  `) + r.kept.join('\n  '));
}
// Once a day a broker, on its way out, removes runs older than keepRunsDays (0 turns this off)
function maybeAutoClean() {
  const days = Number(loadConfig().keepRunsDays) || 0;
  if (days <= 0) return;
  const mark = path.join(HOME, 'last-clean');
  try {
    if (now() - fs.statSync(mark).mtimeMs < 86400000) return;
  } catch {}
  try {
    writePrivate(mark, String(now()));
    cleanRuns({ days });
  } catch {}
}

const errorTitle = () => L('[pi sub-agent error] ', '【pi 子代理出错】');
const lastAnswer = text => (text ? L(`\n\nIts last answer:\n${text}`, `\n\n它最后的回答：\n${text}`) : '');

class PiSession {
  constructor(id) {
    this.id = id;
    this.dir = runDir(id);
    this.cfg = loadConfig();
    this.pending = new Map();
    this.reqSeq = 0;
    this.busy = false;
    this.closing = false;
    this.stopping = false;
    this.fatal = false;
    this.lastAssistant = null;
    this.retries = 0;
    this.sent = []; // messages sent to pi that have not shown up in its events yet (to label who sent them)
    this.live = { text: '', thinking: '', tool: '' };
    this.liveTimer = null;
    this.badLines = 0; // stdout lines that were not JSON
    this.toolsRunning = 0;
    this.toolStartedAt = 0;
    this.lastEventAt = now();
    this.idleAfterSettle = false; // the run settled while a message was being delivered
    this.rejected = ''; // why pi turned down the last prompt
    this.gaveUp = ''; // why the broker killed pi (hung, broken protocol)
  }
  view(entry) {
    appendPrivate(path.join(this.dir, 'view.jsonl'), JSON.stringify({ t: now(), ...entry }) + '\n');
  }
  event(rec) {
    appendPrivate(path.join(this.dir, 'events.jsonl'), JSON.stringify({ t: now(), ...rec }) + '\n');
  }
  state(patch) {
    return saveState(this.id, patch);
  }
  writeLive(force) {
    if (this.liveTimer && !force) return;
    const flush = () => {
      this.liveTimer = null;
      try { writeJSON(path.join(this.dir, 'live.json'), { t: now(), ...this.live }); } catch {}
    };
    if (force) {
      clearTimeout(this.liveTimer);
      flush();
    } else this.liveTimer = setTimeout(flush, 400);
  }
  // Every request has a deadline: a pi that stops answering must not leave the agent waiting forever
  send(cmd, timeoutMs = (Number(this.cfg.rpcTimeoutSec) || 60) * 1000) {
    const id = `b${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) return reject(new Error(L('pi has exited', 'pi 已退出')));
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        const e = new Error(L(`pi did not answer "${cmd.type}" within ${Math.round(timeoutMs / 1000)}s`, `pi 在 ${Math.round(timeoutMs / 1000)} 秒内没有回应「${cmd.type}」`));
        e.timeout = true;
        reject(e);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: r => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ ...cmd, id }) + '\n');
    });
  }
  // pi hung or broke the protocol: kill it. The round then ends with this reason as its error.
  giveUp(reason) {
    if (this.closing || this.gaveUp) return;
    this.gaveUp = reason;
    this.view({ k: 'error', text: reason });
    killTree(this.child?.pid);
  }
  async run() {
    let st = readState(this.id);
    const cli = findCli();
    if (!cli) {
      this.fatal = true;
      return this.failWithoutPi(noCli());
    }
    const pool = Array.isArray(st.pool) ? st.pool : [];
    if (pool.length && (!st.provider || !providerAvailable(st.provider))) {
      const p = pickProvider(pool);
      if (!p) {
        this.fatal = true;
        return this.failWithoutPi(L(`every provider in the pool is cooling down (${pool.join(', ')})`, `轮换池里的提供方都在冷却中（${pool.join('、')}）`));
      }
      this.view({ k: 'info', text: L(`provider ${st.provider} is cooling down; switching to ${p}`, `提供方 ${st.provider} 在冷却中，改用 ${p}`) });
      st = this.state({ provider: p, accountsTried: [...new Set([...(st.accountsTried || []), p])] });
    }
    let workCwd = st.cwd;
    if (st.worktree) {
      const err = ensureWorktree(st.worktree);
      if (err) {
        this.fatal = true;
        return this.failWithoutPi(L(`could not set up the agent's git worktree again: ${err}`, `没能重新建立代理的 git worktree：${err}`));
      }
      if (st.worktree.removed) st = this.state({ worktree: { ...st.worktree, removed: false } });
      workCwd = path.join(st.worktree.dir, st.worktree.prefix || '');
    }
    // Global limit across every session and workflow on this machine
    const max = Number(this.cfg.maxAgents) || 0;
    if (max > 0 && !mySlot) {
      let shown = false;
      while (!(mySlot = tryTakeSlot(max, this.id))) {
        if (!shown) {
          shown = true;
          this.state({ status: 'queued' });
          this.view({ k: 'info', text: L(`waiting for a free slot: ${runningSlots()} pi agents are running on this machine (maxAgents is ${max})`, `等待空位：本机已有 ${runningSlots()} 个 pi 代理在运行（maxAgents 为 ${max}）`) });
        }
        if (inboxFiles(this.id).some(f => readJSON(path.join(inboxDir(this.id), f), {})?.control === 'stop')) {
          this.fatal = true;
          return this.failWithoutPi(L('stopped while waiting for a free slot; it never started', '排队等空位时被停止，没有开始运行'), 'stopped');
        }
        await sleep(1000 + Math.floor(Math.random() * 500));
      }
    }
    const args = [cli, '--mode', 'rpc', '--session-dir', path.join(this.dir, 'session'), '--name', this.id];
    // By default pi skips context files, so the task it was given is all it works from (per task: contextFiles)
    if (!(st.contextFiles ?? this.cfg.contextFiles)) args.push('--no-context-files');
    if (st.model) args.push('--model', st.provider ? `${st.provider}/${st.model}` : st.model);
    if (st.thinking) args.push('--thinking', st.thinking);
    // Read-only: only pi's four read tools. --tools alone keeps MCP tools, so MCP is switched off as well, and
    // project-local pi extensions and settings are ignored. This limits tools; it is not a filesystem sandbox.
    if (st.readonly) args.push('--tools', 'read,grep,find,ls', '--no-mcp', '--no-approve');
    if (st.sessionFile && fs.existsSync(st.sessionFile)) args.push('--session', st.sessionFile);
    this.state({ status: 'running', brokerPid: process.pid });
    const errLog = fs.openSync(path.join(this.dir, 'pi-stderr.log'), 'a', FILE_MODE);
    this.child = spawn(process.execPath, args, {
      cwd: workCwd,
      stdio: ['pipe', 'pipe', errLog],
      windowsHide: true,
      detached: process.platform !== 'win32', // its own process group, so killTree also ends its shell commands
    });
    fs.closeSync(errLog);
    this.state({ piPid: this.child.pid });

    let buf = Buffer.alloc(0);
    const MAX_LINE = 64 * 1024 * 1024;
    this.child.stdout.on('data', chunk => {
      this.lastEventAt = now();
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let i;
      while ((i = buf.indexOf(10)) >= 0) {
        let line = buf.subarray(0, i).toString('utf8');
        buf = buf.subarray(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          // stdout is reserved for protocol records: count garbage, keep a few samples, give up if it keeps coming
          if (++this.badLines <= 5) this.view({ k: 'error', text: L(`pi sent a line that is not JSON (skipped): ${trunc(line, 200)}`, `pi 输出了一行不是 JSON 的内容（已跳过）：${trunc(line, 200)}`) });
          if (this.badLines === 100) this.giveUp(L('pi sent 100 lines that are not valid JSON; its RPC output looks broken', 'pi 输出了 100 行不合法的 JSON，RPC 输出看起来坏了'));
          continue;
        }
        this.onRecord(rec).catch(e => this.view({ k: 'error', text: L(`broker internal error: ${e?.message || e}`, `broker 内部错误：${e?.message || e}`) }));
      }
      if (buf.length > MAX_LINE) {
        buf = Buffer.alloc(0);
        this.giveUp(L('pi sent more than 64 MB without a line break; its RPC output looks broken', 'pi 输出了超过 64 MB 却没有换行，RPC 输出看起来坏了'));
      }
    });
    this.child.stdin.on('error', () => {});
    // Watchdog: a working agent that goes silent (no tool running), or a tool call that never ends, is hung
    const stall = (Number(this.cfg.stallTimeoutMin) || 0) * 60000;
    const tool = (Number(this.cfg.toolTimeoutMin) || 0) * 60000;
    const tick = Math.max(500, Math.min(15000, Math.min(stall || Infinity, tool || Infinity) / 4));
    this.watchdog = setInterval(() => {
      if (this.closing || !this.busy || this.waitingRetry) return;
      if (this.toolsRunning > 0) {
        if (tool && now() - this.toolStartedAt > tool) this.giveUp(L(`a tool call has been running for over ${this.cfg.toolTimeoutMin} min (toolTimeoutMin); treating it as hung`, `一个工具调用已运行超过 ${this.cfg.toolTimeoutMin} 分钟（toolTimeoutMin），按卡死处理`));
      } else if (stall && now() - this.lastEventAt > stall) {
        this.giveUp(L(`pi sent nothing for ${this.cfg.stallTimeoutMin} min while working (stallTimeoutMin); treating it as hung`, `pi 工作中 ${this.cfg.stallTimeoutMin} 分钟没有任何输出（stallTimeoutMin），按卡死处理`));
      }
    }, tick);

    // When pi exits (an unknown model makes it quit at once), fail every request still waiting for an answer;
    // otherwise run() would wait forever on get_state and the broker would quietly die and be restarted
    const exited = new Promise(resolve => {
      let done = false;
      const end = code => {
        if (done) return;
        done = true;
        for (const p of this.pending.values()) p.reject(new Error(L('pi has exited', 'pi 已退出')));
        this.pending.clear();
        resolve(code);
      };
      this.child.on('close', end);
      this.child.on('error', e => {
        try { appendPrivate(path.join(this.dir, 'pi-stderr.log'), `${e.message}\n`); } catch {}
        end(-1);
      });
    });
    try {
      const s = await this.send({ type: 'get_state' });
      if (s.success) {
        const patch = {};
        if (s.data?.sessionFile) patch.sessionFile = s.data.sessionFile;
        // No model was chosen: record the default model pi picked, so the panel can show it
        const m = s.data?.model;
        if (!st.model && m && typeof m === 'object' && (m.id || m.name)) {
          patch.provider = String(m.provider || '');
          patch.model = String(m.id || m.name);
        }
        if (Object.keys(patch).length) this.state(patch);
      }
    } catch (e) {
      if (e.timeout) this.giveUp(L(`pi did not finish starting up: ${e.message}`, `pi 没能完成启动：${e.message}`));
    }
    this.inboxTimer = setInterval(() => this.pumpInbox().catch(() => {}), 300);
    this.pumpInbox().catch(() => {});

    const code = await exited;
    clearInterval(this.inboxTimer);
    clearInterval(this.watchdog);
    clearTimeout(this.liveTimer);
    for (const p of this.pending.values()) p.reject(new Error(L('pi has exited', 'pi 已退出')));
    if (!this.closing) {
      // pi exited by itself (unknown model, crash, ...) or was killed as hung
      let tail = '';
      try { tail = fs.readFileSync(path.join(this.dir, 'pi-stderr.log'), 'utf8').slice(-1500); } catch {}
      this.fatal = true;
      this.failWithoutPi(this.gaveUp || L(`the pi process exited unexpectedly (exit code ${code}). ${tail.trim()}`, `pi 进程意外退出（退出码 ${code}）。${tail.trim()}`));
    }
    // pi has exited, so Windows lets go of the folder: now an unchanged worktree can be removed
    this.dropWorktreeNow();
  }
  failWithoutPi(msg, status = 'error') {
    const st = readState(this.id);
    for (const f of inboxFiles(this.id)) try { fs.unlinkSync(path.join(inboxDir(this.id), f)); } catch {}
    const wt = this.wrapWorktree();
    writePrivate(path.join(this.dir, 'final.md'), `${status === 'stopped' ? L('[stopped] ', '【已停止】') : errorTitle()}${msg}${wt}\n`);
    if (status === 'error') this.view({ k: 'error', text: msg });
    this.view({ k: 'done', status, round: (st.rounds || 0) + 1 });
    this.state({ status, lastError: status === 'error' ? msg : '', finishedAt: now(), rounds: (st.rounds || 0) + 1 });
    if (!this.child || this.child.exitCode !== null) this.dropWorktreeNow();
  }
  // Commit what the agent changed on its branch. Returns the text added to its final answer (none for
  // workflow agents: there the answer is the script's value, and the workflow summary lists the branches).
  wrapWorktree() {
    const st = readState(this.id);
    if (!st.worktree || st.worktree.removed) return '';
    const rep = commitWorktree(st);
    if (!rep) return '';
    this.state({ worktree: { ...st.worktree, report: rep } });
    if (!rep.changed) this.dropWorktree = true;
    return st.origin === 'flow' ? '' : '\n\n' + worktreeReport(st.worktree, rep, this.id);
  }
  dropWorktreeNow() {
    if (!this.dropWorktree) return;
    this.dropWorktree = false;
    const st = readState(this.id);
    if (!st.worktree) return;
    removeWorktree(st.worktree);
    this.state({ worktree: { ...st.worktree, removed: true } });
  }
  // Deliver queued messages in order. A message leaves the inbox only after pi answered it (accepted or turned
  // down): if the broker dies in between, the next broker delivers it again (at least once, never lost).
  async pumpInbox() {
    if (this.closing) return;
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        for (const f of inboxFiles(this.id)) {
          if (this.closing) return;
          const file = path.join(inboxDir(this.id), f);
          const msg = readJSON(file, null);
          if (!msg) {
            try { fs.renameSync(file, `${file}.bad`); } catch {}
            this.view({ k: 'error', text: L(`skipped a message file that could not be read: ${f}`, `跳过了一个读不了的消息文件：${f}`) });
            continue;
          }
          if (msg.control === 'stop') {
            try { fs.unlinkSync(file); } catch {}
            await this.stop();
            return;
          }
          if (this.stopping) {
            try { fs.unlinkSync(file); } catch {}
            continue;
          }
          try {
            await this.deliver(msg);
          } catch (e) {
            // No answer: the message stays in the inbox, unacknowledged
            if (e.timeout) this.giveUp(e.message);
            return;
          }
          try { fs.unlinkSync(file); } catch {}
        }
      } while (this.repump && !this.closing);
    } finally {
      this.pumping = false;
    }
    // Nothing is running and nothing is queued: this round is over
    if (this.closing || this.busy || hasInbox(this.id)) return;
    if (this.rejected) return this.finalize('error', this.rejected);
    if (this.idleAfterSettle) return this.finalize('done');
  }
  async deliver(msg) {
    if (this.busy) {
      this.sent.push({ text: msg.text, from: msg.from || 'claude', mode: msg.mode });
      const r = await this.send({ type: msg.mode === 'follow_up' ? 'follow_up' : 'steer', message: msg.text });
      if (r.success) return r;
      if (this.busy) {
        this.view({ k: 'error', text: L(`the message did not get through: ${r.error}`, `消息没送进去：${r.error}`) });
        return r;
      }
      // The run ended while the message was on its way: start a new run with it instead
      this.sent.pop();
    }
    this.sent.push({ text: msg.text, from: msg.from || 'claude', mode: 'prompt' });
    this.busy = true;
    this.idleAfterSettle = false;
    this.rejected = '';
    this.state({ status: 'running' });
    const r = await this.send({ type: 'prompt', message: msg.text });
    if (!r.success) {
      // Turned down before it started: no run and no agent_settled will follow, so the round must end here
      this.busy = false;
      this.rejected = L(`pi rejected the message: ${r.error}`, `pi 拒绝了消息：${r.error}`);
      this.view({ k: 'error', text: this.rejected });
    } else if (r.data?.disposition === 'handled') {
      // An extension command or input handler consumed it: no run starts, so no agent_settled will come
      this.busy = false;
      this.idleAfterSettle = true;
      this.view({ k: 'info', text: L('pi handled the message itself; no model run was started', 'pi 自己处理了这条消息，没有启动模型运行') });
    }
    return r;
  }
  async stop() {
    this.stopping = true;
    for (const f of inboxFiles(this.id)) try { fs.unlinkSync(path.join(inboxDir(this.id), f)); } catch {}
    this.view({ k: 'info', text: L('Stop requested', '收到停止请求') });
    if (this.busy && !this.waitingRetry) {
      try { await this.send({ type: 'clear_queue' }); } catch {}
      try { await this.send({ type: 'abort' }); } catch {}
      // abort is followed by agent_settled, which finalizes; force it after 15 s just in case
      setTimeout(() => { if (!this.closing) this.finalize('stopped'); }, 15000);
    } else await this.finalize('stopped');
  }
  async onRecord(rec) {
    const t = rec.type;
    if (t === 'response') {
      const p = this.pending.get(rec.id);
      if (p) {
        this.pending.delete(rec.id);
        p.resolve(rec);
      }
      return;
    }
    if (t === 'extension_ui_request') {
      if (['select', 'confirm', 'input', 'editor'].includes(rec.method)) {
        this.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: rec.id, cancelled: true }) + '\n');
        this.view({ k: 'info', text: L(`a pi extension opened a dialog (${rec.method}: ${trunc(rec.title || rec.message || '', 100)}); cancelled automatically`, `pi 扩展弹出了对话框（${rec.method}：${trunc(rec.title || rec.message || '', 100)}），已自动取消`) });
      }
      return;
    }
    if (t === 'tool_execution_update') return;
    if (t === 'message_update') {
      const ev = rec.assistantMessageEvent || {};
      if (ev.type === 'text_delta') this.live.text += ev.delta || '';
      else if (ev.type === 'thinking_delta') this.live.thinking += ev.delta || '';
      else if (ev.type === 'toolcall_start') this.live.tool = ev.toolName || '';
      else return;
      this.writeLive();
      return;
    }
    // Slimmed event stream, for debugging
    const lean = { ...rec };
    if (t === 'agent_end') delete lean.messages;
    if (t === 'turn_end') {
      delete lean.message;
      delete lean.toolResults;
    }
    if (!((t === 'message_start' || t === 'message_end') && rec.message?.role === 'system') && t !== 'message_start') this.event(lean);

    switch (t) {
      case 'agent_start':
        this.busy = true;
        break;
      case 'message_end': {
        const m = rec.message || {};
        if (m.role === 'user') {
          const text = typeof m.content === 'string' ? m.content : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
          const i = this.sent.findIndex(s => s.text === text);
          const src = i >= 0 ? this.sent.splice(i, 1)[0] : { from: 'system', mode: 'prompt' };
          this.view({ k: 'user', from: src.from, mode: src.mode, text });
        } else if (m.role === 'assistant') {
          this.lastAssistant = m;
          for (const c of m.content || []) {
            if (c.type === 'thinking' && c.thinking?.trim()) this.view({ k: 'thinking', text: trunc(c.thinking, 4000) });
            else if (c.type === 'text' && c.text?.trim()) this.view({ k: 'text', text: trunc(c.text, 40000) });
          }
          if (m.stopReason === 'error') this.view({ k: 'error', text: m.errorMessage || L('unknown error', '未知错误') });
          this.live = { text: '', thinking: '', tool: '' };
          this.writeLive(true);
        }
        break;
      }
      case 'tool_execution_start':
        if (this.toolsRunning++ === 0) this.toolStartedAt = now();
        this.view({ k: 'tool', name: rec.toolName, args: summarizeArgs(rec.args) });
        break;
      case 'tool_execution_end': {
        this.toolsRunning = Math.max(0, this.toolsRunning - 1);
        const text = (rec.result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        this.view({ k: 'tool_end', name: rec.toolName, ok: !rec.isError, ms: rec.durationMs, out: trunc(text, 1500) });
        break;
      }
      case 'auto_retry_start':
        this.state({ status: 'retrying' });
        this.view({ k: 'retry', text: L(`pi auto-retry ${rec.attempt}/${rec.maxAttempts} (in ${Math.round(rec.delayMs / 1000)}s): ${trunc(rec.errorMessage, 300)}`, `pi 自动重试 ${rec.attempt}/${rec.maxAttempts}（${Math.round(rec.delayMs / 1000)} 秒后）：${trunc(rec.errorMessage, 300)}`) });
        break;
      case 'auto_retry_end':
        this.state({ status: 'running' });
        break;
      case 'compaction_start':
        this.view({ k: 'info', text: L(`context compaction started (${rec.reason})`, `上下文压缩开始（${rec.reason}）`) });
        break;
      case 'compaction_end':
        this.view({
          k: 'info',
          text: rec.result
            ? L(`context compacted: ${rec.result.tokensBefore} → about ${rec.result.estimatedTokensAfter} tokens`, `上下文压缩完成：${rec.result.tokensBefore} → 约 ${rec.result.estimatedTokensAfter} tokens`)
            : L(`context compaction failed: ${rec.errorMessage || 'aborted'}`, `上下文压缩失败：${rec.errorMessage || '已中止'}`),
        });
        break;
      case 'agent_settled':
        this.toolsRunning = 0;
        await this.onSettled(rec);
        break;
    }
  }
  async onSettled(rec) {
    if (this.closing) return;
    const st = readState(this.id);
    if (this.stopping) return this.finalize('stopped');
    let last = this.lastAssistant;
    const pool = Array.isArray(st.pool) ? st.pool : [];
    // Test hook only: with PISUB_TEST_FAKE_LIMIT=<provider>, that provider's first success is treated as a usage-limit error
    if (process.env.PISUB_TEST_FAKE_LIMIT && process.env.PISUB_TEST_FAKE_LIMIT === st.provider && !this.fakedLimit && last && last.stopReason !== 'error') {
      this.fakedLimit = true;
      last = { stopReason: 'error', errorMessage: 'You have hit your usage limit (test). Try again in ~3 min.' };
      this.view({ k: 'error', text: L(`(test) simulated error: ${last.errorMessage}`, `（测试）模拟报错：${last.errorMessage}`) });
    }
    if (last?.stopReason === 'error') {
      const err = last.errorMessage || '';
      if (pool.length && isUsageLimit(err)) {
        markExhausted(st.provider, minutesFrom(err) ?? this.cfg.exhaustedCooldownMin, err);
        const next = pickProvider(pool, [st.provider]);
        if (next) {
          const r = await this.send({ type: 'set_model', provider: next, modelId: st.model });
          if (r.success) {
            this.view({ k: 'info', text: L(`${st.provider} hit its usage limit; carrying on with ${next}`, `${st.provider} 额度用完，换成 ${next} 接着做`) });
            this.state({ provider: next, accountsTried: [...new Set([...(st.accountsTried || []), next])] });
            this.lastAssistant = null;
            return this.resume();
          }
          this.view({ k: 'error', text: L(`switching to ${next} failed: ${r.error}`, `切换到 ${next} 失败：${r.error}`) });
        }
        return this.finalize('error', L(`every provider in the pool hit its usage limit (last error: ${err})`, `轮换池里的提供方额度都用完了（最后报错：${err}）`));
      }
      if (isTransient(err) && this.retries < this.cfg.overloadBackoffSec.length) {
        const sec = this.cfg.overloadBackoffSec[this.retries++];
        this.state({ status: 'waiting' });
        this.view({ k: 'retry', text: L(`service unavailable; retrying in ${sec}s (attempt ${this.retries}): ${trunc(err, 300)}`, `服务暂时不可用，${sec} 秒后再试（第 ${this.retries} 次）：${trunc(err, 300)}`) });
        this.waitingRetry = true;
        await sleep(sec * 1000);
        this.waitingRetry = false;
        if (this.closing || this.stopping) return;
        this.lastAssistant = null;
        return this.resume();
      }
      return this.finalize('error', err);
    }
    if (rec.aborted || last?.stopReason === 'aborted') return this.finalize('stopped');
    this.retries = 0;
    // Someone sent a message while it was wrapping up (or one is on its way to pi): keep going
    if (hasInbox(this.id) || this.pumping) {
      this.busy = false;
      this.idleAfterSettle = true;
      return this.pumpInbox();
    }
    return this.finalize('done');
  }
  async resume() {
    this.busy = true;
    this.state({ status: 'running' });
    const text = continueText();
    this.sent.push({ text, from: 'system', mode: 'prompt' });
    const r = await this.send({ type: 'prompt', message: text });
    if (!r.success) return this.finalize('error', L(`could not resume: ${r.error}`, `续做失败：${r.error}`));
  }
  async finalize(status, errText) {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.inboxTimer);
    let text = null;
    let stats = null;
    try { text = (await this.send({ type: 'get_last_assistant_text' }, 15000)).data?.text ?? null; } catch {}
    try { stats = (await this.send({ type: 'get_session_stats' }, 15000)).data ?? null; } catch {}
    const answerChars = (text || '').trim().length;
    let final = answerChars ? text : L('(pi finished without writing a final answer)', '（pi 结束了，但没有写最终回答）');
    if (status === 'error') final = errorTitle() + (errText || L('unknown error', '未知错误')) + lastAnswer(text);
    if (status === 'stopped') final = L('[stopped]', '【已停止】') + lastAnswer(text);
    // Before the status says "done": a workflow reading this agent's state then sees its branch
    final += this.wrapWorktree();
    writePrivate(path.join(this.dir, 'final.md'), final + '\n');
    const st = readState(this.id);
    const round = (st.rounds || 0) + 1;
    this.view({ k: 'done', status, round });
    this.state({
      status,
      rounds: round,
      finishedAt: now(),
      lastError: status === 'error' ? errText || '' : '',
      finalPreview: trunc(final, 300),
      answerChars,
      usage: stats?.tokens,
      cost: stats?.cost,
      context: stats?.contextUsage,
      sessionFile: stats?.sessionFile || st.sessionFile,
    });
    this.live = { text: '', thinking: '', tool: '' };
    this.writeLive(true);
    this.child.stdin.end();
    const child = this.child;
    setTimeout(() => { if (child.exitCode === null) killTree(child.pid); }, 15000).unref();
  }
}
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  args = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined));
  if (typeof args.command === 'string') return trunc(args.command, 500);
  if (typeof args.path === 'string') {
    const extra = Object.entries(args).filter(([k]) => !['path', 'content', 'oldText', 'newText', 'edits'].includes(k));
    const n = args.content ? String(args.content).length : 0;
    return args.path + (extra.length ? ' ' + JSON.stringify(Object.fromEntries(extra)) : '') + (n ? L(` (writes ${n} chars)`, `（写入 ${n} 字）`) : '');
  }
  return trunc(JSON.stringify(args), 300);
}

const HELP_EN = `pisub: run the pi coding agent as a background sub-agent
  spawn  [--model alias|provider/model] [--thinking level] [--cwd dir] [--readonly] [--worktree]
         [--name name] [--owner session-id] [--wait] [--timeout sec] [--json]
         (--task-file file | --stdin | task text)
         Start a pi sub-agent. Prints its id right away; with --wait, waits and prints only its final answer.
         Without --model: the configured defaultAlias, or pi's own default model.
         --worktree: work in its own git worktree (branch pi/<id>) instead of your files; its changes are
         committed on that branch, and the final answer says how to review and apply them.
  send   <id> [--mode steer|follow_up] [--from claude|user] [--wait] (--text-file file | --stdin | text)
         Message it: while running = steer (or follow_up); after it finished = resume its previous session.
  status [id] [--owner session-id] [--json] [--limit N]   show status
  log    <id> [--tail N] [--full] [--json]                show what it did
  result <id>                                             print its final answer
  wait   <id> [--timeout sec]                             wait for it, then print its final answer
  stop   <id>                                             stop it
  models [--json]                                         list model aliases from config.json
  models --pi [search]                                    list the models pi knows (pi --list-models)
  accounts [reset [provider]]                             show / reset provider-pool cooldowns
  apply  <id> [--check] [--3way]                          apply a --worktree agent's branch to your working tree
                                                          (--check: only test; --3way: merge, leaving conflict markers)
  clean  [id...] [--days N] [--branches] [--dry-run]      remove finished runs (default: older than keepRunsDays)
                                                          and their worktrees; --branches also deletes pi/<id> branches
  paths                                                   print the run directory and other paths (JSON)
  flow run --owner session-id (--script-file script | --stdin-json) [--args JSON | --args-file file]
           [--resume old-workflow-id] [--cwd dir] [--wait] [--json]
         Start a pi workflow (script API like Claude Code's Workflow: meta, agent, pipeline, parallel,
         phase, log, args, plus sh). The user must first type /pi flow in that session.
         --stdin-json reads {script|scriptPath, args, resume, cwd} from stdin.
  flow enable|disable --session session-id                turn workflows on/off for a session (used by the plugin)
Config: ${CONFIG_FILE}
Runs:   ${RUNS}
Language: English (set "language": "zh" in config.json or PISUB_LANG=zh for Chinese)`;

const HELP_ZH = `pisub —— 把 pi 编码代理当后台子代理用
  spawn  [--model 别名|provider/model] [--thinking 级别] [--cwd 目录] [--readonly] [--worktree]
         [--name 名称] [--owner 会话id] [--wait] [--timeout 秒] [--json]
         (--task-file 文件 | --stdin | 任务文本)
         启动一个 pi 子代理，默认立即返回编号；--wait 则等它做完并只输出最终回答。
         不写 --model：用配置里的 defaultAlias，没有就用 pi 自己的默认模型。
         --worktree：在它自己的 git worktree（分支 pi/<编号>）里干活，不碰你的文件；改动提交到这个分支，
         最终回答里会写怎么查看和应用。
  send   <id> [--mode steer|follow_up] [--from claude|user] [--wait] (--text-file 文件 | --stdin | 文本)
         给它发消息：运行中=插话（steer）或追加（follow_up）；已结束=接着原会话续做。
  status [id] [--owner 会话id] [--json] [--limit N]    查看状态
  log    <id> [--tail N] [--full] [--json]            查看工作过程
  result <id>                                         输出最终回答
  wait   <id> [--timeout 秒]                          等它做完并输出最终回答
  stop   <id>                                         停止
  models [--json]                                     列出 config.json 里的模型别名
  models --pi [搜索词]                                 列出 pi 认识的模型（pi --list-models）
  accounts [reset [提供方]]                            查看/重置轮换池的冷却
  apply  <id> [--check] [--3way]                      把 --worktree 代理的分支应用到你的工作区
                                                      （--check 只检查；--3way 合并，冲突处留标记）
  clean  [id...] [--days N] [--branches] [--dry-run]  删除已结束的运行（默认：早于 keepRunsDays 天的）
                                                      和它们的 worktree；--branches 连 pi/<id> 分支一起删
  paths                                               输出运行目录等路径（JSON）
  flow run --owner 会话id (--script-file 脚本 | --stdin-json) [--args JSON | --args-file 文件]
           [--resume 旧工作流编号] [--cwd 目录] [--wait] [--json]
         启动 pi 工作流（脚本写法同 Claude Code 的 Workflow：meta、agent、pipeline、parallel、phase、log、args，另有 sh）。
         必须先由用户在该会话里输入 /pi flow 开启。--stdin-json 从标准输入读 {script|scriptPath, args, resume, cwd}。
  flow enable|disable --session 会话id                 开关某个会话的工作流（由插件调用）
配置：${CONFIG_FILE}
运行目录：${RUNS}
语言：中文（config.json 里 "language": "en" 或 PISUB_LANG=en 切换为英文）`;

const [cmd, ...rest] = process.argv.slice(2);
const cmdPaths = () => out(JSON.stringify({ home: HOME, runs: RUNS, config: CONFIG_FILE, pisub: SELF, node: process.execPath, lang: language() }));
const table = {
  paths: cmdPaths,
  spawn: cmdSpawn,
  send: cmdSend,
  status: cmdStatus,
  log: cmdLog,
  result: cmdResult,
  wait: cmdWait,
  stop: cmdStop,
  models: cmdModels,
  accounts: cmdAccounts,
  flow: cmdFlow,
  apply: cmdApply,
  clean: cmdClean,
  _serve: cmdServe,
  _flow: cmdFlowServe,
};
const HELP = L(HELP_EN, HELP_ZH);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') out(HELP);
else if (!table[cmd]) die(`${L('unknown command', '不认识的命令')}: ${cmd}\n${HELP}`);
else {
  mkdirp(RUNS);
  if (process.platform !== 'win32') try { fs.chmodSync(HOME, DIR_MODE); } catch {}
  await table[cmd](rest);
}
