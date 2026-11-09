// Workflows: `pisub flow`, the dry run, and the background process that runs a workflow script (FlowRun).
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { HOME, appendPrivate, die, killTree, loadConfig, mkdirp, now, out, parseArgs, readJSON, readLines, readStdin, trunc, writeJSON, writePrivate } from './core.mjs';
import { L } from '../i18n.mjs';
import { acquireLock, checkId, createRun, enqueue, inboxDir, inboxFiles, isServing, launchServe, newRunDir, readState, releaseLock, runDir, saveState, statePath, statusName, stopChildren, waitAndPrint, waitFor } from './runs.mjs';
import { checkScript, extractJSON, runFlow, validate } from '../flow.mjs';
import { gitOut, gitSignature, hashInputs } from './git.mjs';
import { sample } from '../schema.mjs';
import { ensureServing, fmtTokens, readUsage, resolveModel } from './models.mjs';

// ---------- workflows ----------
// Per-session switch: the mod writes a marker when the user types /pi flow in that Claude session
export const FLOW_GATE = path.join(HOME, 'flow-enabled');
export const gateFile = sid => path.join(FLOW_GATE, String(sid).replace(/[^\w.-]/g, '_'));
export const flowEnabled = sid => !!sid && fs.existsSync(gateFile(sid));

