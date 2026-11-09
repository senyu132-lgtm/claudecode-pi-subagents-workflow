#!/usr/bin/env node
// A stand-in for `pi --mode rpc`, for the broker tests (tests/broker.node-test.mjs). pisub runs it through
// PI_CLI. It speaks the same JSON-lines protocol, and misbehaves on request.
//
// Markers in the prompt text pick what a run does:
//   [reject]          the prompt is turned down (success: false)
//   [handled]         the prompt is consumed without a run (disposition "handled")
//   [slow N]          the run calls a tool that takes N ms (an abort ends it early)
//   [overload]        the run ends with an "overloaded" error (the broker backs off and retries)
//   [tools N]         the run makes N quick tool calls
//   [json k=v,k2=v2]  the final answer is the JSON object {"k":"v","k2":"v2"} instead of "answer: ..."
// Every assistant reply carries usage, like pi's: 100 input and 10 output tokens, $0.001.
//   [write F TEXT]    the run writes TEXT into file F of its working directory
//   [empty]           the final answer has no text
//   [silent]          the run starts and then sends nothing
//   [toolhang]        a tool call starts and never ends
//   [garbage]         prints lines that are not JSON, and never finishes
//   [bigline]         prints 65 MB without a line break
//   [exit]            the process dies in the middle of the run
// The answer is "answer: <prompt without markers>", plus "| steers: a,b" for messages steered in while it ran.
// Like pi, `abort` is answered once the run has stopped (right away for runs that never stop: [silent] and co.),
// and a prompt with streamingBehavior while a run is going is queued like a steer instead of turned down.
//
// Environment:
//   FAKE_PI=hang-state      never answers get_state
//   FAKE_PI_ONCE=<file>     the first process (the one that creates <file>) never answers its first prompt
//   FAKE_PI_ARGV=<file>     appends its command line to <file>, one JSON array per start
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (process.env.FAKE_PI_ARGV) fs.appendFileSync(process.env.FAKE_PI_ARGV, JSON.stringify(argv) + '\n');
const modes = new Set((process.env.FAKE_PI || '').split(',').filter(Boolean));
const sessionDir = opt('--session-dir') || process.cwd();
// provider/model as pisub passed them, for the usage on each reply
const MODEL_ARG = opt('--model') || 'fake/fake-model';
const MODEL = MODEL_ARG.includes('/') ? [MODEL_ARG.slice(0, MODEL_ARG.indexOf('/')), MODEL_ARG.slice(MODEL_ARG.indexOf('/') + 1)] : ['', MODEL_ARG];
const USAGE = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0.001 } };
fs.mkdirSync(sessionDir, { recursive: true });
const sessionFile = opt('--session') || path.join(sessionDir, 'fake-session.jsonl');
fs.appendFileSync(sessionFile, '');

const send = rec => process.stdout.write(JSON.stringify(rec) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (req, data) => send({ type: 'response', id: req.id, command: req.type, success: true, ...(data !== undefined ? { data } : {}) });
const fail = (req, error) => send({ type: 'response', id: req.id, command: req.type, success: false, error });

let running = false;
let aborted = false;
let abortable = false; // the current run reacts to an abort (and then settles)
let settleWaiters = []; // abort requests to answer once the run has settled
function settled(rec) {
  running = false;
  abortable = false;
  send(rec);
  for (const f of settleWaiters.splice(0)) f();
}
let steers = [];
let lastText = '';
let hungOnce = false;

async function run(message) {
  running = true;
  aborted = false;
  abortable = false;
  steers = [];
  send({ type: 'agent_start' });
  send({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: message }] } });
  if (message.includes('[exit]')) {
    await sleep(100);
    process.exit(3);
  }
  if (message.includes('[silent]')) return;
  if (message.includes('[toolhang]')) {
    send({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'sleep forever' } });
    return;
  }
  if (message.includes('[garbage]')) {
    for (let i = 0; i < 150; i++) process.stdout.write(`this is not json ${i}\n`);
    return;
  }
  if (message.includes('[bigline]')) {
    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 65; i++) await new Promise(r => process.stdout.write(chunk, r));
    return;
  }
  abortable = true;
  if (message.includes('[overload]')) {
    await sleep(50);
    send({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded_error: Overloaded (test)' } });
    return settled({ type: 'agent_settled' });
  }
  const slow = /\[slow (\d+)\]/.exec(message);
  if (slow) {
    send({ type: 'tool_execution_start', toolName: 'bash', args: { command: `sleep ${slow[1]}` } });
    const t0 = Date.now();
    while (Date.now() - t0 < Number(slow[1]) && !aborted) await sleep(50);
    send({ type: 'tool_execution_end', toolName: 'bash', isError: false, durationMs: Date.now() - t0, result: { content: [{ type: 'text', text: 'slept' }] } });
  }
  const tools = /\[tools (\d+)\]/.exec(message);
  for (let i = 0; tools && i < Number(tools[1]); i++) {
    send({ type: 'tool_execution_start', toolName: 'read', args: { path: `f${i}.txt` } });
    send({ type: 'tool_execution_end', toolName: 'read', isError: false, durationMs: 1, result: { content: [{ type: 'text', text: 'ok' }] } });
  }
  const write = /\[write (\S+) ([^\]]*)\]/.exec(message);
  if (write) fs.writeFileSync(path.join(process.cwd(), write[1]), write[2]);
  if (aborted) {
    send({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } });
    return settled({ type: 'agent_settled', aborted: true });
  }
  const clean = message.replace(/\[[^\]]*\]\s*/g, '').trim();
  const json = /\[json ([^\]]*)\]/.exec(message);
  lastText = message.includes('[empty]')
    ? ''
    : json
      ? JSON.stringify(Object.fromEntries(json[1].split(',').map(kv => kv.split('='))))
      : `answer: ${clean}${steers.length ? ` | steers: ${steers.join(',')}` : ''}`;
  send({ type: 'message_end', message: { role: 'assistant', provider: MODEL[0], model: MODEL[1], content: lastText ? [{ type: 'text', text: lastText }] : [], stopReason: 'stop', usage: USAGE } });
  settled({ type: 'agent_settled' });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  switch (req.type) {
    case 'get_state':
      if (modes.has('hang-state')) return;
      return ok(req, { sessionFile, model: { provider: 'fake', id: 'fake-model' } });
    case 'prompt': {
      const once = process.env.FAKE_PI_ONCE;
      if (once && !hungOnce && !fs.existsSync(once)) {
        hungOnce = true;
        fs.writeFileSync(once, String(process.pid));
        return; // never answered: the broker is killed while waiting
      }
      if (running) {
        if (!req.streamingBehavior) return fail(req, 'already running');
        steers.push(req.message);
        return ok(req, { disposition: 'queued' });
      }
      if (req.message.includes('[reject]')) return fail(req, 'rejected (test)');
      if (req.message.includes('[handled]')) return ok(req, { disposition: 'handled' });
      ok(req, { disposition: 'started' });
      run(req.message);
      return;
    }
    case 'steer':
    case 'follow_up':
      if (!running) return fail(req, 'not running');
      steers.push(req.message);
      return ok(req);
    case 'abort':
      aborted = true;
      if (running && abortable) return void settleWaiters.push(() => ok(req));
      return ok(req);
    case 'clear_queue':
    case 'set_model':
      return ok(req);
    case 'get_last_assistant_text':
      return ok(req, { text: lastText });
    case 'get_session_stats':
      return ok(req, { tokens: { input: 1, output: 1, total: 2 }, cost: 0, sessionFile });
    default:
      return fail(req, `unknown command ${req.type}`);
  }
});
rl.on('close', () => process.exit(0));
