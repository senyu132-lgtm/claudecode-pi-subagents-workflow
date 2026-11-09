// Workflow engine: parses the script, provides agent/pipeline/parallel/phase/log/sh, per-model concurrency
// limits and the resume cache. It never touches pisub's run directories: launching pi, running commands and
// logging are all supplied by the caller through hooks (which keeps it easy to test).
import vm from 'node:vm';
import crypto from 'node:crypto';
import { L } from './i18n.mjs';
import { checkSchema, validate } from './schema.mjs';

export { checkSchema, validate };

// ---------- meta ----------
// meta is read without running anything: a strict parser for literal values. It takes JSON plus what people
// write in JS object literals (unquoted keys, single quotes, plain template strings, trailing commas,
// comments) and refuses everything that would have to run: variables, calls, spreads, computed keys,
// template interpolation, getters and methods.
export function parseLiteral(src, start = 0) {
  let i = start;
  const line = () => src.slice(0, i).split('\n').length;
  const fail = (en, zh) => {
    throw new Error(L(`${en} (line ${line()})`, `${zh}（第 ${line()} 行）`));
  };
  const IDENT = /[A-Za-z_$][\w$]*/y;
  const NUM = /-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
  const skip = () => {
    for (;;) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF' || c === '\u00A0' || c === '\u2028' || c === '\u2029') i++;
      else if (c === '/' && src[i + 1] === '/') while (i < src.length && src[i] !== '\n') i++;
      else if (c === '/' && src[i + 1] === '*') {
        const j = src.indexOf('*/', i + 2);
        if (j < 0) fail('a comment is not closed', '注释没有闭合');
        i = j + 2;
      } else return;
    }
  };
  const hex = n => {
    const h = src.slice(i, i + n);
    if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(h)) fail('bad escape sequence in a string', '字符串里的转义写法不对');
    i += n;
    return parseInt(h, 16);
  };
  const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
  const string = q => {
    let out = '';
    for (i++; ; ) {
      if (i >= src.length) fail('a string is not closed', '字符串没有闭合');
      const c = src[i];
      if (c === q) {
        i++;
        return out;
      }
      if (q === '`' && c === '$' && src[i + 1] === '{') fail('template interpolation (${...}) is not allowed in meta', 'meta 里不能用模板插值（${...}）');
      if (q !== '`' && (c === '\n' || c === '\r')) fail('a line break inside a quoted string', '引号字符串里有换行');
      if (c === '\\') {
        const d = src[++i];
        i++;
        if (d === 'u') {
          if (src[i] === '{') {
            const j = src.indexOf('}', i);
            const h = j > i ? src.slice(i + 1, j) : '';
            if (!/^[0-9a-fA-F]{1,6}$/.test(h) || parseInt(h, 16) > 0x10ffff) fail('bad escape sequence in a string', '字符串里的转义写法不对');
            out += String.fromCodePoint(parseInt(h, 16));
            i = j + 1;
          } else out += String.fromCharCode(hex(4));
        } else if (d === 'x') out += String.fromCharCode(hex(2));
        else if (d === '0' && !/\d/.test(src[i] || '')) out += '\0';
        else if (/\d/.test(d || '')) fail('octal escapes are not allowed', '不能用八进制转义');
        else if (d === '\r') { if (src[i] === '\n') i++; } // line continuation
        else if (d === '\n' || d === '\u2028' || d === '\u2029') {} // line continuation
        else out += ESC[d] ?? d;
        continue;
      }
      if (q === '`' && c === '\r') {
        // template strings turn CRLF into LF
        out += '\n';
        i += src[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      out += c;
      i++;
    }
  };
  const number = () => {
    NUM.lastIndex = i;
    const m = NUM.exec(src);
    if (!m) return undefined;
    const t = m[0];
    i += t.length;
    if (/[\w$]/.test(src[i] || '')) fail('not a plain number', '不是普通数字');
    return t.startsWith('-') ? -Number(t.slice(1)) : Number(t);
  };
  const value = depth => {
    if (depth > 64) fail('meta is nested too deeply', 'meta 嵌套太深');
    skip();
    const c = src[i];
    if (c === '{') {
      i++;
      const o = {};
      for (;;) {
        skip();
        if (src[i] === '}') {
          i++;
          return o;
        }
        let k;
        if (src[i] === '"' || src[i] === "'") k = string(src[i]);
        else if (/[\d.-]/.test(src[i] || '')) {
          const n = number();
          if (n === undefined) fail('expected a property name', '这里应该是属性名');
          k = String(n);
        } else {
          IDENT.lastIndex = i;
          const m = IDENT.exec(src);
          if (!m) fail(`expected a property name, found "${src[i] ?? 'end of script'}" (spreads and computed keys are not allowed)`, `这里应该是属性名，却是“${src[i] ?? '脚本结尾'}”（不能用展开或计算属性名）`);
          k = m[0];
          i += k.length;
        }
        skip();
        if (src[i] !== ':') fail(`expected ":" after "${k}" (shorthand properties, methods and getters are not allowed)`, `“${k}”后面应该是冒号（不能用简写属性、方法或 getter）`);
        i++;
        const v = value(depth + 1);
        Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
        skip();
        if (src[i] === ',') i++;
        else if (src[i] !== '}') fail(`expected "," or "}" after the value of "${k}"`, `“${k}”的值后面应该是逗号或 }`);
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      for (;;) {
        skip();
        if (src[i] === ']') {
          i++;
          return a;
        }
        if (src[i] === ',') fail('empty slots in arrays are not allowed', '数组里不能有空位');
        a.push(value(depth + 1));
        skip();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') fail('expected "," or "]" in an array', '数组里这里应该是逗号或 ]');
      }
    }
    if (c === '"' || c === "'" || c === '`') return string(c);
    if (/[\d.-]/.test(c || '')) {
      const n = number();
      if (n !== undefined) return n;
    }
    IDENT.lastIndex = i;
    const m = IDENT.exec(src);
    if (m) {
      const w = m[0];
      if (w === 'true' || w === 'false' || w === 'null') {
        i += w.length;
        return w === 'true' ? true : w === 'false' ? false : null;
      }
      fail(`"${w}" is not a literal value: meta cannot use variables, calls or expressions`, `“${w}”不是字面量：meta 里不能用变量、函数调用或表达式`);
    }
    fail(`unexpected "${c ?? 'end of script'}"`, `这里不该出现“${c ?? '脚本结尾'}”`);
  };
  const v = value(0);
  return { value: v, end: i };
}

export function extractMeta(src) {
  const m = /^\s*export\s+const\s+meta\s*=\s*/m.exec(src);
  if (!m) throw new Error(L('the script must start with `export const meta = { name, description, phases }`', '脚本必须以 `export const meta = { name, description, phases }` 开头'));
  const start = m.index + m[0].length;
  if (src[start] !== '{') throw new Error(L('meta must be an object literal', 'meta 必须是一个对象字面量'));
  let meta;
  try {
    meta = parseLiteral(src, start).value;
  } catch (e) {
    throw new Error(L(`meta must be a pure literal: ${e.message}`, `meta 必须是纯字面量：${e.message}`));
  }
  if (!meta || typeof meta.name !== 'string' || !meta.name.trim()) throw new Error(L('meta.name is required', 'meta.name 必填'));
  if (typeof meta.description !== 'string') throw new Error(L('meta.description is required', 'meta.description 必填'));
  const phases = Array.isArray(meta.phases)
    ? meta.phases.map(p => (typeof p === 'string' ? { title: p } : { title: String(p?.title ?? ''), detail: p?.detail ? String(p.detail) : undefined }))
    : [];
  return { name: meta.name.trim(), description: meta.description, phases, concurrency: meta.concurrency, whenToUse: meta.whenToUse, failFast: meta.failFast === true };
}

// Wrap the script in an async function: top-level await and return work; line numbers match the source
function wrap(src) {
  return `(async () => {${src.replace(/^(\s*)export\s+const\s+meta\s*=/m, '$1const meta =')}\n})()`;
}

// Syntax check only; nothing runs
export function checkScript(src) {
  const meta = extractMeta(src);
  try {
    new vm.Script(wrap(src), { filename: 'workflow.js' });
  } catch (e) {
    throw new Error(L(`script syntax error: ${e.message}`, `脚本语法错误：${e.message}`));
  }
  return meta;
}

// ---------- JSON output and validation ----------
export function extractJSON(text) {
  const t = String(text ?? '').trim();
  const tryParse = s => {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch {
      return null;
    }
  };
  let r = tryParse(t);
  if (r) return r;
  const blocks = [...t.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)].map(m => m[1]);
  for (let i = blocks.length - 1; i >= 0; i--) if ((r = tryParse(blocks[i].trim()))) return r;
  for (const [a, b] of [['{', '}'], ['[', ']']]) {
    const i = t.indexOf(a);
    const j = t.lastIndexOf(b);
    if (i >= 0 && j > i && (r = tryParse(t.slice(i, j + 1)))) return r;
  }
  return { ok: false, error: L('no valid JSON found in the answer', '回答里找不到合法的 JSON') };
}

