#!/usr/bin/env node
// Smoke test against a real model, about a minute. Run it after installing or upgrading, or after changing
// your config, to see that the whole path works: pisub -> broker -> pi -> your provider and back.
//
//   node tests/smoke.mjs [--model alias|provider/model] [--keep]
//
// It runs pisub in a temporary PI_SUBAGENTS_HOME. Your config.json and accounts.json are copied in; nothing
// in your own ~/.pi-subagents is touched, and pi's session files go to the temporary folder too. The model
// defaults to config.json's defaultAlias; pick a cheap one, it makes about 6 model calls. Checks:
//   1. spawn --wait prints the final answer
//   2. an interrupt cuts a long tool call short and the agent answers the new message
//   3. a finished agent turns messages down
//   4. a workflow dry run starts nothing and counts the agents
//   5. a small real workflow: two agents with a schema in parallel, then a readonly sh() check
//   6. the usage ledger recorded the tokens
// Exit code 0 when all pass. The temporary folder is deleted on success (kept with --keep or on failure).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PISUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pisub.mjs');
const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const KEEP = argv.includes('--keep');
const SRC_HOME = process.env.PI_SUBAGENTS_HOME || path.join(os.homedir(), '.pi-subagents');
const config = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(SRC_HOME, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const MODEL = opt('--model') || config.defaultAlias || '';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pisub-smoke-'));
for (const f of ['config.json', 'accounts.json']) if (fs.existsSync(path.join(SRC_HOME, f))) fs.copyFileSync(path.join(SRC_HOME, f), path.join(HOME, f));
const WORK = path.join(HOME, 'work');
fs.mkdirSync(WORK);
const OWNER = 'smoke-test';
const env = { ...process.env, PI_SUBAGENTS_HOME: HOME, PISUB_LANG: 'en', PI_SUBAGENTS_OWNER: OWNER };

const pisub = (args, timeoutSec = 180) => {
  const r = spawnSync(process.execPath, [PISUB, ...args], { env, encoding: 'utf8', timeout: timeoutSec * 1000, windowsHide: true });
  return { code: r.status ?? -1, out: r.stdout || '', err: (r.stderr || '') + (r.error ? String(r.error) : '') };
};
const modelArgs = MODEL ? ['--model', MODEL] : [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = s => String(s).replace(/\s+/g, ' ').trim().slice(0, 300);

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  if (process.stdout.isTTY) process.stdout.write(`… ${name}\r`);
  try {
    const note = await fn();
    results.push(true);
    console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${note ? ` - ${note}` : ''}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${e.message}`);
  }
}
const expect = (ok, msg) => {
  if (!ok) throw new Error(msg);
};

console.log(`pisub smoke test, model: ${MODEL || "(pi's default)"}, home: ${HOME}`);

await check('spawn --wait returns the final answer', () => {
  const r = pisub(['spawn', ...modelArgs, '--cwd', WORK, '--name', 'smoke-ping', '--wait', '--timeout', '150', 'Reply with exactly the word PONG and nothing else. Do not use any tools.']);
  expect(r.code === 0, `exit code ${r.code}: ${short(r.err || r.out)}`);
  expect(/pong/i.test(r.out), `answer has no PONG: ${short(r.out)}`);
});

let sleeper = '';
await check('interrupt cuts a long tool call short', async () => {
  const r = pisub(['spawn', ...modelArgs, '--cwd', WORK, '--name', 'smoke-sleep', '--json', 'Use your bash tool to run exactly this command and nothing else: sleep 90 . When it has finished, reply DONE.']);
  expect(r.code === 0, `spawn failed: ${short(r.err || r.out)}`);
  sleeper = JSON.parse(r.out).id;
  const view = path.join(HOME, 'runs', sleeper, 'view.jsonl');
  const t0 = Date.now();
  let started = false;
  while (!started && Date.now() - t0 < 90000) {
    await sleep(500);
    const lines = fs.existsSync(view) ? fs.readFileSync(view, 'utf8').split('\n') : [];
    started = lines.some(l => l.includes('"k":"tool"') && l.includes('sleep'));
    const st = pisub(['status', sleeper, '--json']);
    const s = st.code === 0 ? JSON.parse(st.out) : {};
    expect(!['done', 'error', 'stopped'].includes(s.status), `the agent ended (${s.status}) before running sleep: ${short(s.lastError || '')}`);
  }
  expect(started, 'the agent did not start `sleep 90` within 90 s');
  const t1 = Date.now();
  const s = pisub(['send', sleeper, '--mode', 'interrupt', 'Stop. Do not run any more commands. Reply with exactly the word STOPPED.']);
  expect(s.code === 0, `send --mode interrupt failed: ${short(s.err || s.out)}`);
  const w = pisub(['wait', sleeper, '--timeout', '120']);
  const secs = (Date.now() - t1) / 1000;
  expect(/stopped/i.test(w.out), `answer has no STOPPED: ${short(w.out)}`);
  expect(secs < 75, `the answer came ${secs.toFixed(0)} s after the interrupt: sleep was not cut short`);
  return `answered ${secs.toFixed(1)} s after the interrupt`;
});

await check('a finished agent turns messages down', () => {
  expect(sleeper, 'no agent from the previous check');
  const r = pisub(['send', sleeper, 'one more thing']);
  expect(r.code !== 0, 'send to a finished agent succeeded');
  expect(/takes no more messages/.test(r.err + r.out), `unexpected message: ${short(r.err + r.out)}`);
});

const SCRIPT = path.join(HOME, 'smoke-flow.mjs');
fs.writeFileSync(
  SCRIPT,
  `export const meta = { name: 'smoke', description: 'pisub smoke test' }
const model = args.model || undefined
const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false }
const ask = q => agent(q + ' Answer only with JSON of the form {"n": <the number>}. Do not use any tools.', { model, schema, label: q })
phase('Ask')
const [a, b] = await parallel([() => ask('What is 2 + 3?'), () => ask('What is 4 + 5?')])
phase('Check')
const c = await sh(['node', '-e', 'process.exit(Number(process.argv[1]) === 14 ? 0 : 1)', String((a?.n ?? 0) + (b?.n ?? 0))], { readonly: true })
return { a: a?.n ?? null, b: b?.n ?? null, check: c.code }
`
);
const flowArgs = ['--owner', OWNER, '--script-file', SCRIPT, '--cwd', WORK, '--args', JSON.stringify({ model: MODEL })];
pisub(['flow', 'enable', '--session', OWNER]);

await check('workflow dry run starts nothing', () => {
  const r = pisub(['flow', 'run', ...flowArgs, '--dry-run'], 90);
  expect(r.code === 0, `exit code ${r.code}: ${short(r.out || r.err)}`);
  expect(/would start 2 agents/.test(r.out), `unexpected report: ${short(r.out)}`);
  const runs = fs.existsSync(path.join(HOME, 'runs')) ? fs.readdirSync(path.join(HOME, 'runs')) : [];
  expect(!runs.some(id => id.startsWith('wf-')), 'the dry run made a run folder');
});

let flowId = '';
await check('a real workflow: two agents with a schema, then sh()', () => {
  const r = pisub(['flow', 'run', ...flowArgs, '--json'], 30);
  expect(r.code === 0, `flow run failed: ${short(r.err || r.out)}`);
  flowId = JSON.parse(r.out).id;
  const w = pisub(['wait', flowId, '--timeout', '240'], 260);
  const st = JSON.parse(pisub(['status', flowId, '--json']).out || '{}');
  expect(st.status === 'done', `workflow ended as ${st.status}: ${short(st.lastError || w.out)}`);
  expect(/"a": 5/.test(w.out) && /"b": 9/.test(w.out), `wrong answers: ${short(w.out)}`);
  expect(/"check": 0/.test(w.out), `the sh() check failed: ${short(w.out)}`);
});

await check('usage ledger recorded the tokens', () => {
  const r = pisub(['usage', '--days', '1', '--json']);
  expect(r.code === 0, `usage failed: ${short(r.err)}`);
  const u = JSON.parse(r.out);
  const agents = u.rows.reduce((n, x) => n + (x.agents || 0), 0);
  const total = u.rows.reduce((n, x) => n + (x.total || 0), 0);
  expect(total > 0, `no tokens recorded: ${short(r.out)}`);
  expect(agents >= 4, `${agents} agents in the ledger, expected 4 (provider may not report usage)`);
  if (flowId) {
    const byWf = JSON.parse(pisub(['usage', '--days', '1', '--by', 'workflow', '--json']).out);
    expect(byWf.rows.some(x => x.key === flowId), 'the workflow is not in `usage --by workflow`');
  }
  return `${agents} agents, ${total} tokens`;
});

const failed = results.filter(x => !x).length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED. Runs and logs are kept in ${HOME}` : `\nAll ${results.length} checks passed.`);
if (!failed && !KEEP) {
  // Brokers may still be closing files for a moment
  try {
    fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (e) {
    console.log(`(could not delete ${HOME}: ${e.message})`);
  }
} else if (!failed) console.log(`Kept ${HOME}`);
process.exit(failed ? 1 : 0);
