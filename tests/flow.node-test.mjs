// Tests for the workflow engine: node --test tests/flow.node-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMeta, checkScript, runFlow, extractJSON, validate, agentKey, parseLiteral } from '../bin/flow.mjs';
import { setLanguage } from '../bin/i18n.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const META = `export const meta = { name: 't', description: 'd', phases: [{ title: 'A' }, 'B'] }\n`;

test('meta: pure literals parse; missing or non-literal meta is rejected', () => {
  const m = extractMeta(META + 'return 1');
  assert.equal(m.name, 't');
  assert.deepEqual(m.phases.map(p => p.title), ['A', 'B']);
  assert.throws(() => extractMeta('return 1'), /export const meta/);
  assert.throws(() => extractMeta(`export const meta = { name: x, description: 'd' }`), /pure literal/);
  assert.throws(() => checkScript(META + 'return (('), /syntax error/);
  // Braces inside strings do not count
  assert.equal(extractMeta(`export const meta = { name: 'a}b', description: '{' }\nreturn 1`).name, 'a}b');
});

test('meta is parsed, never run: anything that would have to execute is refused (T30)', () => {
  assert.throws(() => extractMeta(`export const meta = { name: String('x'), description: 'd' }`), /"String" is not a literal/);
  assert.throws(() => extractMeta('export const meta = { name: `a${1}`, description: "d" }'), /interpolation/);
  assert.throws(() => extractMeta(`export const meta = { name: 'a', description: 'd', ...x }`), /property name/);
  assert.throws(() => extractMeta(`export const meta = { ['name']: 'a', description: 'd' }`), /property name/);
  assert.throws(() => extractMeta(`export const meta = { name: 'a', description: 'd', get x() { return 1 } }`), /":"/);
  assert.throws(() => extractMeta(`export const meta = { name: 'a', description: 'd', n: 1 + 1 }`), /","/);
  assert.throws(() => extractMeta(`export const meta = { name: 'a', description: 'd', n: [1,,2] }`), /empty slots/);
  // What people write in JS object literals still works
  const src = [
    '{',
    '  // comment',
    "  name: 'multi', \"description\": `two",
    "lines`, /* block */ phases: ['A', { title: 'B', detail: \"x\\u0041\" },],",
    '  concurrency: { cheap: 2, default: -1.5e1, hex: 0x10 }, failFast: true, none: null,',
    '} return 2',
  ].join('\n');
  const m = parseLiteral(src);
  assert.deepEqual(m.value, {
    name: 'multi',
    description: 'two\nlines',
    phases: ['A', { title: 'B', detail: 'xA' }],
    concurrency: { cheap: 2, default: -15, hex: 16 },
    failFast: true,
    none: null,
  });
  assert.equal(src.slice(m.end), ' return 2');
  // __proto__ is an ordinary key, not a prototype change
  const o = parseLiteral(`{ __proto__: { polluted: true } }`).value;
  assert.equal(Object.getPrototypeOf(o), Object.prototype);
  assert.deepEqual(Object.keys(o), ['__proto__']);
  assert.equal({}.polluted, undefined);
});

test('top-level return, args, log, phase', async () => {
  const logs = [];
  const phases = [];
  const { value } = await runFlow({
    src: META + `phase('A'); log('start'); console.log('x', {a: 1}); return args.n * 2`,
    args: { n: 21 },
    hooks: { runAgent: async () => 'x', log: t => logs.push(t), phase: p => phases.push(p) },
  });
  assert.equal(value, 42);
  assert.deepEqual(logs, ['start', 'x {"a":1}']);
  assert.deepEqual(phases, ['A']);
});

test('pipeline does not wait: A reaches stage two while B is still in stage one', async () => {
  const events = [];
  const runAgent = async (prompt, opts, info) => {
    events.push(`start ${prompt}`);
    await sleep(prompt === '1-B' ? 120 : 10);
    events.push(`end ${prompt}`);
    return prompt.toUpperCase();
  };
  const { value } = await runFlow({
    src: META + `return await pipeline(['A', 'B'], x => agent('1-' + x), (r, item, i) => agent('2-' + item + i))`,
    hooks: { runAgent },
  });
  assert.deepEqual(value, ['2-A0', '2-B1']);
  assert.ok(events.indexOf('start 2-A0') < events.indexOf('end 1-B'));
});