// ---------- resume-cache key ----------
// Options that do not change what the agent is asked to do stay out of the key.
const KEY_IGNORED = ['label', 'phase', 'cache', 'retries', 'required'];
export const shKey = (cmd, opts) => crypto.createHash('sha1').update(JSON.stringify({ sh: cmd, cwd: opts.cwd ?? '', input: opts.input ?? null })).digest('hex').slice(0, 16);
// inputsHash: fingerprint of the files named in opts.inputs, so the key changes when their content does
export function agentKey(prompt, opts, inputsHash = '') {
  const o = { ...opts };
  for (const k of KEY_IGNORED) delete o[k];
  const sorted = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body = inputsHash ? { prompt, opts: sorted, inputs: inputsHash } : { prompt, opts: sorted };
  return crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}

// ---------- concurrency ----------
class Gate {
  constructor(limit, staggerMs) {
    this.limit = Math.max(1, limit | 0);
    this.staggerMs = staggerMs || 0;
    this.active = 0;
    this.queue = [];
    this.lastStart = 0;
  }
  async acquire() {
    if (this.active >= this.limit) await new Promise(r => this.queue.push(r));
    else this.active++;
    if (this.staggerMs) {
      const wait = this.lastStart + this.staggerMs - Date.now();
      this.lastStart = Math.max(Date.now(), this.lastStart + this.staggerMs);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

const errText = e => (e && e.message ? e.message : String(e));

// ---------- execution ----------
// hooks:
//   runAgent(prompt, opts, info) => Promise<any>   run one pi agent and return its result (null on failure)
//   runSh(cmd, opts) => Promise<{code, stdout, stderr}>
//   log(text) / phase(title) / onCached(info) / onError(text)
//   isAborted() => boolean
//   cached(key, n) => { value, modelKey? } | null   the previous run's result, if any
//   record(key, n, value, info)            store this run's result (info.modelKey: the model it was made with)
//   fingerprint(paths, opts) => string     hash of the files/folders an agent reads (opts.inputs)
//   onFatal(message, info)                 an agent the workflow cannot do without failed, or the script threw
//                                          while agents were running: stop the rest
//   modelKey(model) => string              what an alias resolves to (provider-independent), for the cache key
// limits: { [model]: max, default }; stagger: { [model]: ms }
// defaultModel: alias for agent() calls without opts.model ('' = pisub's default)
// failFast: any agent that still fails after its retries ends the whole workflow with an error
export async function runFlow({ src, args, defaultModel = '', limits = {}, stagger = {}, failFast = false, hooks }) {
  const h = {
    log: () => {},
    phase: () => {},
    onCached: () => {},
    onError: () => {},
    onFatal: () => {},
    isAborted: () => false,
    cached: () => null,
    record: () => {},
    fingerprint: () => '',
    modelKey: m => m,
    ...hooks,
  };
  const gates = new Map();
  const gate = model => {
    if (!gates.has(model)) gates.set(model, new Gate(limits[model] ?? limits.default ?? 4, stagger[model] ?? 0));
    return gates.get(model);
  };
  const seen = new Map();
  let counter = 0;
  let current = '';
  const stats = { calls: 0, done: 0, failed: 0, cached: 0, failures: [], unawaited: 0 };
  // Every agent()/sh() call still running: the workflow does not finish before they settle
  const inflight = new Set();
  const track = p => {
    inflight.add(p);
    p.then(() => inflight.delete(p), () => inflight.delete(p));
    return p;
  };
  // Set when a required agent (or, with failFast, any agent) fails; every later agent()/sh() call throws it
  let fatal = null;

  const abortedError = () => new Error(L('the workflow was stopped', '工作流已停止'));
  const checkRunning = () => {
    if (fatal) throw fatal;
    if (h.isAborted()) throw abortedError();
  };

  async function agent(prompt, opts) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError(L('agent() needs a non-empty string as its first argument', 'agent() 的第一个参数必须是非空字符串'));
    opts = opts && typeof opts === 'object' ? JSON.parse(JSON.stringify(opts)) : {};
    checkRunning();
    const model = opts.model || defaultModel || '';
    const info = {
      index: ++counter,
      label: opts.label || prompt.trim().split('\n')[0].slice(0, 40),
      phase: opts.phase ?? current,
      model: model || L('default', '默认'),
    };
    if (opts.schema !== undefined) {
      const bad = opts.schema && typeof opts.schema === 'object' ? checkSchema(opts.schema) : L('it must be an object', '它必须是对象');
      if (bad) throw new TypeError(L(`agent() option schema is not usable: ${bad}`, `agent() 的 schema 选项不能用：${bad}`));
    }
    const runOpts = { ...opts, model };
    let inputsHash = '';
    if (opts.inputs !== undefined) {
      const paths = Array.isArray(opts.inputs) ? opts.inputs : [opts.inputs];
      if (!paths.length || !paths.every(p => typeof p === 'string' && p.trim()))
        throw new TypeError(L('agent() option inputs must be a path or an array of paths', 'agent() 的 inputs 选项必须是路径或路径数组'));
      runOpts.inputs = paths;
      inputsHash = String((await h.fingerprint(paths, runOpts)) || '');
    }
    const retries = Math.max(0, Math.min(5, Math.floor(Number(opts.retries) || 0)));
    const key = agentKey(prompt, runOpts, inputsHash);
    // What the alias points to right now. A cached result made with another model is not reused.
    const modelKey = String((await h.modelKey(model)) ?? model);
    info.modelKey = modelKey;
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    info.key = key;
    stats.calls++;
    let hit = opts.cache === false ? null : h.cached(key, n);
    if (hit && hit.modelKey !== undefined && hit.modelKey !== modelKey) {
      h.log(L(`agent #${info.index} "${info.label}": ${model || 'default'} now means ${modelKey} (was ${hit.modelKey}), so it runs again instead of using the cache`, `代理 #${info.index}「${info.label}」：${model || '默认'} 现在指向 ${modelKey}（原来是 ${hit.modelKey}），不用缓存，重新运行`));
      hit = null;
    }
    if (hit) {
      stats.cached++;
      stats.done++;
      h.onCached(info);
      h.record(key, n, hit.value, { ...info, cached: true });
      return JSON.parse(JSON.stringify(hit.value));
    }
    const g = gate(model);
    await g.acquire();
    try {
      let value = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        checkRunning();
        if (attempt) h.log(L(`agent #${info.index} "${info.label}" failed; retry ${attempt}/${retries}`, `代理 #${info.index}「${info.label}」失败，重试 ${attempt}/${retries}`));
        value = await h.runAgent(prompt, runOpts, { ...info, attempt });
        if (value !== null && value !== undefined) break;
        if (fatal || h.isAborted()) break;
      }
      if (value === null || value === undefined) {
        stats.failed++;
        stats.failures.push({ index: info.index, label: info.label });
        if ((opts.required || failFast) && !fatal && !h.isAborted()) {
          fatal = new Error(
            opts.required
              ? L(`required agent #${info.index} "${info.label}" failed, so the workflow stopped`, `必需的代理 #${info.index}「${info.label}」失败，工作流已停止`)
              : L(`agent #${info.index} "${info.label}" failed and failFast is on, so the workflow stopped`, `代理 #${info.index}「${info.label}」失败，且开启了 failFast，工作流已停止`)
          );
          fatal.fatal = true;
          h.onFatal(fatal.message, info);
          throw fatal;
        }
        return null;
      }
      stats.done++;
      h.record(key, n, value, info);
      return value;
    } finally {
      g.release();
    }
  }

  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw new TypeError(L('pipeline() needs an array as its first argument', 'pipeline() 的第一个参数必须是数组'));
    for (const s of stages) if (typeof s !== 'function') throw new TypeError(L('pipeline() stages must be functions: pipeline(items, item => ..., result => ...)', 'pipeline() 的各阶段必须是函数：pipeline(items, item => ..., result => ...)'));
    return Promise.all(
      items.map(async (item, i) => {
        let v = item;
        try {
          for (const stage of stages) {
            v = await stage(v, item, i);
            if (v === null) return null;
          }
          return v;
        } catch (e) {
          h.onError(L(`pipeline item ${i} failed and becomes null: ${errText(e)}`, `pipeline 第 ${i} 项出错，记为 null：${errText(e)}`));
          return null;
        }
      })
    );
  }