// Appended to every workflow agent's prompt
export function flowFooter(schema) {
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
export let bashPath = null;
export function findBash() {
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

export async function cmdFlow(argv) {
  const [sub, ...a] = argv;
  if (sub === 'enable' || sub === 'disable') {
    const o = parseArgs(a, []);
    if (!o.session) die(L('--session <session-id> is required', '需要 --session <会话id>'));
    mkdirp(FLOW_GATE);
    if (sub === 'enable') fs.writeFileSync(gateFile(o.session), String(now()));
    else try { fs.unlinkSync(gateFile(o.session)); } catch {}
    return out(sub === 'enable' ? L('Workflows enabled', '工作流已开启') : L('Workflows disabled', '工作流已关闭'));
  }
  if (sub === 'run') return cmdFlowRun(a);
  die(L('usage: pisub flow run ... | pisub flow enable|disable --session <session-id> (see help)', '用法：pisub flow run ... | pisub flow enable|disable --session <会话id>（help 看详情）'));
}

export async function cmdFlowRun(argv) {
  const o = parseArgs(argv, ['json', 'wait', 'stdin-json', 'dry-run']);
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
  if (o['dry-run'] || spec.dryRun === true) {
    const r = await flowDryRun({ src, args, cwd, meta, resume, cfg: loadConfig() });
    out(r.text);
    process.exit(r.ok ? 0 : 1);
  }
  const id = newRunDir(`wf-${meta.name}`);
  writePrivate(path.join(runDir(id), 'script.mjs'), src);
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

// ---------- workflow dry run ----------
// Runs the script in this process with fake agents: no model is called and no run folder is made. agent()
// returns sample data built from its schema (or a placeholder text); sh() runs only when marked readonly: true,
// the others return exit code 0 and no output. Reports script errors, the agents a real run would start (per
// model and phase, and how many the resume cache covers), problems found on the way, and the return value.
export const DRY_RUN_LIMIT_MS = 60000;
export async function flowDryRun({ src, args, cwd, meta, resume, cfg }) {
  const t0 = now();
  const calls = [];
  const shRuns = [];
  const problems = [];
  const logs = [];
  const seenProblem = new Set();
  const problem = (key, text) => {
    if (seenProblem.has(key)) return;
    seenProblem.add(key);
    problems.push(text);
  };
  const prev = new Map();
  if (resume) for (const e of readLines(path.join(runDir(resume), 'journal.jsonl'))) prev.set(`${e.key}#${e.n}`, { value: e.value, modelKey: e.mk });
  const gitRoots = new Map();
  const timedOut = () => now() - t0 > DRY_RUN_LIMIT_MS;
  // A macrotask per call: a script that loops on agent() still lets the time limit fire
  const tick = () => new Promise(r => setImmediate(r));
  let value;
  let error = null;
  try {
    ({ value } = await runFlow({
      src,
      args,
      defaultModel: cfg.defaultAlias || '',
      failFast: meta.failFast,
      dryRun: true,
      hooks: {
        runAgent: async (prompt, o, info) => {
          await tick();
          const c = { index: info.index, phase: info.phase, label: info.label, model: info.model, readonly: !!o.readonly, isolation: o.isolation || '', schema: !!(o.schema && typeof o.schema === 'object'), cwd: o.cwd ? path.resolve(cwd, o.cwd) : cwd };
          calls.push(c);
          const spec = String(o.model || '');
          if (spec && !cfg.aliases[spec] && !spec.includes('/'))
            problem(`model:${spec}`, L(`model "${spec}" is not one of your aliases (${Object.keys(cfg.aliases).join(', ') || 'none configured'}); pi would treat it as a model name pattern`, `模型「${spec}」不是配置里的别名（${Object.keys(cfg.aliases).join('、') || '没有配置别名'}），pi 会把它当作模型名去模糊匹配`));
          if (!fs.existsSync(c.cwd)) problem(`cwd:${c.cwd}`, L(`agent #${info.index} "${info.label}": its cwd does not exist: ${c.cwd}`, `代理 #${info.index}「${info.label}」：工作目录不存在：${c.cwd}`));
          if (c.isolation && c.isolation !== 'worktree') problem(`iso:${c.isolation}`, L(`unknown isolation "${c.isolation}" (only "worktree")`, `不认识的 isolation「${c.isolation}」（只支持 "worktree"）`));
          if (c.isolation === 'worktree' && !c.readonly) {
            if (!gitRoots.has(c.cwd)) gitRoots.set(c.cwd, gitOut(c.cwd, ['rev-parse', '--show-toplevel']));
            if (!gitRoots.get(c.cwd)) problem(`wt:${c.cwd}`, L(`isolation "worktree" needs a git repository, and ${c.cwd} is not in one: these agents would fail`, `isolation "worktree" 需要 git 仓库，${c.cwd} 不在仓库里：这些代理会失败`));
          }
          if (!c.schema) return L(`[dry run] answer of agent #${info.index} "${info.label}"`, `【试运行】代理 #${info.index}「${info.label}」的回答`);
          const v = sample(o.schema);
          const bad = validate(o.schema, v);
          if (bad) {
            c.failed = true;
            problem(`schema:${info.label}`, L(`agent #${info.index} "${info.label}": no sample data could be made for its schema (${bad}); it counts as failed (null) here`, `代理 #${info.index}「${info.label}」：没能按它的 schema 造出样例数据（${bad}），这里按失败（null）处理`));
            return null;
          }
          return v;
        },
        runSh: async (cmd, o) => {
          const shown = Array.isArray(cmd) ? cmd.join(' ') : cmd;
          if (o.readonly !== true) {
            await tick();
            shRuns.push({ shown, ran: false });
            return { code: 0, stdout: '', stderr: '' };
          }
          const r = await execSh(cmd, { ...o, timeoutSec: Math.min(Number(o.timeoutSec) || 600, 60) }, { cwd, flowId: 'dry-run', stopped: timedOut });
          shRuns.push({ shown, ran: true, code: r.code, err: r.stderr });
          return r;
        },
        fingerprint: (paths, o) => hashInputs(paths, o.cwd ? path.resolve(cwd, o.cwd) : cwd),
        log: text => logs.push(text),
        onError: text => problems.push(text),
        onFatal: msg => problem(`fatal:${msg}`, msg),
        onCached: info => calls.push({ index: info.index, phase: info.phase, label: info.label, model: info.model, cached: true }),
        isAborted: timedOut,
        cached: (key, n) => prev.get(`${key}#${n}`) ?? null,
        record: () => {},
        modelKey: m => {
          const r = resolveModel(m, cfg);
          return r.model ? `${r.model}${r.thinking ? '@' + r.thinking : ''}` : 'pi-default';
        },
      },
    }));
  } catch (e) {
    error = e;
  }

  const lines = [];
  lines.push(
    L(
      `Dry run of workflow "${meta.name}": no model was called. agent() returned made-up sample data (from its schema, or a placeholder text), so branches that depend on what agents answer may go another way in a real run.`,
      `试运行工作流「${meta.name}」：没有调用任何模型。agent() 返回的是造出来的样例数据（按 schema 造，或者一段占位文字），依赖回答内容的分支，真跑时可能走另一条路。`
    )
  );
  if (error) {
    const msg = timedOut() ? L(`the dry run took longer than ${DRY_RUN_LIMIT_MS / 1000}s (a loop that never ends, or a slow readonly sh()?)`, `试运行超过 ${DRY_RUN_LIMIT_MS / 1000} 秒（停不下来的循环，或者很慢的只读 sh()？）`) : error.message || String(error);
    const at = /workflow\.js:(\d+)/.exec(String(error.stack || ''));
    lines.push(at ? L(`✗ The script FAILED at line ${at[1]}: ${msg}`, `✗ 脚本出错（第 ${at[1]} 行）：${msg}`) : L(`✗ The script FAILED: ${msg}`, `✗ 脚本出错：${msg}`));
  } else lines.push(L(`✓ The script ran to the end (${fmtDuration(now() - t0)}).`, `✓ 脚本跑通了（用时 ${fmtDuration(now() - t0)}）。`));

  const real = calls.filter(c => !c.cached);
  const cached = calls.length - real.length;
  const tally = list => {
    const m = new Map();
    for (const c of list) m.set(c.model, (m.get(c.model) || 0) + 1);
    return [...m].map(([k, n]) => `${k} ${n}`).join(L(', ', '，'));
  };
  lines.push(
    real.length
      ? L(`A real run would start ${real.length} ${real.length === 1 ? 'agent' : 'agents'} (${tally(real)})${cached ? `; ${cached} more would come from the resume cache` : ''}.`, `真跑会启动 ${real.length} 个代理（${tally(real)}）${cached ? `，另有 ${cached} 个用续跑缓存` : ''}。`)
      : cached
        ? L(`Every agent() call (${cached}) would come from the resume cache; no agent would start.`, `全部 ${cached} 个 agent() 调用都会用续跑缓存，不会启动代理。`)
        : L('No agent() was called.', '没有调用 agent()。')
  );
  const phaseNames = [...new Set(calls.map(c => c.phase))];
  if (real.length && phaseNames.length > 1)
    for (const p of phaseNames) {
      const r = real.filter(c => c.phase === p);
      if (r.length) lines.push(`  ${p ? L(`phase "${p}"`, `阶段「${p}」`) : L('(no phase)', '（没有阶段）')}: ${tally(r)}`);
    }
  if (real.length) {
    const n = f => real.filter(f).length;
    const flags = [
      n(c => c.schema) && L(`${n(c => c.schema)} with schema`, `带 schema ${n(c => c.schema)} 个`),
      n(c => c.readonly) && L(`${n(c => c.readonly)} read-only`, `只读 ${n(c => c.readonly)} 个`),
      n(c => c.isolation === 'worktree') && L(`${n(c => c.isolation === 'worktree')} in worktrees`, `worktree ${n(c => c.isolation === 'worktree')} 个`),
    ].filter(Boolean);
    if (flags.length) lines.push('  ' + flags.join(L(', ', '，')));
    const mc = meta.concurrency;
    const lim = m => (typeof mc === 'number' ? mc : (mc && typeof mc === 'object' && mc[m]) ?? cfg.flowConcurrency[m] ?? cfg.flowConcurrency.default ?? 4);
    const models = [...new Set(real.map(c => c.model))];
    lines.push(
      L(`  At once: ${models.map(m => `${m} ${lim(m)}${cfg.flowStaggerMs?.[m] ? ` (one start per ${cfg.flowStaggerMs[m] / 1000}s)` : ''}`).join(', ')}${cfg.maxAgents ? `; at most ${cfg.maxAgents} on this machine` : ''}.`, `  同时跑：${models.map(m => `${m} ${lim(m)} 个${cfg.flowStaggerMs?.[m] ? `（每 ${cfg.flowStaggerMs[m] / 1000} 秒启动一个）` : ''}`).join('，')}${cfg.maxAgents ? `；整台机器最多 ${cfg.maxAgents} 个` : ''}。`)
    );
    // Agents that may edit the same folder: fine one after another, a problem at the same time
    const writers = new Map();
    for (const c of real) if (!c.readonly && c.isolation !== 'worktree') writers.set(c.cwd, (writers.get(c.cwd) || 0) + 1);
    for (const [dir, k] of writers)
      if (k > 1 && Math.min(...models.map(lim)) > 1)
        problem(`writers:${dir}`, L(`${k} agents that can edit files work in ${dir}; if they run at the same time they may overwrite each other's changes (give them isolation: 'worktree', or readonly: true if they only read)`, `有 ${k} 个能改文件的代理在 ${dir} 里工作；如果同时跑，可能互相覆盖改动（会写文件的加 isolation: 'worktree'，只读的加 readonly: true）`));
  }
  if (shRuns.length) {
    const ran = shRuns.filter(s => s.ran);
    const skipped = shRuns.filter(s => !s.ran);
    lines.push(
      L(
        `sh(): ${ran.length} readonly ${ran.length === 1 ? 'command' : 'commands'} run, ${skipped.length} skipped (they returned exit code 0 and no output; mark a command that only reads with readonly: true and the dry run runs it).`,
        `sh()：执行了 ${ran.length} 个只读命令，跳过 ${skipped.length} 个（跳过的返回退出码 0、没有输出；只读的命令加 readonly: true，试运行就会真的执行）。`
      )
    );
    for (const s of ran.filter(s => s.code !== 0).slice(0, 5)) lines.push(`  ${L('exit code', '退出码')} ${s.code}: ${trunc(s.shown, 120)}${s.err?.trim() ? ` (${trunc(s.err.trim(), 200)})` : ''}`);
    for (const s of skipped.slice(0, 3)) lines.push(`  ${L('skipped', '跳过')}: ${trunc(s.shown, 120)}`);
    if (skipped.length > 3) lines.push(L(`  … and ${skipped.length - 3} more skipped`, `  … 还跳过了 ${skipped.length - 3} 个`));
  }
  if (problems.length) {
    lines.push(L('To look at:', '要注意的：'));
    for (const p of problems.slice(0, 15)) lines.push(`  - ${trunc(p, 400)}`);
    if (problems.length > 15) lines.push(L(`  … and ${problems.length - 15} more`, `  … 还有 ${problems.length - 15} 条`));
  }
  if (logs.length) {
    lines.push(L(`The script's log (last ${Math.min(logs.length, 8)} of ${logs.length}):`, `脚本的 log（共 ${logs.length} 条，最后 ${Math.min(logs.length, 8)} 条）：`));
    for (const t of logs.slice(-8)) lines.push(`  ${trunc(t, 300)}`);
  }
  if (!error) lines.push(L('Return value (computed from the sample data):', '返回值（用样例数据算出来的）：'), trunc(fmtValue(value), 4000));
  return { ok: !error, text: lines.join('\n') };
}

export async function cmdFlowServe(argv) {
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

export const fmtValue = v =>
  v === undefined ? L('(the script returned nothing)', '（脚本没有返回值）') : typeof v === 'string' ? v : '```json\n' + JSON.stringify(v, null, 2) + '\n```';
export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return L(`${s}s`, `${s} 秒`);
  if (s < 3600) return L(`${Math.floor(s / 60)}m ${s % 60}s`, `${Math.floor(s / 60)} 分 ${s % 60} 秒`);
  return L(`${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`, `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`);
}

// Runs one sh() command of a workflow: {code, stdout, stderr}. ctx: cwd (the workflow's), flowId,
// onDone(shown, code), stopped() (true once the workflow is stopping: the command is killed)
export function execSh(cmd, opts, ctx) {
  const shown = Array.isArray(cmd) ? cmd.join(' ') : cmd;
  const cwd = opts.cwd ? path.resolve(ctx.cwd, opts.cwd) : ctx.cwd;
  const [file, argv] = Array.isArray(cmd) ? [cmd[0], cmd.slice(1)] : [findBash(), ['-c', cmd]];
  const limitSec = Number(opts.timeoutSec) || 600;
  return new Promise(resolve => {
    const outB = [];
    const errB = [];
    let size = 0;
    let note = '';
    let finished = false;
    // Declared before spawning, so a failed spawn can call finish() without touching uninitialized timers
    let timer = null;
    let watch = null;
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(watch);
      const res = { code, stdout: Buffer.concat(outB).toString('utf8'), stderr: Buffer.concat(errB).toString('utf8') + note };
      ctx.onDone?.(shown, code);
      resolve(res);
    };
    let child;
    try {
      child = spawn(file, argv, {
        cwd,
        windowsHide: true,
        detached: process.platform !== 'win32', // its own process group, so killTree reaches its children
        env: { ...process.env, PISUB_FLOW_ID: ctx.flowId, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
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
    timer = setTimeout(() => {
      note += L(`\n(killed after ${limitSec}s)`, `\n（超过 ${limitSec} 秒，已终止）`);
      killTree(child.pid);
    }, limitSec * 1000);
    watch = setInterval(() => {
      if (ctx.stopped?.()) {
        note += L('\n(killed: the workflow was stopped)', '\n（工作流已停止，已终止）');
        killTree(child.pid);
      }
    }, 1000);
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input != null ? String(opts.input) : undefined);
  });
}

export class FlowRun {
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
    if (this.st.resumeFrom)
      for (const e of readLines(path.join(runDir(this.st.resumeFrom), 'journal.jsonl'))) this.prev.set(`${e.key}#${e.n}`, { value: e.value, modelKey: e.mk });
    // How the repository looked when the run being resumed ended, to warn about stale cached results
    this.prevGit = this.st.resumeFrom ? readState(this.st.resumeFrom)?.gitEnd || null : null;
    this.warnings = []; // about cached results being stale: shown when something came from the cache
    this.notes = []; // always shown in the summary
    this.fatalMsg = '';
    this.writers = new Map(); // working directory -> agents writing there right now (not readonly, not isolated)
    this.sharedWarned = false;
    this.values = new Map(); // agent index -> the value agent() returned (not from the cache), for the hints below
  }
  view(e) {
    appendPrivate(path.join(this.dir, 'view.jsonl'), JSON.stringify({ t: now(), ...e }) + '\n');
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
    this.st = saveState(this.id, { children: this.children, progress: this.progress(), currentPhase: this.phase, failed: this.counts().failed, ...patch });
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

  // Agents that write into the same folder at the same time can overwrite each other's edits: say so once
  async runAgent(prompt, opts, info) {
    const cwd = opts.cwd ? path.resolve(this.st.cwd, opts.cwd) : this.st.cwd;
    const writes = !opts.readonly && opts.isolation !== 'worktree';
    if (writes) {
      const n = this.writers.get(cwd) || 0;
      if (n > 0 && !this.sharedWarned) {
        this.sharedWarned = true;
        const w = L(
          `Several agents that can edit files are working in ${cwd} at the same time, so they may overwrite each other's changes. Give writing agents isolation: 'worktree', or readonly: true when they only read.`,
          `有多个能改文件的代理同时在 ${cwd} 里工作，可能互相覆盖改动。会写文件的代理请加 isolation: 'worktree'，只读的加 readonly: true。`
        );
        this.notes.push(w);
        this.view({ k: 'error', text: w });
      }
      this.writers.set(cwd, n + 1);
    }
    try {
      return await this.runOneAgent(prompt, opts, info);
    } finally {
      if (writes) this.writers.set(cwd, this.writers.get(cwd) - 1);
    }
  }
  async runOneAgent(prompt, opts, info) {
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
        isolation: opts.isolation,
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
    this.child(info, { id: r.id, status: 'running', note: '', branch: undefined, review: undefined, ...(info.attempt ? { attempt: info.attempt } : {}) });
    ev('start', { id: r.id });
    // An agent in a worktree that changed files: its branch, for the panel and the summary
    const branchOf = () => {
      const w = readState(r.id)?.worktree;
      if (!w?.report?.changed) return {};
      return { branch: w.branch, note: `${w.branch}${w.report.stat ? ' · ' + w.report.stat : ''}`, review: `git -C "${w.root}" diff ${w.base.slice(0, 12)} ${w.branch}` };
    };
    let before = 0;
    for (let attempt = 0; ; attempt++) {
      const st = await waitFor(r.id, before, 0);
      if (this.aborted || st.status !== 'done') {
        const note = this.aborted
          ? L('workflow stopped', '工作流已停止')
          : this.fatalMsg && st.status === 'stopped'
            ? L('stopped because the workflow failed', '工作流失败，已停止')
            : trunc(st.lastError || statusName(st.status), 300);
        const b = branchOf();
        this.child(info, { status: 'error', ...b, note: b.note ? `${note} (${b.note})` : note });
        ev('error', { id: r.id, text: note });
        return null;
      }
      let text = '';
      try { text = fs.readFileSync(path.join(runDir(r.id), 'final.md'), 'utf8'); } catch {}
      // No answer at all is not a result (answerChars: length of pi's own answer, without notes added to it)
      if (st.answerChars === 0 || (st.answerChars === undefined && !text.trim())) {
        const note = L('it finished without writing a final answer', '它结束了，但没有写最终回答');
        const b = branchOf();
        this.child(info, { status: 'error', ...b, note: b.note ? `${note} (${b.note})` : note });
        ev('error', { id: r.id, text: note });
        return null;
      }
      if (!schema) {
        this.child(info, { status: 'done', ...branchOf() });
        ev('done', { id: r.id });
        return text;
      }
      const parsed = extractJSON(text);
      const err = parsed.ok ? validate(schema, parsed.value) : parsed.error;
      if (!err) {
        this.child(info, { status: 'done', ...branchOf() });
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
    return execSh(cmd, opts, {
      cwd: this.st.cwd,
      flowId: this.id,
      onDone: (shown, code) => this.view({ k: 'sh', text: shown, code }),
      stopped: () => this.aborted || !!this.fatalMsg,
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
    if (this.prevGit) {
      const cur = gitSignature(this.st.cwd);
      if (cur && (cur.head !== this.prevGit.head || cur.sig !== this.prevGit.sig)) {
        const what = cur.head !== this.prevGit.head ? `HEAD ${(this.prevGit.head || '-').slice(0, 7)} → ${cur.head.slice(0, 7)}` : L('uncommitted changes differ', '未提交的改动不一样了');
        const w = L(
          `The repository changed after ${this.st.resumeFrom} finished (${what}). Cached agent() results were made from the old files and may be out of date. Calls that list their files in inputs re-run by themselves; for the others use cache: false, or start the workflow fresh instead of resuming.`,
          `仓库在 ${this.st.resumeFrom} 结束后有变动（${what}）。缓存的 agent() 结果是按旧文件做的，可能已经过时。写了 inputs 的调用会自己重跑；其余的请加 cache: false，或者不要续跑、重新开始。`
        );
        this.warnings.push(w);
        this.view({ k: 'error', text: w });
      }
    }
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
        failFast: meta.failFast,
        hooks: {
          runAgent: (p, o, info) => this.runAgent(p, o, info),
          fingerprint: (paths, o) => hashInputs(paths, o.cwd ? path.resolve(this.st.cwd, o.cwd) : this.st.cwd),
          onFatal: msg => {
            this.fatalMsg = msg;
            this.view({ k: 'error', text: msg });
            this.save();
            stopChildren(this.id);
          },
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
          cached: (key, n) => this.prev.get(`${key}#${n}`) ?? null,
          record: (key, n, value, info) => {
            if (info.index > 0 && !info.cached) this.values.set(info.index, value);
            return appendPrivate(this.journal, JSON.stringify({ key, n, value, index: info.index, label: info.label, cached: !!info.cached, mk: info.modelKey }) + '\n');
          },
          // What an alias stands for now (provider pools rotate, so the provider is left out)
          modelKey: m => {
            const r = resolveModel(m, this.cfg);
            return r.model ? `${r.model}${r.thinking ? '@' + r.thinking : ''}` : 'pi-default';
          },
        },
      });
    } catch (e) {
      error = e;
    }
    clearInterval(inboxTimer);
    this.pollInbox();
    // Nothing of this workflow may keep running after it ended with an error
    if (error) stopChildren(this.id);
    const unawaited = result?.stats?.unawaited || 0;
    if (unawaited)
      this.notes.push(
        L(
          `The script returned before ${unawaited} agent()/sh() calls had finished (a missing await?). The workflow waited for them, but the script's return value does not contain their results.`,
          `脚本在 ${unawaited} 个 agent()/sh() 调用结束前就返回了（漏了 await？）。工作流等它们结束了，但脚本的返回值里没有它们的结果。`
        )
      );
    const k = this.counts();
    const shCached = result?.stats?.shCached || 0;
    const took = fmtDuration(now() - this.t0);
    const summary = L(
      `(Workflow "${this.st.name}": ${this.children.length} agent() calls, ${k.done} done, ${k.failed} failed, ${k.cached} from cache${shCached ? `, sh() from cache ${shCached}` : ''}; took ${took})`,
      `（工作流「${this.st.name}」：agent() 调用 ${this.children.length} 次，完成 ${k.done}，失败 ${k.failed}，缓存命中 ${k.cached}${shCached ? `，sh() 用缓存 ${shCached} 次` : ''}；用时 ${took}）`
    );
    const head = [summary];
    const usage = this.usage();
    if (usage.total)
      head.push(
        L(
          `Usage: ${fmtTokens(usage.total)} tokens${usage.by.length > 1 ? ` (${usage.by.map(([a, n]) => `${a} ${fmtTokens(n)}`).join(' · ')})` : ''}`,
          `用量：${fmtTokens(usage.total)} tokens${usage.by.length > 1 ? `（${usage.by.map(([a, n]) => `${a} ${fmtTokens(n)}`).join(' · ')}）` : ''}`
        )
      );
    const suspects = this.suspects();
    if (suspects.length) {
      head.push(L('Worth a second look (compared with the other agents of the same phase and model; hints only):', '值得抽查的（和同阶段、同模型的其他代理比出来的，只是提示）：'));
      head.push(...suspects.slice(0, 12));
      if (suspects.length > 12) head.push(L(`  … and ${suspects.length - 12} more`, `  … 还有 ${suspects.length - 12} 条`));
    }
    const failed = this.children.filter(c => c.status === 'error');
    if (failed.length) {
      head.push(L(`Failed agents (${failed.length}):`, `失败的代理（${failed.length} 个）：`));
      for (const c of failed.slice(0, 20)) head.push(`  ✗ #${c.index} ${c.label} (${c.model}): ${trunc(c.note || '', 200)}${c.id ? `  [${c.id}]` : ''}`);
      if (failed.length > 20) head.push('  …');
    }
    const changed = this.children.filter(c => c.branch);
    if (changed.length) {
      head.push(L(`Agents that changed files, each on its own branch (review with the command shown; apply one to your working tree with pisub apply <agent id>):`, `改了文件的代理，各在自己的分支上（用下面的命令查看；要应用到你的工作区，用 pisub apply <代理编号>）：`));
      for (const c of changed) head.push(`  #${c.index} ${c.label}: ${c.note}  [${c.id}]\n      ${c.review}`);
    }
    if (k.cached || shCached) for (const w of this.warnings) head.push(L('Warning: ', '注意：') + w);
    for (const w of this.notes) head.push(L('Warning: ', '注意：') + w);
    let status;
    let body;
    if (this.aborted) {
      status = 'stopped';
      body = L('The workflow was stopped.', '工作流被停止。') + (result ? L(`\n\nThe script's return value before stopping:\n`, `\n\n停止前脚本的返回值：\n`) + fmtValue(result.value) : '');
    } else if (error) {
      status = 'error';
      body = error.fatal ? L('The workflow failed: ', '工作流失败：') + error.message : L('The workflow script failed:\n', '工作流脚本出错：\n') + String(error?.stack || error);
    } else {
      status = 'done';
      body = fmtValue(result.value);
      writeJSON(path.join(this.dir, 'result.json'), { value: result.value ?? null });
    }
    writePrivate(path.join(this.dir, 'final.md'), `${head.join('\n')}\n\n${body}\n`);
    this.view({ k: 'done', round: (this.st.rounds || 0) + 1, status });
    this.save({
      status,
      rounds: (this.st.rounds || 0) + 1,
      finishedAt: now(),
      lastError: error ? trunc(error.fatal ? error.message : String(error?.stack || error), 2000) : '',
      finalPreview: trunc(body, 300),
      gitEnd: gitSignature(this.st.cwd) || undefined,
      usage: usage.total ? { total: usage.total } : undefined,
    });
  }

  // Tokens used by this workflow's agents (retries and resubmits included), from the usage ledger
  usage() {
    const by = new Map();
    let total = 0;
    for (const r of readUsage(this.t0 - 1000)) {
      if (r.kind === 'limit' || r.wf !== this.id) continue;
      total += r.tot || 0;
      by.set(r.alias || r.m || '?', (by.get(r.alias || r.m || '?') || 0) + (r.tot || 0));
    }
    return { total, by: [...by].sort((a, b) => b[1] - a[1]) };
  }

  // Agents that may have cut corners, each compared with the others of its phase and model (groups of 4 or more):
  // much faster, no tool call where the others use several, a much shorter answer; the same answer word for word
  // as an agent with another task; and a text field that has the same value in nearly every answer of a group.
  // Hints for the reader, who decides; nothing is marked as failed.
  suspects() {
    const median = a => {
      const s = [...a].sort((x, y) => x - y);
      return !s.length ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    };
    const rows = this.children
      .filter(c => c.status === 'done' && c.id)
      .map(c => {
        const st = readState(c.id) || {};
        let text = '';
        try { text = fs.readFileSync(path.join(runDir(c.id), 'final.md'), 'utf8').trim(); } catch {}
        const start = st.startedAt || st.createdAt || 0;
        return { c, task: st.task || '', ms: st.finishedAt && start ? st.finishedAt - start : 0, tools: st.toolUses || 0, chars: st.answerChars ?? text.length, text, value: this.values.get(c.index) };
      });
    const out = [];
    const groups = new Map();
    for (const x of rows) {
      const k = `${x.c.phase}\n${x.c.model}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
    for (const g of groups.values()) {
      if (g.length < 4) continue;
      const mMs = median(g.map(x => x.ms));
      const mTools = median(g.map(x => x.tools));
      const mChars = median(g.map(x => x.chars));
      for (const x of g) {
        const why = [];
        if (mMs >= 20000 && x.ms > 0 && x.ms < mMs / 4) why.push(L(`took ${fmtDuration(x.ms)} (group median ${fmtDuration(mMs)})`, `用时 ${fmtDuration(x.ms)}（同组中位 ${fmtDuration(mMs)}）`));
        if (mTools >= 2 && x.tools === 0) why.push(L(`called no tool (group median ${mTools})`, `一次工具都没调用（同组中位 ${mTools} 次）`));
        if (mChars >= 200 && x.chars < mChars / 5) why.push(L(`answer of ${x.chars} characters (group median ${Math.round(mChars)})`, `回答只有 ${x.chars} 字（同组中位 ${Math.round(mChars)} 字）`));
        if (why.length) out.push(`  #${x.c.index} ${x.c.label} (${x.c.model}): ${why.join(L('; ', '；'))}  [${x.c.id}]`);
      }
      // "Every item got the same label"
      const objs = g.map(x => x.value).filter(v => v && typeof v === 'object' && !Array.isArray(v));
      if (objs.length >= 8)
        for (const f of new Set(objs.flatMap(o => Object.keys(o)))) {
          const vals = objs.map(o => o[f]).filter(v => typeof v === 'string');
          if (vals.length < 8) continue;
          const counts = new Map();
          for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
          const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
          if (n / vals.length >= 0.8) {
            const where = `${g[0].c.phase ? L(`phase "${g[0].c.phase}", `, `阶段「${g[0].c.phase}」`) : ''}${g[0].c.model}`;
            out.push(L(`  ${where}: field ${f} is ${JSON.stringify(trunc(top, 60))} in ${n} of ${vals.length} answers`, `  ${where}：字段 ${f} 在 ${vals.length} 个回答里有 ${n} 个都是 ${JSON.stringify(trunc(top, 60))}`));
          }
        }
    }
    // Copied answers: the same text (40 characters or more) for different tasks
    const byText = new Map();
    for (const x of rows) {
      const t = x.text.replace(/\s+/g, ' ');
      if (t.length < 40) continue;
      if (!byText.has(t)) byText.set(t, []);
      byText.get(t).push(x);
    }
    for (const same of byText.values())
      if (same.length > 1 && new Set(same.map(x => x.task)).size > 1)
        out.push(L(`  ${same.map(x => `#${x.c.index}`).join(', ')}: word for word the same answer to different tasks`, `  ${same.map(x => `#${x.c.index}`).join('、')}：任务不同，回答却一字不差`));
    return out;
  }
}
