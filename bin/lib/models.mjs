// Model aliases and provider pools (cooldowns after a usage limit), and the usage ledger.
import fs from 'node:fs';
import path from 'node:path';
import { isServing, launchServe } from './runs.mjs';
import { ACCOUNTS_FILE, HOME, appendPrivate, mkdirp, now, readJSON, readLines, trunc, withFileLock, writeJSON } from './core.mjs';
import { L } from '../i18n.mjs';

export function ensureServing(id) {
  if (!isServing(id)) launchServe(id);
}

// ---------- models and provider pools ----------
export function loadCooldowns() {
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
export function providerAvailable(p, acc = loadCooldowns()) {
  const a = acc[p];
  return !a || !a.until || a.until <= now();
}
export function pickProvider(pool, exclude = []) {
  const acc = loadCooldowns();
  return pool.find(p => !exclude.includes(p) && providerAvailable(p, acc)) || null;
}
export function markExhausted(p, minutes, reason) {
  mkdirp(HOME);
  withFileLock(ACCOUNTS_FILE, () => {
    const acc = loadCooldowns();
    acc[p] = { until: now() + minutes * 60000, at: now(), reason: trunc(reason, 300) };
    writeJSON(ACCOUNTS_FILE, acc);
  });
  appendUsage({ t: now(), kind: 'limit', p, until: now() + minutes * 60000 });
}

// ---------- usage ledger ----------
// pi reports the tokens (and the list-price cost) of every reply. The broker adds them up per provider and model
// and writes one small line to usage/<YYYY-MM>.jsonl when a round ends (and every few minutes in a long round);
// a provider hitting its usage limit is noted there too. It is kept apart from the runs, so `pisub usage` still
// counts agents whose run folder was cleaned up.
export const USAGE_DIR = path.join(HOME, 'usage');
export const p2 = n => String(n).padStart(2, '0');
export const monthOf = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
};
export const dayOf = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
export function appendUsage(rec) {
  try {
    mkdirp(USAGE_DIR);
    appendPrivate(path.join(USAGE_DIR, `${monthOf(rec.t)}.jsonl`), JSON.stringify(rec) + '\n');
  } catch {}
}
// Ledger lines written at or after `since` (ms), oldest month first
export function readUsage(since) {
  let files = [];
  try {
    files = fs.readdirSync(USAGE_DIR).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f) && f.slice(0, 7) >= monthOf(since)).sort();
  } catch {}
  return files.flatMap(f => readLines(path.join(USAGE_DIR, f))).filter(r => r && r.t >= since);
}
export const fmtTokens = n => (n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`);
export const allPoolProviders = cfg => [...new Set(Object.values(cfg.aliases).flatMap(a => (Array.isArray(a?.providers) ? a.providers : [])))];
export function aliasInfo(name, a) {
  const pool = Array.isArray(a.providers) ? a.providers.filter(x => typeof x === 'string' && x) : [];
  return { alias: name, provider: a.provider || pool[0] || null, model: a.model || null, pool, thinking: a.thinking };
}
export function resolveModel(spec, cfg) {
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
export const modelLabel = st => (st.model ? (st.provider ? `${st.provider}/${st.model}` : st.model) : L('(pi default)', '（pi 默认）'));
export const isUsageLimit = e => /usage.?limit|usage_not_included|insufficient_quota|quota.?exceeded/i.test(e || '');
export const isTransient = e =>
  /overload|too many requests|rate.?limit|server_busy|capacity|(?<![\d])(429|500|502|503|504|520|524)(?![\d])|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|network|terminated|timed? ?out|connection error/i.test(
    e || ''
  );