  async function parallel(thunks) {
    if (!Array.isArray(thunks)) throw new TypeError(L('parallel() needs an array of functions', 'parallel() 的参数必须是函数数组'));
    return Promise.all(
      thunks.map(async (t, i) => {
        try {
          return typeof t === 'function' ? await t() : await t;
        } catch (e) {
          h.onError(L(`parallel item ${i} failed and becomes null: ${errText(e)}`, `parallel 第 ${i} 项出错，记为 null：${errText(e)}`));
          return null;
        }
      })
    );
  }

  // sh(cmd, { cache: true }): on resume, a command that succeeded (exit code 0) in the run being resumed is
  // not run again; its recorded output is returned. Without cache: true, resuming runs every sh() again.
  async function sh(cmd, opts) {
    checkRunning();
    if (!(typeof cmd === 'string' || (Array.isArray(cmd) && cmd.length && cmd.every(x => typeof x === 'string'))))
      throw new TypeError(L('sh() takes a command string or a [program, ...args] array', 'sh() 的参数是命令字符串，或 [程序, 参数...] 数组'));
    if (!h.runSh) throw new Error(L('sh() is not available here', '这里不能用 sh()'));
    opts = opts && typeof opts === 'object' ? { ...opts } : {};
    if (opts.cache !== true) return h.runSh(cmd, opts);
    const key = 'sh-' + shKey(cmd, opts);
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    const shown = Array.isArray(cmd) ? cmd.join(' ') : cmd;
    const info = { index: 0, label: `sh: ${shown.slice(0, 60)}` };
    const hit = h.cached(key, n);
    if (hit) {
      h.log(L(`sh (from cache, not run again): ${shown.slice(0, 200)}`, `sh（用缓存，没有重新执行）：${shown.slice(0, 200)}`));
      h.record(key, n, hit.value, { ...info, cached: true });
      return JSON.parse(JSON.stringify(hit.value));
    }
    const r = await h.runSh(cmd, opts);
    if (r && r.code === 0) h.record(key, n, r, info);
    return r;
  }

