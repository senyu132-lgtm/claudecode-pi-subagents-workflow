// Fault-injection tests for the broker: node --test tests/broker.node-test.mjs
// Real pisub processes against tests/fake-pi.mjs (through PI_CLI), each test in its own temporary
// PI_SUBAGENTS_HOME, so nothing touches your own ~/.pi-subagents.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PISUB = path.join(here, '..', 'bin', 'pisub.mjs');
const FAKE = path.join(here, 'fake-pi.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const homes = [];

function home(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisub-test-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ language: 'en', rpcTimeoutSec: 3, keepRunsDays: 0, ...config }));
  homes.push(dir);
  return dir;
}
function pisub(h, args, { env = {}, input, timeout = 90000, cwd } = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [PISUB, ...args], {
      cwd: cwd || h,
      env: { ...process.env, PI_SUBAGENTS_HOME: h, PI_CLI: FAKE, PISUB_LANG: 'en', FAKE_PI: '', FAKE_PI_ONCE: '', FAKE_PI_ARGV: '', ...env },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    const timer = setTimeout(() => p.kill(), timeout);
    p.on('close', code => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    p.stdin.end(input);
  });
}
const runDir = (h, id) => path.join(h, 'runs', id);
const state = (h, id) => JSON.parse(fs.readFileSync(path.join(runDir(h, id), 'state.json'), 'utf8'));
const final = (h, id) => fs.readFileSync(path.join(runDir(h, id), 'final.md'), 'utf8');
const view = (h, id) => fs.readFileSync(path.join(runDir(h, id), 'view.jsonl'), 'utf8');
async function until(fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(150);
  }
}
const killPid = pid => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(pid, 'SIGKILL');
};
// Start an agent and return its id
async function start(h, task, args = [], env = {}) {
  const r = await pisub(h, ['spawn', ...args, task], { env });
  assert.equal(r.code, 0, r.err);
  return r.out;
}

after(async () => {
  await sleep(500);
  for (const h of homes) try { fs.rmSync(h, { recursive: true, force: true }); } catch {}
});

