// Tests for the workflow engine: node --test tests/flow.node-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMeta, checkScript, runFlow, extractJSON, validate, agentKey } from '../bin/flow.mjs';
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
  assert.deepEqual(stats, { calls: 2, done: 1, failed: 1, cached: 0 });
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

  // Changing opts (other than label/phase) makes it a new call
  assert.notEqual(agentKey('a', { model: 'strong' }), agentKey('a', { model: 'cheap' }));
  assert.equal(agentKey('a', { model: 'strong', label: 'x' }), agentKey('a', { model: 'strong' }));
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