test('pipeline: a stage that throws or returns null makes that item null and skips later stages', async () => {
  const errors = [];
  const r2 = await runFlow({
    src: META + `const seen = []; const out = await pipeline([1, 2, 3], x => { if (x === 2) throw new Error('bad'); return x === 3 ? null : x }, x => { seen.push(x); return x * 10 }); return { out, seen }`,
    hooks: { runAgent: async () => '', onError: t => errors.push(t) },
  });
  assert.deepEqual(r2.value, { out: [10, null, null], seen: [1] });
  assert.ok(errors.some(t => /item 1 failed/.test(t)));
});

test('parallel waits for all; ones that throw become null and it does not throw itself', async () => {
  const { value } = await runFlow({
    src: META + `return await parallel([() => agent('a'), () => { throw new Error('x') }, () => agent('b')])`,
    hooks: { runAgent: async p => p + '!' },
  });
  assert.deepEqual(value, ['a!', null, 'b!']);
});

test('a failed agent returns null and is counted', async () => {
  const { value, stats } = await runFlow({
    src: META + `const r = await parallel([() => agent('ok'), () => agent('bad')]); return r.filter(Boolean)`,
    hooks: { runAgent: async p => (p === 'bad' ? null : 'fine') },
  });
  assert.deepEqual(value, ['fine']);
  assert.deepEqual(stats, { calls: 2, done: 1, failed: 1, cached: 0, failures: [{ index: 2, label: 'bad' }], unawaited: 0 });
});

test('concurrency limits are per model: at most 2 "cheap" at once, the default model counted separately', async () => {
  const running = { cheap: 0, strong: 0 };
  const peak = { cheap: 0, strong: 0 };
  const runAgent = async (p, opts) => {
    running[opts.model]++;
    peak[opts.model] = Math.max(peak[opts.model], running[opts.model]);
    await sleep(20);
    running[opts.model]--;
    return p;
  };
  await runFlow({
    src: META + `await parallel([1,2,3,4,5].map(i => () => agent('f' + i, { model: 'cheap' })).concat([1,2,3].map(i => () => agent('s' + i))))`,
    defaultModel: 'strong',
    limits: { cheap: 2, default: 3 },
    hooks: { runAgent },
  });
  assert.equal(peak.cheap, 2);
  assert.equal(peak.strong, 3);
});

test('without any default model, agent() passes an empty model on (pisub then uses pi\'s default)', async () => {
  const seen = [];
  await runFlow({
    src: META + `await agent('x')`,
    hooks: { runAgent: async (p, opts, info) => (seen.push([opts.model, info.model]), 'ok') },
  });
  assert.deepEqual(seen, [['', 'default']]);
});

test('resume: unchanged calls come from the cache, changed and new ones run, repeats match by order', async () => {
  const store = new Map();
  const record = (key, n, value) => store.set(`${key}#${n}`, value);
  const cached = (key, n) => (store.has(`${key}#${n}`) ? { value: store.get(`${key}#${n}`) } : null);
  let ran = [];
  const runAgent = async p => {
    ran.push(p);
    return p === 'dup' ? `dup${ran.filter(x => x === 'dup').length}` : p.toUpperCase();
  };
  const src1 = META + `return [await agent('a'), await agent('b', { label: 'old name' }), await agent('dup'), await agent('dup')]`;
  const r1 = await runFlow({ src: src1, hooks: { runAgent, record, cached: () => null } });
  assert.deepEqual(r1.value, ['A', 'B', 'dup1', 'dup2']);

  ran = [];
  const src2 = META + `return [await agent('a'), await agent('b', { label: 'new name', phase: 'x' }), await agent('dup'), await agent('dup'), await agent('c')]`;
  const r2 = await runFlow({ src: src2, hooks: { runAgent, record, cached } });
  assert.deepEqual(r2.value, ['A', 'B', 'dup1', 'dup2', 'C']);
  assert.deepEqual(ran, ['c']);
  assert.equal(r2.stats.cached, 4);

  // Changing opts (other than label/phase/cache/retries/required) makes it a new call
  assert.notEqual(agentKey('a', { model: 'strong' }), agentKey('a', { model: 'cheap' }));
  assert.equal(agentKey('a', { model: 'strong', label: 'x', retries: 2, required: true, cache: false }), agentKey('a', { model: 'strong' }));
  // Keys of calls without inputs stay what 1.0 wrote, so old journals still resume
  assert.equal(agentKey('a', { model: 'strong' }, ''), agentKey('a', { model: 'strong' }));
});

