// Workflow engine: parses the script, provides agent/pipeline/parallel/phase/log/sh, per-model concurrency
// limits and the resume cache. It never touches pisub's run directories: launching pi, running commands and
// logging are all supplied by the caller through hooks (which keeps it easy to test).
import vm from 'node:vm';
import crypto from 'node:crypto';
import { L } from './i18n.mjs';

// ---------- meta ----------
// Find the object literal after `export const meta =` (skipping braces inside strings and comments)
function scanObject(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

export function extractMeta(src) {
  const m = /^\s*export\s+const\s+meta\s*=\s*/m.exec(src);
  if (!m) throw new Error(L('the script must start with `export const meta = { name, description, phases }`', '脚本必须以 `export const meta = { name, description, phases }` 开头'));
  const start = m.index + m[0].length;
  if (src[start] !== '{') throw new Error(L('meta must be an object literal', 'meta 必须是一个对象字面量'));
  const end = scanObject(src, start);
  if (end < 0) throw new Error(L('the meta object is not closed', 'meta 对象没有闭合'));
  let meta;
  try {
    // Round-trip through JSON: plain objects of this realm
    meta = JSON.parse(JSON.stringify(vm.runInNewContext(`(${src.slice(start, end)})`, Object.create(null), { timeout: 1000 })));
  } catch (e) {
    throw new Error(L(`meta must be a pure literal (no variables, calls, spreads or template interpolation): ${e.message}`, `meta 必须是纯字面量（不能有变量、函数调用、展开、模板插值）：${e.message}`));
  }
  if (!meta || typeof meta.name !== 'string' || !meta.name.trim()) throw new Error(L('meta.name is required', 'meta.name 必填'));
  if (typeof meta.description !== 'string') throw new Error(L('meta.description is required', 'meta.description 必填'));
  const phases = Array.isArray(meta.phases)
    ? meta.phases.map(p => (typeof p === 'string' ? { title: p } : { title: String(p?.title ?? ''), detail: p?.detail ? String(p.detail) : undefined }))
    : [];
  return { name: meta.name.trim(), description: meta.description, phases, concurrency: meta.concurrency, whenToUse: meta.whenToUse };
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

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
// A common subset: type, properties, required, items, enum, const, additionalProperties, min/maxItems, minimum/maximum, minLength
export function validate(schema, value, at = '$') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = types.some(x => x === t || (x === 'integer' && Number.isInteger(value)) || (x === 'number' && t === 'number'));
    if (!ok) return L(`${at} should be ${types.join('|')}, got ${t}`, `${at} 应为 ${types.join('|')}，实际是 ${t}`);
  }
  if (schema.enum && !schema.enum.some(x => JSON.stringify(x) === JSON.stringify(value))) return L(`${at} must be one of ${JSON.stringify(schema.enum)}`, `${at} 必须是 ${JSON.stringify(schema.enum)} 之一`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return L(`${at} must equal ${JSON.stringify(schema.const)}`, `${at} 必须等于 ${JSON.stringify(schema.const)}`);
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) return L(`${at} must be >= ${schema.minimum}`, `${at} 不能小于 ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) return L(`${at} must be <= ${schema.maximum}`, `${at} 不能大于 ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.minLength != null && value.length < schema.minLength) return L(`${at} must be at least ${schema.minLength} characters`, `${at} 长度不能小于 ${schema.minLength}`);
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) return L(`${at} needs at least ${schema.minItems} items`, `${at} 至少要有 ${schema.minItems} 项`);
    if (schema.maxItems != null && value.length > schema.maxItems) return L(`${at} allows at most ${schema.maxItems} items`, `${at} 最多 ${schema.maxItems} 项`);
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const e = validate(schema.items, value[i], `${at}[${i}]`);
        if (e) return e;
      }
    }
  }
  if (typeOf(value) === 'object') {
    for (const k of schema.required || []) if (!(k in value)) return L(`${at} is missing field ${k}`, `${at} 缺少字段 ${k}`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        const e = validate(props[k], v, `${at}.${k}`);
        if (e) return e;
      } else if (schema.additionalProperties === false) return L(`${at} must not have field ${k}`, `${at} 不允许有字段 ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const e = validate(schema.additionalProperties, v, `${at}.${k}`);
        if (e) return e;
      }
    }
  }
  return null;
}

// ---------- resume-cache key ----------
export function agentKey(prompt, opts) {
  const o = { ...opts };
  delete o.label;
  delete o.phase;
  const sorted = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)));
  return crypto.createHash('sha1').update(JSON.stringify({ prompt, opts: sorted })).digest('hex').slice(0, 16);
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
//   cached(key, n) => { value } | null     the previous run's result, if any
//   record(key, n, value, info)            store this run's result
// limits: { [model]: max, default }; stagger: { [model]: ms }
// defaultModel: alias for agent() calls without opts.model ('' = pisub's default)
export async function runFlow({ src, args, defaultModel = '', limits = {}, stagger = {}, hooks }) {
  const h = {
    log: () => {},
    phase: () => {},
    onCached: () => {},
    onError: () => {},
    isAborted: () => false,
    cached: () => null,
    record: () => {},
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
  const stats = { calls: 0, done: 0, failed: 0, cached: 0 };

  const abortedError = () => new Error(L('the workflow was stopped', '工作流已停止'));

  async function agent(prompt, opts) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError(L('agent() needs a non-empty string as its first argument', 'agent() 的第一个参数必须是非空字符串'));
    opts = opts && typeof opts === 'object' ? JSON.parse(JSON.stringify(opts)) : {};
    if (h.isAborted()) throw abortedError();
    const model = opts.model || defaultModel || '';
    const info = {
      index: ++counter,
      label: opts.label || prompt.trim().split('\n')[0].slice(0, 40),
      phase: opts.phase ?? current,
      model: model || L('default', '默认'),
    };
    const key = agentKey(prompt, { ...opts, model });
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    info.key = key;
    stats.calls++;
    const hit = h.cached(key, n);
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
      if (h.isAborted()) throw abortedError();
      const value = await h.runAgent(prompt, { ...opts, model }, info);
      if (value === null || value === undefined) {
        stats.failed++;
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

  async function sh(cmd, opts) {
    if (h.isAborted()) throw abortedError();
    if (!(typeof cmd === 'string' || (Array.isArray(cmd) && cmd.length && cmd.every(x => typeof x === 'string'))))
      throw new TypeError(L('sh() takes a command string or a [program, ...args] array', 'sh() 的参数是命令字符串，或 [程序, 参数...] 数组'));
    if (!h.runSh) throw new Error(L('sh() is not available here', '这里不能用 sh()'));
    return h.runSh(cmd, opts && typeof opts === 'object' ? { ...opts } : {});
  }

  const fmt = v => (typeof v === 'string' ? v : JSON.stringify(v));
  const context = vm.createContext({
    agent,
    pipeline,
    parallel,
    sh,
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
  const value = await script.runInContext(context);
  return { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)), stats };
}