describe('broker', { concurrency: 8 }, () => {
  it('a normal run: --wait prints only the final answer', async () => {
    const h = home();
    const r = await pisub(h, ['spawn', '--wait', '--timeout', '60', 'count the rows']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'answer: count the rows');
  });

  it('usage: every reply is added to the ledger; pisub usage sums it per provider and model, and notes usage limits', async () => {
    const h = home({ aliases: { cheap: { provider: 'fake', model: 'fake-model' } } });
    for (const t of ['one', 'two']) assert.equal((await pisub(h, ['spawn', '--model', 'cheap', '--wait', '--timeout', '60', t])).code, 0);
    const u = JSON.parse((await pisub(h, ['usage', '--json'])).out);
    assert.deepEqual(
      u.rows.map(r => [r.key, r.agents, r.replies, r.input, r.output, r.total]),
      [['fake / fake-model', 2, 2, 200, 20, 220]]
    );
    const text = (await pisub(h, ['usage'])).out;
    assert.match(text, /fake \/ fake-model\s+2\s+2\s+200\s+20\s+0\s+220\s+\$0\.00/);
    assert.match((await pisub(h, ['usage', '--by', 'alias'])).out, /^cheap\s+2/m);
    // A usage limit, as a provider pool records it, shows up too
    const ledger = path.join(h, 'usage', fs.readdirSync(path.join(h, 'usage'))[0]);
    fs.appendFileSync(ledger, JSON.stringify({ t: Date.now(), kind: 'limit', p: 'fake', until: Date.now() + 3600000 }) + '\n');
    assert.match((await pisub(h, ['usage'])).out, /Usage limits hit:\n {2}fake/);
    assert.equal((await pisub(h, ['usage', '--by', 'colour'])).code, 1);
  });

  it('an id never starts with "-" or ".", so a name in another script still gives an id the CLI takes', async () => {
    const h = home();
    for (const [name, prefix] of [['验收-打断', 'pi-'], ['.审查', 'pi-'], ['a-审查', 'a-'], ['--x--', 'x-']]) {
      const id = await start(h, 'count the rows', ['--name', name]);
      assert.ok(id.startsWith(prefix), `${name} -> ${id}`);
      const r = await pisub(h, ['wait', id, '--timeout', '60']);
      assert.equal(r.code, 0, r.err);
    }
  });

  it('tool calls are counted for the transcript row: the last ones in live.json, the total in state.json', async () => {
    const h = home();
    const id = await start(h, '[slow 1500] count the rows');
    const live = await until(() => {
      const l = JSON.parse(fs.readFileSync(path.join(runDir(h, id), 'live.json'), 'utf8'));
      return l.tools === 1 ? l : null;
    });
    assert.equal(live.recent.length, 1);
    assert.equal(live.recent[0].name, 'bash');
    assert.match(live.recent[0].args, /sleep 1500/);
    await until(() => state(h, id).status === 'done');
    assert.equal(state(h, id).toolUses, 1);
  });

  it('a prompt pi turns down ends the round with an error, not a run that never ends (T02)', async () => {
    const h = home();
    const t0 = Date.now();
    const r = await pisub(h, ['spawn', '--wait', '--timeout', '60', '[reject] do it']);
    assert.equal(r.code, 1);
    assert.match(r.out, /pi rejected the message: rejected \(test\)/);
    assert.ok(Date.now() - t0 < 20000);
  });

  it('a prompt pi handles itself (no run) still ends the round (P1-11)', async () => {
    const h = home();
    const r = await pisub(h, ['spawn', '--wait', '--timeout', '60', '[handled] /some-command']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /without writing a final answer/);
  });

  it('pi that never answers get_state is given up on after rpcTimeoutSec (T03)', async () => {
    const h = home({ rpcTimeoutSec: 2 });
    const r = await pisub(h, ['spawn', '--wait', '--timeout', '60', 'task'], { env: { FAKE_PI: 'hang-state' } });
    assert.equal(r.code, 1);
    assert.match(r.out, /did not answer "get_state" within 2s/);
  });

  it('lines that are not JSON are counted and end the run with a protocol error (T33)', async () => {
    const h = home();
    const r = await pisub(h, ['spawn', '--wait', '--timeout', '60', '[garbage] task']);
    assert.equal(r.code, 1);
    assert.match(r.out, /100 lines that are not valid JSON/);
    const id = JSON.parse(`[${view(h, fs.readdirSync(path.join(h, 'runs'))[0]).trim().split('\n').join(',')}]`);
    // Only the first few bad lines are logged
    assert.equal(id.filter(e => /not JSON \(skipped\)/.test(e.text || '')).length, 5);
  });

  it('65 MB without a line break does not grow memory without end (P2-05)', async () => {
    const h = home();
    const r = await pisub(h, ['spawn', '--wait', '--timeout', '60', '[bigline] task']);
    assert.equal(r.code, 1);
    assert.match(r.out, /more than 64 MB without a line break/);
  });

  it('an agent that goes silent is stopped by the watchdog (P1-05)', async () => {
    const h = home({ stallTimeoutMin: 0.05 });
    const r = await pisub(h, ['spawn', '--wait', '--timeout', '60', '[silent] task']);
    assert.equal(r.code, 1);
    assert.match(r.out, /sent nothing for 0.05 min while working/);
  });

  it('a tool call that never ends is stopped by the watchdog', async () => {
    const h = home({ toolTimeoutMin: 0.05, stallTimeoutMin: 0 });
    const r = await pisub(h, ['spawn', '--wait', '--timeout', '60', '[toolhang] task']);
    assert.equal(r.code, 1);
    assert.match(r.out, /tool call has been running for over 0.05 min/);
  });

  it('pi dying in the middle of a run ends it with an error and its stderr', async () => {
    const h = home();
    const r = await pisub(h, ['spawn', '--wait', '--timeout', '60', '[exit] task']);
    assert.equal(r.code, 1);
    assert.match(r.out, /exited unexpectedly \(exit code 3\)/);
  });

  it('messages sent while it works arrive in order (T22)', async () => {
    const h = home();
    const id = await start(h, '[slow 10000] long task');
    await until(() => state(h, id).status === 'running' && view(h, id).includes('"k":"tool"'));
    for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) assert.equal((await pisub(h, ['send', id, m])).code, 0);
    const r = await pisub(h, ['wait', id, '--timeout', '60']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /steers: m1,m2,m3,m4,m5/);
  });

  it('a message read but not yet accepted survives a killed broker and is delivered by the next one (T01)', async () => {
    const h = home();
    const once = path.join(h, 'once');
    const env = { FAKE_PI_ONCE: once };
    const id = await start(h, 'important task', [], env);
    // The first pi got the prompt and never answers it; kill the broker while it waits
    await until(() => fs.existsSync(once));
    const st = state(h, id);
    killPid(st.brokerPid);
    killPid(Number(fs.readFileSync(once, 'utf8')));
    await sleep(500);
    assert.equal(fs.readdirSync(path.join(runDir(h, id), 'inbox')).filter(f => f.endsWith('.json')).length, 1);
    // Anyone waiting notices the dead broker and starts a new one, which delivers the message
    const r = await pisub(h, ['wait', id, '--timeout', '60'], { env });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'answer: important task');
  });

  it('a broker killed while pi works is settled as an error with a final answer (T04)', async () => {
    const h = home();
    const id = await start(h, '[slow 60000] long task');
    await until(() => view(h, id).includes('"k":"tool"'));
    const st = state(h, id);
    killPid(st.brokerPid);
    killPid(st.piPid);
    // Within the 15 s grace period it still counts as running; afterwards status records the failure
    await sleep(16000);
    const r = await pisub(h, ['status', id, '--json']);
    assert.equal(JSON.parse(r.out).status, 'error');
    assert.equal(state(h, id).status, 'error');
    assert.match(final(h, id), /broker process exited unexpectedly/);
    // Settled once: looking again changes nothing
    const rounds = state(h, id).rounds;
    await pisub(h, ['status', id]);
    assert.equal(state(h, id).rounds, rounds);
  });

  it('a lock held by a live process that stopped beating is taken over (T32)', async () => {
    const h = home();
    const id = await start(h, 'first');
    assert.equal((await pisub(h, ['wait', id, '--timeout', '60'])).code, 0);
    // A lock that names a running process (this test runner) but has an old heartbeat
    fs.writeFileSync(path.join(runDir(h, id), 'serve.lock'), JSON.stringify({ pid: process.pid, at: Date.now() - 120000, token: 'other' }));
    // A message queued the way a workflow's "resubmit in the right format" does it (send refuses a finished agent)
    const inbox = path.join(runDir(h, id), 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, `${String(Date.now()).padStart(14, '0')}-000001-1.json`), JSON.stringify({ text: 'second', from: 'system', mode: 'steer', at: Date.now() }));
    const r = await pisub(h, ['_serve', id]);
    assert.equal(r.code, 0, r.err);
    assert.equal(state(h, id).rounds, 2);
    assert.equal(final(h, id).trim(), 'answer: second');
  });

  it('an agent that has given its final answer is closed: send refuses it and queues nothing', async () => {
    const h = home();
    const id = await start(h, 'count the rows');
    assert.equal((await pisub(h, ['wait', id, '--timeout', '60'])).code, 0);
    const r = await pisub(h, ['send', id, 'and by region']);
    assert.equal(r.code, 1);
    assert.match(r.err, /finished and is closed; it takes no more messages/);
    assert.equal(fs.existsSync(path.join(runDir(h, id), 'inbox')) ? fs.readdirSync(path.join(runDir(h, id), 'inbox')).length : 0, 0);
    assert.equal(state(h, id).rounds, 1);
  });

  it('interrupt stops the current step at once and carries on with the new instruction in the same round', async () => {
    const h = home();
    const id = await start(h, '[slow 60000] count the rows');
    await until(() => /"k":"tool"/.test(view(h, id)));
    const t0 = Date.now();
    const s = await pisub(h, ['send', id, '--mode', 'interrupt', 'use sales-2025.csv instead']);
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /an interrupt/);
    const r = await pisub(h, ['wait', id, '--timeout', '60']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'answer: use sales-2025.csv instead');
    assert.ok(Date.now() - t0 < 20000, 'did not wait for the 60 s tool call');
    const st = state(h, id);
    assert.equal(st.status, 'done');
    assert.equal(st.rounds, 1);
    const v = view(h, id);
    assert.match(v, /"from":"claude","mode":"interrupt","text":"use sales-2025.csv instead"/);
    assert.match(v, /Interrupted: stopping the current step/);
    assert.doesNotMatch(v, /"k":"error"/);
  });

  it('an interrupt while waiting out an overload cuts the wait short and does not resume the old step', async () => {
    const h = home({ overloadBackoffSec: [120] });
    const id = await start(h, '[overload] count the rows');
    await until(() => state(h, id).status === 'waiting');
    const t0 = Date.now();
    const s = await pisub(h, ['send', id, '--mode', 'interrupt', 'just say hi']);
    assert.equal(s.code, 0, s.err);
    const r = await pisub(h, ['wait', id, '--timeout', '60']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'answer: just say hi');
    assert.ok(Date.now() - t0 < 20000, 'did not wait out the 120 s backoff');
    // The old step was not resumed after the interrupt
    await sleep(1000);
    assert.doesNotMatch(view(h, id), /previous request was interrupted/);
    assert.equal(state(h, id).rounds, 1);
  });

  it('maxAgents: a second agent waits for a free slot (P2-01)', async () => {
    const h = home({ maxAgents: 1 });
    const a = await start(h, '[slow 3000] first');
    await until(() => state(h, a).status === 'running');
    const b = await start(h, 'second');
    await until(() => state(h, b).status === 'queued');
    assert.match(view(h, b), /waiting for a free slot/);
    const [ra, rb] = await Promise.all([pisub(h, ['wait', a, '--timeout', '60']), pisub(h, ['wait', b, '--timeout', '60'])]);
    assert.equal(ra.code, 0);
    assert.equal(rb.code, 0);
    assert.ok(state(h, b).finishedAt > state(h, a).finishedAt);
  });

  it('stopping an agent that waits for a slot keeps it from ever starting', async () => {
    const h = home({ maxAgents: 1 });
    const a = await start(h, '[slow 3000] first');
    await until(() => state(h, a).status === 'running');
    const b = await start(h, 'second');
    await until(() => state(h, b).status === 'queued');
    assert.equal((await pisub(h, ['send', b, 'note for later'])).code, 0);
    await pisub(h, ['stop', b]);
    await until(() => state(h, b).status === 'stopped');
    assert.match(final(h, b), /never started/);
    // A message it could no longer receive is named, not dropped silently
    assert.match(final(h, b), /not delivered: .*note for later/);
    await pisub(h, ['wait', a, '--timeout', '60']);
  });

  it('stop ends a working agent', async () => {
    const h = home();
    const id = await start(h, '[slow 60000] long task');
    await until(() => view(h, id).includes('"k":"tool"'));
    await pisub(h, ['stop', id]);
    const r = await pisub(h, ['wait', id, '--timeout', '30']);
    assert.equal(r.code, 2);
    assert.equal(state(h, id).status, 'stopped');
  });

  it('read-only agents get pi with MCP and project-local extensions switched off (P1-07)', async () => {
    const h = home();
    const argvFile = path.join(h, 'argv.jsonl');
    const r = await pisub(h, ['spawn', '--readonly', '--wait', '--timeout', '60', 'look around'], { env: { FAKE_PI_ARGV: argvFile } });
    assert.equal(r.code, 0, r.err);
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8').trim().split('\n')[0]);
    for (const a of ['--tools', 'read,grep,find,ls', '--no-mcp', '--no-approve', '--no-context-files']) assert.ok(argv.includes(a), a);
  });

  it('many agents started at once all get their own run folder (T20)', async () => {
    const h = home();
    const rs = await Promise.all(Array.from({ length: 12 }, () => pisub(h, ['spawn', '--name', 'same', 'x'])));
    const ids = rs.map(r => r.out);
    assert.equal(new Set(ids).size, 12);
    await Promise.all(ids.map(id => pisub(h, ['wait', id, '--timeout', '60'])));
    for (const id of ids) assert.equal(state(h, id).status, 'done');
  });

  it('a broken config.json is reported, not silently replaced by defaults (P2-11)', async () => {
    const h = home();
    fs.writeFileSync(path.join(h, 'config.json'), '{ "language": "en", ');
    const r = await pisub(h, ['spawn', 'x']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /config\.json is not valid JSON/);
  });

  it('a config value of the wrong type is refused, naming the key', async () => {
    for (const [config, re] of [
      [{ overloadBackoffSec: 5 }, /overloadBackoffSec must be a list of seconds/],
      [{ maxAgents: 'many' }, /maxAgents must be a number, 0 or more, not "many"/],
      [{ flowConcurrency: 8 }, /flowConcurrency must be an object/],
      [{ stallTimeoutMin: null }, /stallTimeoutMin must be a number/],
    ]) {
      const r = await pisub(home(config), ['spawn', 'x']);
      assert.notEqual(r.code, 0);
      assert.match(r.err, re);
    }
  });

  it('run files are private to the user (N-14, POSIX only)', { skip: process.platform === 'win32' }, async () => {
    const h = home();
    const id = await start(h, 'x');
    await pisub(h, ['wait', id, '--timeout', '60']);
    assert.equal(fs.statSync(runDir(h, id)).mode & 0o077, 0);
    for (const f of ['state.json', 'task.md', 'final.md', 'view.jsonl']) assert.equal(fs.statSync(path.join(runDir(h, id), f)).mode & 0o077, 0, f);
  });
});