// A fake store shared by the resume tests below
function journal() {
  const store = new Map();
  return {
    record: (key, n, value) => store.set(`${key}#${n}`, value),
    cached: (key, n) => (store.has(`${key}#${n}`) ? { value: store.get(`${key}#${n}`) } : null),
  };
}

test('inputs: the files\' fingerprint is part of the cache key, so changed files re-run on resume', async () => {
  const j = journal();
  const files = { 'data/a.csv': 'v1' };
  const seenPaths = [];
  const fingerprint = (paths, opts) => (seenPaths.push([paths, opts.cwd]), paths.map(p => files[p] ?? 'missing').join('|'));
  let ran = 0;
  const runAgent = async p => (ran++, `report ${ran}`);
  const src = META + `return [await agent('analyze', { inputs: 'data/a.csv', cwd: 'sub' }), await agent('summary')]`;
  await runFlow({ src, hooks: { runAgent, fingerprint, ...j } });
  assert.equal(ran, 2);
  assert.deepEqual(seenPaths[0], [['data/a.csv'], 'sub']);

  // Same files: both come from the cache
  const r2 = await runFlow({ src, hooks: { runAgent, fingerprint, ...j } });
  assert.equal(ran, 2);
  assert.equal(r2.stats.cached, 2);

  // The file changed: the call that names it runs again, the other one is still cached
  files['data/a.csv'] = 'v2';
  const r3 = await runFlow({ src, hooks: { runAgent, fingerprint, ...j } });
  assert.equal(ran, 3);
  assert.deepEqual(r3.value, ['report 3', 'report 2']);

  await assert.rejects(runFlow({ src: META + `await agent('x', { inputs: [''] })`, hooks: { runAgent } }), /inputs must be a path/);
});

test('cache: false always runs the agent, even when resuming', async () => {
  const j = journal();
  let ran = 0;
  const runAgent = async () => `run ${++ran}`;
  const src = META + `return [await agent('check the build', { cache: false }), await agent('static')]`;
  await runFlow({ src, hooks: { runAgent, ...j } });
  const r2 = await runFlow({ src, hooks: { runAgent, ...j } });
  assert.deepEqual(r2.value, ['run 3', 'run 2']);
  assert.equal(r2.stats.cached, 1);
});

test('retries: a failed agent is started again, up to the given number of times', async () => {
  const logs = [];
  const attempts = [];
  let calls = 0;
  const runAgent = async (p, o, info) => (attempts.push(info.attempt), ++calls < 3 ? null : 'third time lucky');
  const { value, stats } = await runFlow({ src: META + `return await agent('flaky', { retries: 2 })`, hooks: { runAgent, log: t => logs.push(t) } });
  assert.equal(value, 'third time lucky');
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.equal(stats.failed, 0);
  assert.equal(logs.filter(t => /retry/.test(t)).length, 2);

  calls = -10;
  const r2 = await runFlow({ src: META + `return await agent('flaky', { retries: 1 })`, hooks: { runAgent } });
  assert.equal(r2.value, null);
  assert.equal(r2.stats.failed, 1);
});

test('required: when that agent fails the whole workflow fails, even inside pipeline, and later calls are refused', async () => {
  const fatal = [];
  const started = [];
  const runAgent = async p => (started.push(p), p === 'key step' ? null : p);
  await assert.rejects(
    runFlow({
      src: META + `const r = await pipeline(['key step', 'other'], x => agent(x, { required: x === 'key step' })); await agent('after'); return r`,
      hooks: { runAgent, onFatal: m => fatal.push(m) },
    }),
    /required agent #1 "key step" failed/
  );
  assert.equal(fatal.length, 1);
  assert.ok(!started.includes('after'));
});

