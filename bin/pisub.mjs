#!/usr/bin/env node
// pisub: run the pi coding agent as a background "sub-agent" for Claude Code.
// Each agent is a broker process detached from the Claude session; the broker drives `pi --mode rpc`.
// Run directories live in ~/.pi-subagents/runs/<id>/ (set PI_SUBAGENTS_HOME to move the root).
//
// Usage (full help: `node pisub.mjs help`):
//   spawn  [--model alias|provider/model] [--thinking lvl] [--cwd dir] [--readonly]
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
};

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const out = s => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
function die(msg, code = 1) {
  process.stderr.write(`pisub: ${msg}\n`);
  process.exit(code);
}
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
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
  const user = readJSON(CONFIG_FILE, {}) || {};
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
const continueText = () =>
  L(
    '(System notice: the previous request was interrupted by a usage limit or a service overload and has now recovered. Continue the original task from where it stopped; do not redo finished parts.)',
    '（系统通知：刚才的请求因额度用尽或服务过载而中断，现已恢复。请从中断处继续完成原任务，不要重复已经完成的部分。）'
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
function saveState(id, patch) {
  const st = { ...readState(id), ...patch, updatedAt: now() };
  writeJSON(statePath(id), st);
  return st;
}
function makeId(alias) {
  const t = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
  const safe = String(alias).replace(/[^\w.-]/g, '').slice(0, 24) || 'pi';
  return `${safe}-${stamp}-${Math.random().toString(36).slice(2, 5)}`;
}
function inboxFiles(id) {
  try {
    return fs.readdirSync(inboxDir(id)).filter(f => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}
const hasInbox = id => inboxFiles(id).length > 0;
function enqueue(id, msg) {
  fs.mkdirSync(inboxDir(id), { recursive: true });
  const name = `${now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const tmp = path.join(inboxDir(id), name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ ...msg, at: now() }));
  fs.renameSync(tmp, path.join(inboxDir(id), name + '.json'));
}

// ---------- lock: one broker per agent ----------
const lockPath = id => path.join(runDir(id), 'serve.lock');
function lockHolder(id) {
  const pid = Number(readJSON(lockPath(id), {})?.pid);
  return isAlive(pid) ? pid : null;
}
const isServing = id => lockHolder(id) !== null;
function acquireLock(id) {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lockPath(id), JSON.stringify({ pid: process.pid, at: now() }), { flag: 'wx' });
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
  if (Number(readJSON(lockPath(id), {})?.pid) === process.pid) {
    try { fs.unlinkSync(lockPath(id)); } catch {}
  }
}
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
  const log = fs.openSync(path.join(runDir(id), 'serve.log'), 'a');
  const child = spawn(process.execPath, [SELF, st?.kind === 'flow' ? '_flow' : '_serve', id], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    cwd: runDir(id),
  });
  child.unref();
  fs.closeSync(log);
}
function ensureServing(id) {
  if (!isServing(id)) launchServe(id);
}

// ---------- models and provider pools ----------
const loadCooldowns = () => readJSON(ACCOUNTS_FILE, {});
function providerAvailable(p, acc = loadCooldowns()) {
  const a = acc[p];
  return !a || !a.until || a.until <= now();
}
function pickProvider(pool, exclude = []) {
  const acc = loadCooldowns();
  return pool.find(p => !exclude.includes(p) && providerAvailable(p, acc)) || null;
}
function markExhausted(p, minutes, reason) {
  fs.mkdirSync(HOME, { recursive: true });
  const acc = loadCooldowns();
  acc[p] = { until: now() + minutes * 60000, at: now(), reason: trunc(reason, 300) };
  writeJSON(ACCOUNTS_FILE, acc);
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
function createRun({ task, model, thinking, cwd, readonly, name, owner, origin, from, extra }) {
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
  const id = makeId(name || m.alias);
  fs.mkdirSync(inboxDir(id), { recursive: true });
  fs.writeFileSync(path.join(runDir(id), 'task.md'), task);
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
    ...(extra || {}),
  });
  enqueue(id, { text: task, from: from || 'claude', mode: 'prompt' });
  return { id, provider: provider || '', model: m.model || '', alias: m.alias };
}

async function cmdSpawn(argv) {
  const o = parseArgs(argv, ['readonly', 'wait', 'json', 'stdin']);
  const task = await getText(o);
  if (!task.trim()) die(L('no task given (use --task-file, --stdin, or write it after the options)', '没有任务描述（用 --task-file、--stdin 或直接写在后面）'));
  let r;
  try {
    r = createRun({ task, model: o.model, thinking: o.thinking, cwd: o.cwd, readonly: o.readonly, name: o.name, owner: o.owner, origin: o.origin, from: o.from });
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
  running: ['running', '运行中'],
  retrying: ['retrying', '重试中'],
  waiting: ['waiting to retry', '等待重试'],
  done: ['done', '完成'],
  error: ['error', '出错'],
  stopped: ['stopped', '已停止'],
};
const statusName = s => (STATUS_NAMES[s] ? L(...STATUS_NAMES[s]) : s);
function liveStatus(st) {
  // If the broker died unexpectedly the state stays "running" forever
  if (!TERMINAL.has(st.status) && !isServing(st.id) && now() - st.updatedAt > 15000) return 'error';
  return st.status;
}
function cmdStatus(argv) {
  const o = parseArgs(argv, ['json', 'all']);
  const id = o._[0];
  const list = id ? [readState(checkId(id))] : listStates(o.owner).slice(0, Number(o.limit) || 30);
  for (const st of list) st.status = liveStatus(st);
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
    if (st && liveStatus(st) === 'error' && !TERMINAL.has(st.status) && !hasInbox(id)) {
      return saveState(id, { status: 'error', lastError: L('the broker process exited unexpectedly (see serve.log)', 'broker 进程意外退出（见 serve.log）'), rounds: (st.rounds || 0) + 1 });
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
function cmdStop(argv) {
  const id = checkId(argv[0]);
  // Workflow: if its runner is alive it winds down by itself; if the runner is gone, stop the agents here
  if (readState(id).kind === 'flow' && !isServing(id)) stopChildren(id);
  if (isServing(id)) {
    enqueue(id, { control: 'stop' });
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
    fs.mkdirSync(HOME, { recursive: true });
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
    fs.mkdirSync(FLOW_GATE, { recursive: true });
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
  const id = makeId(`wf-${meta.name}`);
  fs.mkdirSync(inboxDir(id), { recursive: true });
  fs.writeFileSync(path.join(runDir(id), 'script.mjs'), src);
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
    if (this.st.resumeFrom) for (const e of readLines(path.join(runDir(this.st.resumeFrom), 'journal.jsonl'))) this.prev.set(`${e.key}#${e.n}`, e.value);
  }
  view(e) {
    fs.appendFileSync(path.join(this.dir, 'view.jsonl'), JSON.stringify({ t: now(), ...e }) + '\n');
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
    this.st = saveState(this.id, { children: this.children, progress: this.progress(), currentPhase: this.phase, ...patch });
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

  async runAgent(prompt, opts, info) {
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
    this.child(info, { id: r.id, status: 'running' });
    ev('start', { id: r.id });
    let before = 0;
    for (let attempt = 0; ; attempt++) {
      const st = await waitFor(r.id, before, 0);
      if (this.aborted || st.status !== 'done') {
        const note = this.aborted ? L('workflow stopped', '工作流已停止') : trunc(st.lastError || statusName(st.status), 300);
        this.child(info, { status: 'error', note });
        ev('error', { id: r.id, text: note });
        return null;
      }
      let text = '';
      try { text = fs.readFileSync(path.join(runDir(r.id), 'final.md'), 'utf8'); } catch {}
      if (!schema) {
        this.child(info, { status: 'done' });
        ev('done', { id: r.id });
        return text;
      }
      const parsed = extractJSON(text);
      const err = parsed.ok ? validate(schema, parsed.value) : parsed.error;
      if (!err) {
        this.child(info, { status: 'done' });
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
      const timer = setTimeout(() => {
        note += L(`\n(killed after ${limitSec}s)`, `\n（超过 ${limitSec} 秒，已终止）`);
        child.kill();
      }, limitSec * 1000);
      const watch = setInterval(() => {
        if (this.aborted) {
          note += L('\n(killed: the workflow was stopped)', '\n（工作流已停止，已终止）');
          child.kill();
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
        hooks: {
          runAgent: (p, o, info) => this.runAgent(p, o, info),
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
          cached: (key, n) => (this.prev.has(`${key}#${n}`) ? { value: this.prev.get(`${key}#${n}`) } : null),
          record: (key, n, value, info) =>
            fs.appendFileSync(this.journal, JSON.stringify({ key, n, value, index: info.index, label: info.label, cached: !!info.cached }) + '\n'),
        },
      });
    } catch (e) {
      error = e;
    }
    clearInterval(inboxTimer);
    this.pollInbox();
    const k = this.counts();
    const took = fmtDuration(now() - this.t0);
    const summary = L(
      `(Workflow "${this.st.name}": ${this.children.length} agent() calls, ${k.done} done, ${k.failed} failed, ${k.cached} from cache; took ${took})`,
      `（工作流「${this.st.name}」：agent() 调用 ${this.children.length} 次，完成 ${k.done}，失败 ${k.failed}，缓存命中 ${k.cached}；用时 ${took}）`
    );
    let status;
    let body;
    if (this.aborted) {
      status = 'stopped';
      body = L('The workflow was stopped.', '工作流被停止。') + (result ? L(`\n\nThe script's return value before stopping:\n`, `\n\n停止前脚本的返回值：\n`) + fmtValue(result.value) : '');
    } else if (error) {
      status = 'error';
      body = L('The workflow script failed:\n', '工作流脚本出错：\n') + String(error?.stack || error);
    } else {
      status = 'done';
      body = fmtValue(result.value);
      writeJSON(path.join(this.dir, 'result.json'), { value: result.value ?? null });
    }
    fs.writeFileSync(path.join(this.dir, 'final.md'), `${summary}\n\n${body}\n`);
    this.view({ k: 'done', round: (this.st.rounds || 0) + 1, status });
    this.save({
      status,
      rounds: (this.st.rounds || 0) + 1,
      finishedAt: now(),
      lastError: error ? trunc(String(error?.stack || error), 2000) : '',
      finalPreview: trunc(body, 300),
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
      saveState(id, { status: 'error', lastError: String(e?.stack || e), rounds: (st.rounds || 0) + 1 });
    } finally {
      releaseLock(id);
    }
    // Check the inbox once more after releasing the lock, so a message that arrived as we exited is not lost
    if (!hasInbox(id)) return;
  }
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
  }
  view(entry) {
    fs.appendFileSync(path.join(this.dir, 'view.jsonl'), JSON.stringify({ t: now(), ...entry }) + '\n');
  }
  event(rec) {
    fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify({ t: now(), ...rec }) + '\n');
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
  send(cmd) {
    const id = `b${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) return reject(new Error(L('pi has exited', 'pi 已退出')));
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ ...cmd, id }) + '\n');
    });
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
    const args = [cli, '--mode', 'rpc', '--session-dir', path.join(this.dir, 'session'), '--name', this.id];
    // By default pi skips context files, so the task it was given is all it works from
    if (!this.cfg.contextFiles) args.push('--no-context-files');
    if (st.model) args.push('--model', st.provider ? `${st.provider}/${st.model}` : st.model);
    if (st.thinking) args.push('--thinking', st.thinking);
    if (st.readonly) args.push('--tools', 'read,grep,find,ls');
    if (st.sessionFile && fs.existsSync(st.sessionFile)) args.push('--session', st.sessionFile);
    this.state({ status: 'running', brokerPid: process.pid });
    const errLog = fs.openSync(path.join(this.dir, 'pi-stderr.log'), 'a');
    this.child = spawn(process.execPath, args, { cwd: st.cwd, stdio: ['pipe', 'pipe', errLog], windowsHide: true });
    fs.closeSync(errLog);
    this.state({ piPid: this.child.pid });

    let buf = Buffer.alloc(0);
    this.child.stdout.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(10)) >= 0) {
        let line = buf.subarray(0, i).toString('utf8');
        buf = buf.subarray(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        this.onRecord(rec).catch(e => this.view({ k: 'error', text: L(`broker internal error: ${e?.message || e}`, `broker 内部错误：${e?.message || e}`) }));
      }
    });
    this.child.stdin.on('error', () => {});

    const exited = new Promise(resolve => this.child.on('close', code => resolve(code)));
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
    } catch {}
    this.inboxTimer = setInterval(() => this.pumpInbox().catch(() => {}), 300);
    this.pumpInbox().catch(() => {});

    const code = await exited;
    clearInterval(this.inboxTimer);
    clearTimeout(this.liveTimer);
    for (const p of this.pending.values()) p.reject(new Error(L('pi has exited', 'pi 已退出')));
    if (!this.closing) {
      // pi exited by itself (unknown model, crash, ...)
      let tail = '';
      try { tail = fs.readFileSync(path.join(this.dir, 'pi-stderr.log'), 'utf8').slice(-1500); } catch {}
      this.fatal = true;
      this.failWithoutPi(L(`the pi process exited unexpectedly (exit code ${code}). ${tail.trim()}`, `pi 进程意外退出（退出码 ${code}）。${tail.trim()}`));
    }
  }
  failWithoutPi(msg) {
    const st = readState(this.id);
    for (const f of inboxFiles(this.id)) try { fs.unlinkSync(path.join(inboxDir(this.id), f)); } catch {}
    fs.writeFileSync(path.join(this.dir, 'final.md'), `${errorTitle()}${msg}\n`);
    this.view({ k: 'error', text: msg });
    this.view({ k: 'done', status: 'error', round: (st.rounds || 0) + 1 });
    this.state({ status: 'error', lastError: msg, finishedAt: now(), rounds: (st.rounds || 0) + 1 });
  }
  async pumpInbox() {
    if (this.closing || this.pumping) return;
    this.pumping = true;
    try {
      for (const f of inboxFiles(this.id)) {
        const file = path.join(inboxDir(this.id), f);
        const msg = readJSON(file, null);
        try { fs.unlinkSync(file); } catch {}
        if (!msg) continue;
        if (msg.control === 'stop') {
          await this.stop();
          return;
        }
        if (this.stopping) continue;
        this.sent.push({ text: msg.text, from: msg.from || 'claude', mode: this.busy ? msg.mode : 'prompt' });
        if (!this.busy) {
          this.busy = true;
          this.state({ status: 'running' });
          const r = await this.send({ type: 'prompt', message: msg.text });
          if (!r.success) {
            this.busy = false;
            this.view({ k: 'error', text: L(`pi rejected the message: ${r.error}`, `pi 拒绝了消息：${r.error}`) });
          }
        } else {
          const type = msg.mode === 'follow_up' ? 'follow_up' : 'steer';
          const r = await this.send({ type, message: msg.text });
          if (!r.success) this.view({ k: 'error', text: L(`the message did not get through: ${r.error}`, `消息没送进去：${r.error}`) });
        }
      }
    } finally {
      this.pumping = false;
    }
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
        this.view({ k: 'tool', name: rec.toolName, args: summarizeArgs(rec.args) });
        break;
      case 'tool_execution_end': {
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
    // Someone sent a message while it was wrapping up: keep going
    if (hasInbox(this.id)) {
      this.busy = false;
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
    try { text = (await this.send({ type: 'get_last_assistant_text' })).data?.text ?? null; } catch {}
    try { stats = (await this.send({ type: 'get_session_stats' })).data ?? null; } catch {}
    let final = text || '';
    if (status === 'error') final = errorTitle() + (errText || L('unknown error', '未知错误')) + lastAnswer(text);
    if (status === 'stopped') final = L('[stopped]', '【已停止】') + lastAnswer(text);
    fs.writeFileSync(path.join(this.dir, 'final.md'), final + '\n');
    const st = readState(this.id);
    const round = (st.rounds || 0) + 1;
    this.view({ k: 'done', status, round });
    this.state({
      status,
      rounds: round,
      finishedAt: now(),
      lastError: status === 'error' ? errText || '' : '',
      finalPreview: trunc(final, 300),
      usage: stats?.tokens,
      cost: stats?.cost,
      context: stats?.contextUsage,
      sessionFile: stats?.sessionFile || st.sessionFile,
    });
    this.live = { text: '', thinking: '', tool: '' };
    this.writeLive(true);
    this.child.stdin.end();
    const child = this.child;
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 15000).unref();
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
  spawn  [--model alias|provider/model] [--thinking level] [--cwd dir] [--readonly]
         [--name name] [--owner session-id] [--wait] [--timeout sec] [--json]
         (--task-file file | --stdin | task text)
         Start a pi sub-agent. Prints its id right away; with --wait, waits and prints only its final answer.
         Without --model: the configured defaultAlias, or pi's own default model.
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
  spawn  [--model 别名|provider/model] [--thinking 级别] [--cwd 目录] [--readonly]
         [--name 名称] [--owner 会话id] [--wait] [--timeout 秒] [--json]
         (--task-file 文件 | --stdin | 任务文本)
         启动一个 pi 子代理，默认立即返回编号；--wait 则等它做完并只输出最终回答。
         不写 --model：用配置里的 defaultAlias，没有就用 pi 自己的默认模型。
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
  _serve: cmdServe,
  _flow: cmdFlowServe,
};
const HELP = L(HELP_EN, HELP_ZH);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') out(HELP);
else if (!table[cmd]) die(`${L('unknown command', '不认识的命令')}: ${cmd}\n${HELP}`);
else {
  fs.mkdirSync(RUNS, { recursive: true });
  await table[cmd](rest);
}