describe('workflows', { concurrency: 4 }, () => {
  const flow = async (h, script, extra = []) => {
    const file = path.join(h, `wf-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(file, script);
    await pisub(h, ['flow', 'enable', '--session', 'S']);
    return pisub(h, ['flow', 'run', '--owner', 'S', '--script-file', file, '--wait', '--cwd', h, ...extra]);
  };
  const META = `export const meta = { name: 'test', description: 'd' }\n`;

  it('a script that throws stops the agents it started (T25)', async () => {
    const h = home();
    const t0 = Date.now();
    const r = await flow(h, META + `agent('[slow 60000] long'); await new Promise(r => setTimeout(r, 3000)); throw new Error('script bug')`);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /script bug/);
    assert.ok(Date.now() - t0 < 40000);
    const kids = fs.readdirSync(path.join(h, 'runs')).map(id => state(h, id)).filter(s => s.parent);
    assert.equal(kids.length, 1);
    assert.equal(kids[0].status, 'stopped');
  });

  it('an agent that ends without an answer counts as failed (T19)', async () => {
    const h = home();
    const r = await flow(h, META + `const a = await agent('[empty] x'); const b = await agent('y'); return { a, b }`);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 failed/);
    assert.match(r.out, /without writing a final answer/);
    assert.match(r.out, /"a": null/);
    const wf = fs.readdirSync(path.join(h, 'runs')).map(id => state(h, id)).find(s => s.kind === 'flow');
    assert.equal(wf.failed, 1);
  });

  it('the summary gives the tokens used and points at agents that look like they cut corners', async () => {
    const h = home();
    const S = `{ type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }`;
    // 8 agents of one phase and model: all answer label A, and #8 calls no tool where the others call 3
    const r = await flow(
      h,
      META + `phase('Label')\nreturn (await parallel(Array.from({ length: 8 }, (_, i) => () => agent((i < 7 ? '[tools 3] ' : '') + '[json label=A] item ' + i, { schema: ${S}, label: 'item ' + i })))).length`
    );
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Usage: 880 tokens/);
    assert.match(r.out, /Worth a second look/);
    assert.match(r.out, /#8 item 7 \(default\): called no tool \(group median 3\)/);
    assert.match(r.out, /field label is "A" in 8 of 8 answers/);
    assert.doesNotMatch(r.out, /#[1-7] item/);
    const wf = fs.readdirSync(path.join(h, 'runs')).map(id => state(h, id)).find(s => s.kind === 'flow');
    assert.equal(wf.usage.total, 880);
    // The ledger has a line per agent, tagged with the workflow
    const u = JSON.parse((await pisub(h, ['usage', '--by', 'workflow', '--json'])).out);
    assert.equal(u.rows.length, 1);
    assert.equal(u.rows[0].key, wf.id);
    assert.equal(u.rows[0].agents, 8);
    assert.equal(u.rows[0].total, 880);
  });

  it('a dry run checks the script with fake agents and starts nothing', async () => {
    const h = home({ aliases: { cheap: { provider: 'fake', model: 'fake-model' } } });
    const file = path.join(h, 'dry.mjs');
    const S = `{ type: 'object', properties: { verdict: { enum: ['ok', 'bad'] }, score: { type: 'integer', minimum: 1, maximum: 5 }, notes: { type: 'array', items: { type: 'string' }, minItems: 2 } }, required: ['verdict', 'score'] }`;
    fs.writeFileSync(
      file,
      META +
        `phase('Check')\nconst rs = await pipeline(args.items, it => agent('check ' + it, { model: 'cheap', schema: ${S} }), async (v, it) => {\n` +
        `  const r = await sh(['node', '-e', 'process.exit(3)'], { readonly: true })\n  const w = await sh('rm -rf /nothing-here')\n` +
        `  return v.verdict === 'ok' ? { it, v, code: r.code, w: w.code } : await agent('redo ' + it, { model: 'cheep' })\n})\nreturn rs`
    );
    await pisub(h, ['flow', 'enable', '--session', 'S']);
    const r = await pisub(h, ['flow', 'run', '--owner', 'S', '--script-file', file, '--cwd', h, '--args', '{"items":["a","b"]}', '--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /The script ran to the end/);
    assert.match(r.out, /A real run would start 2 agents \(cheap 2\)/);
    assert.match(r.out, /2 readonly commands run, 2 skipped/);
    assert.match(r.out, /exit code 3: node -e process\.exit\(3\)/);
    assert.match(r.out, /skipped: rm -rf \/nothing-here/);
    assert.match(r.out, /"verdict": "ok"/);
    assert.match(r.out, /"score": 1/);
    assert.match(r.out, /"code": 3/);
    assert.match(r.out, /"w": 0/);
    // Nothing started, nothing recorded
    assert.deepEqual(fs.readdirSync(path.join(h, 'runs')), []);
    // An error is reported with its line; an unknown alias is pointed out
    fs.writeFileSync(file, META + `const a = await agent('x', { model: 'cheep' })\nreturn args.items.length`);
    const e = await pisub(h, ['flow', 'run', '--owner', 'S', '--script-file', file, '--cwd', h, '--dry-run']);
    assert.equal(e.code, 1);
    assert.match(e.out, /The script FAILED at line 3: Cannot read properties of undefined/);
    assert.match(e.out, /model "cheep" is not one of your aliases \(cheap\)/);
    assert.match(e.out, /A real run would start 1 agent \(cheep 1\)/);
  });

  it('a dry run stops a script that loops on agent() forever', async () => {
    const h = home();
    const file = path.join(h, 'loop.mjs');
    fs.writeFileSync(file, META + `for (;;) await agent('again')`);
    await pisub(h, ['flow', 'enable', '--session', 'S']);
    const r = await pisub(h, ['flow', 'run', '--owner', 'S', '--script-file', file, '--cwd', h, '--dry-run']);
    assert.equal(r.code, 1);
    assert.match(r.out, /more than 5000 agent\(\) calls in the dry run/);
  });

  it('a required agent that fails ends the workflow and stops the others', async () => {
    const h = home();
    const r = await flow(h, META + `return await parallel([() => agent('[slow 60000] slow'), () => agent('[reject] key step', { required: true })])`);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /required agent #2/);
    const kids = fs.readdirSync(path.join(h, 'runs')).map(id => state(h, id)).filter(s => s.parent);
    assert.deepEqual(kids.map(k => k.status).sort(), ['error', 'stopped']);
  });

  it('a script stuck in an endless loop is killed by stop (P1-06)', async () => {
    const h = home();
    const file = path.join(h, 'loop.mjs');
    fs.writeFileSync(file, META + `while (true) {}`);
    await pisub(h, ['flow', 'enable', '--session', 'S']);
    const started = await pisub(h, ['flow', 'run', '--owner', 'S', '--script-file', file, '--cwd', h, '--json']);
    const id = JSON.parse(started.out).id;
    await until(() => state(h, id).status === 'running');
    const t0 = Date.now();
    const r = await pisub(h, ['stop', id]);
    assert.match(r.out, /did not respond; its process was killed/);
    assert.ok(Date.now() - t0 < 40000);
    assert.equal(state(h, id).status, 'stopped');
  });

  it('meta that would have to run is refused before anything starts (T30)', async () => {
    const h = home();
    const r = await flow(h, `export const meta = { name: String('x'), description: 'd' }\nreturn 1`);
    assert.notEqual(r.code, 0);
    assert.match(r.err + r.out, /not a literal/);
  });
});

describe('worktrees', { concurrency: 2 }, () => {
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const repo = h => {
    const dir = path.join(h, 'repo');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    return dir;
  };

  it('pisub apply brings an isolated agent\'s changes in; clean --branches removes run and branch', async () => {
    const h = home();
    const dir = repo(h);
    const r = await pisub(h, ['spawn', '--worktree', '--cwd', dir, '--json', '[write b.txt made-by-agent] add a file']);
    const id = JSON.parse(r.out).id;
    const w = await pisub(h, ['wait', id, '--timeout', '60']);
    assert.match(w.out, /pisub apply/);
    assert.ok(!fs.existsSync(path.join(dir, 'b.txt')));
    const check = await pisub(h, ['apply', id, '--check']);
    assert.equal(check.code, 0, check.err);
    assert.match(check.out, /applies cleanly/);
    assert.ok(!fs.existsSync(path.join(dir, 'b.txt')));
    const ap = await pisub(h, ['apply', id]);
    assert.equal(ap.code, 0, ap.err);
    assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'made-by-agent');
    const cl = await pisub(h, ['clean', id, '--branches']);
    assert.match(cl.out, /Removed 1 finished run\b/);
    assert.ok(!fs.existsSync(runDir(h, id)));
    assert.equal(git(dir, 'branch', '--list', `pi/${id}`), '');
  });

  it('when git cannot stage the agent\'s files the worktree is kept, not removed as unchanged', async () => {
    const h = home();
    const dir = repo(h);
    const r = await pisub(h, ['spawn', '--worktree', '--cwd', dir, '--json', '[slow 2500] [write b.txt keep-me] add a file']);
    const id = JSON.parse(r.out).id;
    await until(() => state(h, id).status === 'running' && fs.existsSync(state(h, id).worktree.dir));
    const wt = state(h, id).worktree.dir;
    const lock = path.join(path.resolve(wt, git(wt, 'rev-parse', '--git-dir')), 'index.lock');
    fs.writeFileSync(lock, '');
    const w = await pisub(h, ['wait', id, '--timeout', '60']);
    assert.match(w.out, /git add failed/);
    assert.equal(fs.readFileSync(path.join(wt, 'b.txt'), 'utf8'), 'keep-me');
    fs.rmSync(lock);
  });

  it('pisub apply refuses as a whole when your files moved on, and changes nothing', async () => {
    const h = home();
    const dir = repo(h);
    const r = await pisub(h, ['spawn', '--worktree', '--cwd', dir, '--json', '[write a.txt agent-version] edit a']);
    const id = JSON.parse(r.out).id;
    await pisub(h, ['wait', id, '--timeout', '60']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'my own edit\n');
    const ap = await pisub(h, ['apply', id]);
    assert.notEqual(ap.code, 0);
    assert.match(ap.err, /does not apply cleanly/);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'my own edit\n');
  });

  it('clean by age leaves recent and running runs alone', async () => {
    const h = home();
    const done = await start(h, 'x');
    await pisub(h, ['wait', done, '--timeout', '60']);
    const busy = await start(h, '[slow 5000] y');
    await until(() => state(h, busy).status === 'running');
    const dry = await pisub(h, ['clean', '--days', '1', '--dry-run']);
    assert.match(dry.out, /Would remove 0/);
    const all = await pisub(h, ['clean', '--days', '0']);
    assert.match(all.out, /Removed 1 finished run\b/);
    assert.ok(!fs.existsSync(runDir(h, done)));
    assert.ok(fs.existsSync(runDir(h, busy)));
    await pisub(h, ['wait', busy, '--timeout', '60']);
  });
});