test('failFast (meta.failFast, passed on by pisub): any agent that fails ends the workflow', async () => {
  const body = `await parallel([() => agent('bad'), () => agent('good')]); return 'finished'`;
  const src = `export const meta = { name: 't', description: 'd', failFast: true }\n${body}`;
  assert.equal(extractMeta(src).failFast, true);
  assert.equal(extractMeta(META + body).failFast, false);
  const runAgent = async p => (p === 'bad' ? null : p);
  await assert.rejects(runFlow({ src, failFast: true, hooks: { runAgent } }), /failFast is on/);
  // Without failFast the same body finishes and the failure is only counted
  const r = await runFlow({ src: META + body, hooks: { runAgent } });
  assert.equal(r.value, 'finished');
  assert.equal(r.stats.failed, 1);
});

test('a script that returns without awaiting its agents still waits for them (T05)', async () => {
  const done = [];
  const logs = [];
  let finishedAt = 0;
  const r = await runFlow({
    src: META + `agent('slow'); sh('echo x'); return 42`,
    hooks: {
      runAgent: async p => (await sleep(80), done.push(p), (finishedAt = Date.now()), 'ok'),
      runSh: async () => (await sleep(30), done.push('sh'), { code: 0, stdout: '', stderr: '' }),
      log: t => logs.push(t),
    },
  });
  assert.equal(r.value, 42);
  assert.ok(Date.now() >= finishedAt && finishedAt > 0);
  assert.deepEqual(done.sort(), ['sh', 'slow']);
  assert.equal(r.stats.unawaited, 2);
  assert.equal(r.stats.done, 1);
  assert.ok(logs.some(t => /missing await/.test(t)));
});

test('a script that throws while agents run stops them and waits before failing (T25)', async () => {
  let stopped = false;
  const fatal = [];
  const settled = [];
  const runAgent = async p => {
    // A long agent that ends early once the workflow is stopped, like a pi agent given a stop message
    for (let i = 0; i < 100 && !stopped; i++) await sleep(10);
    settled.push(p);
    return stopped ? null : 'ok';
  };
  await assert.rejects(
    runFlow({
      src: META + `agent('long one'); agent('long two'); await new Promise(r => setTimeout(r, 20)); throw new Error('script bug')`,
      hooks: { runAgent, onFatal: m => ((stopped = true), fatal.push(m)) },
    }),
    /script bug/
  );
  assert.equal(fatal.length, 1);
  assert.match(fatal[0], /2 running agent\(\)\/sh\(\) calls were stopped: script bug/);
  assert.deepEqual(settled.sort(), ['long one', 'long two']);
});

test('sh(cmd, { cache: true }) is not run again on resume once it succeeded (P2-04)', async () => {
  const j = journal();
  let runs = 0;
  let code = 1;
  const runSh = async () => (runs++, { code, stdout: `out ${runs}`, stderr: '' });
  const src = META + `return [(await sh('make data', { cache: true })).stdout, (await sh('date')).stdout]`;
  // It failed the first time: nothing is recorded, so the resumed run tries again
  await runFlow({ src, hooks: { runAgent: async () => '', runSh, ...j } });
  assert.equal(runs, 2);
  code = 0;
  const r2 = await runFlow({ src, hooks: { runAgent: async () => '', runSh, ...j } });
  assert.deepEqual(r2.value, ['out 3', 'out 4']);
  // It succeeded: the next resume takes it from the journal; the call without cache: true runs again
  const logs = [];
  const r3 = await runFlow({ src, hooks: { runAgent: async () => '', runSh, log: t => logs.push(t), ...j } });
  assert.deepEqual(r3.value, ['out 3', 'out 5']);
  assert.equal(runs, 5);
  assert.ok(logs.some(t => /from cache/.test(t)));
});

