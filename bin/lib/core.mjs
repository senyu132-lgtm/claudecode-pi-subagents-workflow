// pisub core: paths, settings (config.json), small file and process helpers. Imports nothing else of pisub.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { L, setLanguage } from '../i18n.mjs';

// The CLI entry point (bin/pisub.mjs): background processes start it again
export const SELF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pisub.mjs');
export const HOME = process.env.PI_SUBAGENTS_HOME || path.join(os.homedir(), '.pi-subagents');
export const RUNS = path.join(HOME, 'runs');
export const ACCOUNTS_FILE = path.join(HOME, 'accounts.json');
export const CONFIG_FILE = path.join(HOME, 'config.json');
export const TERMINAL = new Set(['done', 'error', 'stopped']);

export const DEFAULT_CONFIG = {
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
  // Results reach Claude as a background-task notice. When that cannot be done (no Bash/PowerShell tool in the
  // session, the command refused), true = send them as a plugin message instead (shown in the user's place in the
  // desktop app); false = keep them waiting, show why above the prompt and retry (strict)
  noticeFallback: true,
};

// ---------- helpers ----------
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const now = () => Date.now();
export const out = s => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
export function die(msg, code = 1) {
  process.stderr.write(`pisub: ${msg}\n`);
  process.exit(code);
}
// A missing file gives the fallback. With strict, a file that exists but cannot be read or parsed throws
// instead of being taken for "empty", so a broken config is reported rather than silently ignored.
export function readJSON(file, fallback, strict = false) {
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
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// Runs hold tasks, transcripts and tool output: keep them readable by this user only (no effect on Windows,
// where the user profile folder is already private)
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
export const mkdirp = dir => fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
export const writePrivate = (file, data) => fs.writeFileSync(file, data, { mode: FILE_MODE });
export const appendPrivate = (file, data) => fs.appendFileSync(file, data, { mode: FILE_MODE });
// Cross-process lock for a read-modify-write of a shared file: an exclusive "<file>.lock". A holder that
// died or hung for staleMs loses it, so a crash never blocks everyone else for good.
export function withFileLock(file, fn, staleMs = 10000) {
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
export function killTree(pid) {
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
export function writeJSON(file, data) {
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
export function trunc(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + L(`… (${s.length} chars, truncated)`, `…（共 ${s.length} 字，已截断）`) : s;
}
// A value of the wrong type would quietly change behaviour (a number where a list belongs turns retries off,
// a word where a number belongs reads as 0 = no limit), so it is refused with the key named
export function configProblem(user) {
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(user)) return L('the file must hold a JSON object', '文件里必须是一个 JSON 对象');
  const nonNeg = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const want = {
    language: [v => typeof v === 'string', L('a string ("en" or "zh")', '字符串（"en" 或 "zh"）')],
    defaultAlias: [v => typeof v === 'string', L('a string', '字符串')],
    aliases: [isObj, L('an object', '对象')],
    contextFiles: [v => typeof v === 'boolean', L('true or false', 'true 或 false')],
    noticeFallback: [v => typeof v === 'boolean', L('true or false', 'true 或 false')],
    overloadBackoffSec: [v => Array.isArray(v) && v.every(nonNeg), L('a list of seconds, like [20, 40, 80]', '秒数列表，比如 [20, 40, 80]')],
    flowConcurrency: [v => isObj(v) && Object.values(v).every(n => Number.isInteger(n) && n >= 1), L('an object with a whole number of at least 1 per alias, like {"default": 4}', '按别名写的、不小于 1 的整数，比如 {"default": 4}')],
    flowStaggerMs: [v => isObj(v) && Object.values(v).every(nonNeg), L('an object with milliseconds per alias, like {"cheap": 500}', '按别名写的毫秒数，比如 {"cheap": 500}')],
  };
  for (const k of ['exhaustedCooldownMin', 'maxAgents', 'rpcTimeoutSec', 'stallTimeoutMin', 'toolTimeoutMin', 'keepRunsDays'])
    want[k] = [nonNeg, L('a number, 0 or more', '不小于 0 的数字')];
  for (const [k, [ok, what]] of Object.entries(want))
    if (user[k] !== undefined && !ok(user[k])) return L(`${k} must be ${what}, not ${JSON.stringify(user[k])}`, `${k} 应该是${what}，现在是 ${JSON.stringify(user[k])}`);
  return '';
}
export function loadConfig() {
  let user;
  try {
    user = readJSON(CONFIG_FILE, {}, true) || {};
  } catch (e) {
    die(L(`cannot use the config file: ${e.message}`, `配置文件有问题：${e.message}`));
  }
  const bad = configProblem(user);
  if (bad) die(L(`config file ${CONFIG_FILE}: ${bad}`, `配置文件 ${CONFIG_FILE} 有问题：${bad}`));
  return {
    ...DEFAULT_CONFIG,
    ...user,
    aliases: user.aliases || {},
    flowConcurrency: { ...DEFAULT_CONFIG.flowConcurrency, ...(user.flowConcurrency || {}) },
    flowStaggerMs: { ...(user.flowStaggerMs || {}) },
  };
}
setLanguage(process.env.PISUB_LANG || loadConfig().language);

// Sent to pi after the broker recovered from a usage limit or an overload
// The tool calls made before the interruption already happened: the notice asks the model to check before
// repeating anything that changes files or outside systems (exactly-once is not something we can promise).
export const continueText = () =>
  L(
    '(System notice: the previous request was interrupted by a usage limit or a service overload and has now recovered. Continue the original task from where it stopped. Steps you already ran did take effect: before repeating anything that writes files, runs commands with side effects or calls outside services, check whether it was already done, and do not do it twice.)',
    '（系统通知：刚才的请求因额度用尽或服务过载而中断，现已恢复。请从中断处继续完成原任务。中断前执行过的步骤已经生效：凡是写文件、执行有副作用的命令、调用外部服务的操作，重做之前先检查是否已经做过，不要做两遍。）'
  );
export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---------- arguments ----------
export function parseArgs(argv, booleans) {
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
export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
export async function getText(o) {
  if (o['task-file']) return fs.readFileSync(o['task-file'], 'utf8');
  if (o['text-file']) return fs.readFileSync(o['text-file'], 'utf8');
  if (o.stdin) return readStdin();
  return o._.join(' ');
}

export function readLines(file) {
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

export const errorTitle = () => L('[pi sub-agent error] ', '【pi 子代理出错】');