  const fmt = v => (typeof v === 'string' ? v : JSON.stringify(v));
  const context = vm.createContext({
    agent: (prompt, opts) => track(agent(prompt, opts)),
    pipeline,
    parallel,
    sh: (cmd, opts) => track(sh(cmd, opts)),
    phase: title => {
      current = String(title);
      h.phase(current);
    },
    log: msg => h.log(fmt(msg)),
    console: { log: (...a) => h.log(a.map(fmt).join(' ')) },
    args: args === undefined ? undefined : JSON.parse(JSON.stringify(args)),
    setTimeout,
    clearTimeout,
  });
  const script = new vm.Script(wrap(src), { filename: 'workflow.js' });
  let value;
  let failed = null;
  try {
    value = await script.runInContext(context);
  } catch (e) {
    failed = fatal || e;
  }
  if (inflight.size) {
    if (failed) {
      // The script failed while agents were still running: stop them instead of leaving them working unwatched
      if (!fatal) {
        fatal = failed;
        h.onFatal(L(`the workflow script failed, so its ${inflight.size} running agent()/sh() calls were stopped: ${errText(failed)}`, `工作流脚本出错，已停止它还在运行的 ${inflight.size} 个 agent()/sh() 调用：${errText(failed)}`));
      }
    } else {
      // Returned without awaiting them (a missing await): the result is not final until they settle
      stats.unawaited = inflight.size;
      h.log(L(`the script returned while ${inflight.size} agent()/sh() calls were still running (missing await?); waiting for them before finishing`, `脚本返回时还有 ${inflight.size} 个 agent()/sh() 调用在运行（漏了 await？），等它们结束后再收尾`));
    }
    while (inflight.size) await Promise.allSettled([...inflight]);
  }
  if (failed) throw failed;
  // The script may have caught the error itself (pipeline/parallel turn it into null): it still fails
  if (fatal) throw fatal;
  return { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)), stats };
}