test('a cached result made with another model is not reused (the alias points elsewhere now)', async () => {
  const store = new Map();
  const record = (key, n, value, info) => store.set(`${key}#${n}`, { value, modelKey: info.modelKey });
  const cached = (key, n) => store.get(`${key}#${n}`) ?? null;
  let points = 'prov/model-a';
  let ran = 0;
  const hooks = () => ({ runAgent: async () => `r${++ran}`, record, cached, modelKey: () => points });
  const src = META + `return await agent('x', { model: 'cheap' })`;
  await runFlow({ src, hooks: hooks() });
  assert.equal((await runFlow({ src, hooks: hooks() })).value, 'r1');
  points = 'prov/model-b';
  assert.equal((await runFlow({ src, hooks: hooks() })).value, 'r2');
  // Journals written before the model was recorded still resume
  const old = journal();
  await runFlow({ src, hooks: { runAgent: async () => 'old', ...old } });
  assert.equal((await runFlow({ src, hooks: { runAgent: async () => 'new', ...old, modelKey: () => 'anything' } })).value, 'old');
});

test('a schema with keywords the validator does not check is refused up front', async () => {
  const runAgent = async () => '{}';
  await assert.rejects(runFlow({ src: META + `await agent('x', { schema: { type: 'object', unevaluatedProperties: false } })`, hooks: { runAgent } }), /unsupported keyword unevaluatedProperties/);
  await assert.rejects(runFlow({ src: META + `await agent('x', { schema: 'object' })`, hooks: { runAgent } }), /schema is not usable/);
  const ok = await runFlow({ src: META + `return await agent('x', { schema: { type: 'object', properties: { n: { type: 'integer' } } } })`, hooks: { runAgent } });
  assert.equal(ok.value, '{}');
});

test('agent() throws once the workflow is stopped', async () => {
  let stopped = false;
  const { value } = await runFlow({
    src: META + `const a = await agent('a'); const rest = await parallel([() => agent('b')]); return [a, rest]`,
    hooks: {
      runAgent: async p => {
        stopped = true;
        return p;
      },
      isAborted: () => stopped,
    },
  });
  assert.deepEqual(value, ['a', [null]]);
});

test('sh is handed to runSh', async () => {
  const seen = [];
  const { value } = await runFlow({
    src: META + `const r = await sh('echo hi', { cwd: 'x' }); const r2 = await sh(['python', '-c', 'print(1)']); return [r.code, r2.stdout]`,
    hooks: {
      runAgent: async () => '',
      runSh: async (cmd, opts) => {
        seen.push([cmd, opts]);
        return { code: 0, stdout: Array.isArray(cmd) ? '1\n' : 'hi\n', stderr: '' };
      },
    },
  });
  assert.deepEqual(value, [0, '1\n']);
  assert.deepEqual(seen[0], ['echo hi', { cwd: 'x' }]);
});

test('extractJSON and validate', () => {
  assert.deepEqual(extractJSON('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJSON('Here you go:\n```json\n{"a":2}\n```\n').value, { a: 2 });
  assert.deepEqual(extractJSON('note {"a":3} end').value, { a: 3 });
  assert.equal(extractJSON('nothing').ok, false);
  const s = {
    type: 'object',
    properties: { ok: { type: 'boolean' }, items: { type: 'array', items: { type: 'integer' } }, kind: { enum: ['x', 'y'] } },
    required: ['ok'],
    additionalProperties: false,
  };
  assert.equal(validate(s, { ok: true, items: [1, 2], kind: 'x' }), null);
  assert.match(validate(s, {}), /missing field ok/);
  assert.match(validate(s, { ok: 1 }), /\$\.ok should be boolean/);
  assert.match(validate(s, { ok: true, items: [1, 1.5] }), /\$\.items\[1\]/);
  assert.match(validate(s, { ok: true, z: 1 }), /must not have field z/);
  assert.match(validate(s, { ok: true, kind: 'q' }), /one of/);
});

test('messages follow the language setting', () => {
  try {
    setLanguage('zh');
    assert.match(validate({ required: ['ok'] }, {}), /缺少字段 ok/);
    assert.throws(() => extractMeta('return 1'), /脚本必须以/);
  } finally {
    setLanguage('en');
  }
});
