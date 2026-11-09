// The CLI commands that work on agents: spawn, send, status, log, result, wait, stop, accounts, usage, models.
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ACCOUNTS_FILE, CONFIG_FILE, HOME, TERMINAL, die, getText, isAlive, killTree, loadConfig, mkdirp, now, out, parseArgs, readJSON, readLines, sleep, trunc, writeJSON } from './core.mjs';
import { L } from '../i18n.mjs';
import { HEARTBEAT_MS, checkId, createRun, enqueue, hasInbox, inboxDir, inboxFiles, isServing, launchServe, listStates, lockHolder, lockPath, readState, reconcile, runDir, saveState, statusName, stopChildren, waitAndPrint } from './runs.mjs';
import { aliasInfo, allPoolProviders, dayOf, ensureServing, fmtTokens, loadCooldowns, modelLabel, providerAvailable, readUsage } from './models.mjs';
import { findCli, noCli } from './pi.mjs';

export async function cmdSpawn(argv) {
  const o = parseArgs(argv, ['readonly', 'wait', 'json', 'stdin', 'worktree']);
  const task = await getText(o);
  if (!task.trim()) die(L('no task given (use --task-file, --stdin, or write it after the options)', '没有任务描述（用 --task-file、--stdin 或直接写在后面）'));
  let r;
  try {
    r = createRun({ task, model: o.model, thinking: o.thinking, cwd: o.cwd, readonly: o.readonly, name: o.name, owner: o.owner, origin: o.origin, from: o.from, isolation: o.worktree ? 'worktree' : o.isolation });
  } catch (e) {
    die(e.message);
  }
  launchServe(r.id);
  if (o.wait) return waitAndPrint(r.id, 0, Number(o.timeout) || 0);
  if (o.json) out(JSON.stringify({ id: r.id, dir: runDir(r.id), model: modelLabel(r) }));
  else out(r.id);
}

export async function cmdSend(argv) {
  const o = parseArgs(argv, ['wait', 'stdin']);
  const id = checkId(o._.shift());
  const st = readState(id);
  if (st.kind === 'flow')
    die(L(`${id} is a workflow and cannot be messaged. Message one of its running agents instead (\`pisub status ${id}\` lists them).`, `${id} 是工作流，不能直接对话。请发给它下面还在运行的子代理（\`pisub status ${id}\` 可列出）。`));
  // An agent is closed once it has given its final answer: it takes no more messages. To go on, start a new one.
  // (A workflow's "resubmit in the right format" goes through enqueue directly and is not affected.)
  if (TERMINAL.has(st.status)) {
    const word = { done: L('finished', '完成'), error: L('ended with an error', '出错结束'), stopped: L('was stopped', '被停止') }[st.status] || st.status;
    die(L(`${id} ${word} and is closed; it takes no more messages. To carry on, start a new agent and put what it needs (including this one's result) in the task.`, `${id} 已经${word}并关闭，不再接收消息。要接着做，请重新派一个代理，把需要的上下文（包括它的结果）写进任务。`));
  }
  const text = await getText(o);
  if (!text.trim()) die(L('empty message', '没有消息内容'));
  const mode = o.mode === 'follow_up' || o.mode === 'followUp' ? 'follow_up' : o.mode === 'interrupt' ? 'interrupt' : 'steer';
  const before = st.rounds || 0;
  enqueue(id, { text, from: o.from || 'claude', mode });
  ensureServing(id);
  if (o.wait) return waitAndPrint(id, before, Number(o.timeout) || 0);
  const how = {
    steer: L('a steer (delivered once the current step is done)', '插话（当前这一步做完后送达）'),
    follow_up: L('a follow-up (handled after the current task)', '追加任务（做完当前任务后处理）'),
    interrupt: L('an interrupt (the current step is stopped and it switches to this now)', '打断（中止当前这一步，马上改做这条）'),
  }[mode];
  out(L(`Delivered to ${id}: it is running, so the message arrives as ${how}.`, `已送达 ${id}：它正在运行，消息作为${how}交给它。`));
}
export function ago(t) {
  const s = Math.round((now() - t) / 1000);
  if (s < 60) return L(`${s}s ago`, `${s}秒前`);
  if (s < 3600) return L(`${Math.round(s / 60)}m ago`, `${Math.round(s / 60)}分前`);
  if (s < 86400) return L(`${Math.round(s / 3600)}h ago`, `${Math.round(s / 3600)}小时前`);
  return L(`${Math.round(s / 86400)}d ago`, `${Math.round(s / 86400)}天前`);
}
export function cmdStatus(argv) {
  const o = parseArgs(argv, ['json', 'all']);
  const id = o._[0];
  const list = (id ? [readState(checkId(id))] : listStates(o.owner).slice(0, Number(o.limit) || 30)).map(reconcile);
  if (o.json) return out(JSON.stringify(id ? list[0] : list));
  if (!list.length) return out(L('(no pi sub-agents)', '（没有 pi 子代理）'));
  for (const st of list) {
    if (st.kind === 'flow') {
      out(`${st.id}  ${statusName(st.status)}  ${L('workflow', '工作流')} ${st.name}  ${ago(st.createdAt)}  ${st.progress || ''}`);
      if (st.lastError && st.status === 'error') out(`    ${L('error', '错误')}: ${trunc(st.lastError, 300)}`);
      // When one workflow is asked for, list its agents
      if (id)
        for (const c of st.children || []) {
          const icon = c.status === 'done' ? '✓' : c.status === 'error' ? '✗' : c.status === 'cached' ? '≡' : '●';
          const meta = `${c.model}${c.phase ? ', ' + c.phase : ''}`;
          out(`    ${icon} ${c.label} ${L(`(${meta})`, `（${meta}）`)}${c.id ? '  ' + c.id : ''}${c.note ? '  ' + trunc(c.note, 100) : ''}`);
        }
      continue;
    }
    out(`${st.id}  ${statusName(st.status)}  ${modelLabel(st)}  ${ago(st.createdAt)}  ${L(`round ${st.rounds}`, `第${st.rounds}轮`)}  ${trunc(st.task.replace(/\s+/g, ' '), 60)}`);
    if (st.lastError && st.status === 'error') out(`    ${L('error', '错误')}: ${trunc(st.lastError, 200)}`);
    if (st.worktree?.report?.changed) out(`    ${L('branch', '分支')}: ${st.worktree.branch} ${st.worktree.report.stat ? `(${st.worktree.report.stat})` : ''}`);
  }
}

export function readView(id) {
  return readLines(path.join(runDir(id), 'view.jsonl'));
}
export function renderEntry(e, full) {
  const FROM = { claude: 'Claude', user: L('User', '用户'), system: L('System', '系统') };
  const AGENT_EV = {
    start: L('▶ start', '▶ 开始'),
    done: L('✓ done', '✓ 完成'),
    error: L('✗ failed', '✗ 失败'),
    cached: L('≡ cached', '≡ 用缓存'),
    retry: L('↻ bad format, asked to resubmit', '↻ 格式不对，让它重交'),
  };
  const t = new Date(e.t).toTimeString().slice(0, 8);
  const cut = (s, n) => (full ? String(s ?? '') : trunc(s, n));
  switch (e.k) {
    case 'user': {
      const tag = `${FROM[e.from] || e.from}${e.mode && e.mode !== 'prompt' ? '·' + ({ steer: L('steer', '插话'), follow_up: L('follow-up', '追加'), interrupt: L('interrupt', '打断') }[e.mode] || e.mode) : ''}`;
      return `[${t}] ${L(`[${tag}] `, `【${tag}】`)}${cut(e.text, 800)}`;
    }
    case 'thinking': return `[${t}] ${L('(thinking) ', '（思考）')}${cut(e.text, 300)}`;
    case 'text': return `[${t}] ${L('[pi] ', '【pi】')}${cut(e.text, 2000)}`;
    case 'tool': return `[${t}] → ${e.name} ${cut(e.args, 300)}`;
    case 'tool_end': return `[${t}] ${e.ok ? '✓' : '✗'} ${e.name}${e.ms != null ? ` (${Math.round(e.ms / 100) / 10}s)` : ''} ${cut(e.out, 400)}`;
    case 'error': return `[${t}] ${L('! error: ', '！错误：')}${cut(e.text, 1000)}`;
    case 'done': return `[${t}] ==== ${L(`round ${e.round} ended: ${statusName(e.status)}`, `第${e.round}轮结束：${statusName(e.status)}`)} ====`;
    case 'phase': return `[${t}] ==== ${L('phase', '阶段')}: ${e.text} ====`;
    case 'agent': return `[${t}] ${AGENT_EV[e.ev] || e.ev} ${e.label} ${L(`(${e.model})`, `（${e.model}）`)}${e.id ? ' ' + e.id : ''}${e.text ? ': ' + cut(e.text, 400) : ''}`;
    case 'sh': return `[${t}] $ ${cut(e.text, 300)} → ${L('exit code', '退出码')} ${e.code}`;
    default: return `[${t}] · ${cut(e.text, 500)}`;
  }
}
export function cmdLog(argv) {
  const o = parseArgs(argv, ['full', 'json']);
  const id = checkId(o._[0]);
  let v = readView(id);
  const tail = o.full ? 0 : Number(o.tail) || 60;
  if (tail && v.length > tail) v = v.slice(-tail);
  if (o.json) return out(JSON.stringify(v));
  for (const e of v) out(renderEntry(e, o.full));
  const live = readJSON(path.join(runDir(id), 'live.json'), {});
  if (live.text || live.thinking || live.tool)
    out(`${L('[live] ', '[进行中] ')}${live.tool ? L(`calling ${live.tool} `, `准备调用 ${live.tool} `) : ''}${trunc(live.text || live.thinking || '', 400)}`);
}
export function cmdResult(argv) {
  const id = checkId(argv[0]);
  const f = path.join(runDir(id), 'final.md');
  if (!fs.existsSync(f)) die(L(`${id} has no final answer yet (status: ${statusName(readState(id).status)})`, `${id} 还没有最终结果（状态：${statusName(readState(id).status)}）`), 3);
  out(fs.readFileSync(f, 'utf8'));
}
export async function cmdWait(argv) {
  const o = parseArgs(argv, []);
  const id = checkId(o._[0]);
  const st = readState(id);
  // Already finished with nothing queued: print the result right away
  const before = TERMINAL.has(st.status) && !hasInbox(id) ? st.rounds - 1 : st.rounds;
  return waitAndPrint(id, before, Number(o.timeout) || 0);
}
export async function cmdStop(argv) {
  const id = checkId(argv[0]);
  // Workflow: if its runner is alive it winds down by itself; if the runner is gone, stop the agents here
  if (readState(id).kind === 'flow' && !isServing(id)) stopChildren(id);
  if (isServing(id)) {
    enqueue(id, { control: 'stop' });
    // Watchdog: a process stuck in a busy loop (say, a workflow script with an endless loop) never reads its
    // inbox and stops beating. If its heartbeat goes stale before it stops, kill it and clean up here.
    const pid = lockHolder(id);
    const t0 = now();
    let hung = false;
    while (now() - t0 < 60000) {
      const st = readState(id);
      if (TERMINAL.has(st.status) || !isAlive(pid)) break;
      if (now() - Number(readJSON(lockPath(id), {})?.at || 0) > 3 * HEARTBEAT_MS) {
        hung = true;
        break;
      }
      await sleep(500);
    }
    if (hung) {
      killTree(pid);
      const piPid = Number(readState(id).piPid);
      if (isAlive(piPid)) killTree(piPid);
      try { fs.unlinkSync(lockPath(id)); } catch {}
      if (readState(id).kind === 'flow') stopChildren(id);
      const st = readState(id);
      saveState(id, { status: 'stopped', rounds: (st.rounds || 0) + 1, finishedAt: now(), lastError: L('it did not respond, so its process was killed', '它没有响应，进程已被强制结束') });
      return out(L(`${id} did not respond; its process was killed`, `${id} 没有响应，已强制结束进程`));
    }
    out(L(`Stop requested for ${id}`, `已请求停止 ${id}`));
  } else {
    for (const f of inboxFiles(id)) try { fs.unlinkSync(path.join(inboxDir(id), f)); } catch {}
    const st = readState(id);
    if (!TERMINAL.has(st.status)) saveState(id, { status: 'stopped', rounds: (st.rounds || 0) + 1 });
    out(L(`${id} is not running`, `${id} 当前没有在运行`));
  }
}
export function cmdAccounts(argv) {
  const cfg = loadConfig();
  if (argv[0] === 'reset') {
    const acc = loadCooldowns();
    if (argv[1]) delete acc[argv[1]];
    else for (const k of Object.keys(acc)) delete acc[k];
    mkdirp(HOME);
    writeJSON(ACCOUNTS_FILE, acc);
    return out(L('Reset.', '已重置'));
  }
  const acc = loadCooldowns();
  const names = [...new Set([...allPoolProviders(cfg), ...Object.keys(acc)])];
  if (!names.length) return out(L('(no provider pools configured: see "providers" in the README)', '（没有配置提供方轮换池：见 README 里的 providers）'));
  for (const p of names) {
    const a = acc[p];
    if (providerAvailable(p, acc)) out(`${p}  ${L('available', '可用')}`);
    else out(`${p}  ${L(`cooling down until ${new Date(a.until).toLocaleString()} (${trunc(a.reason, 120)})`, `冷却到 ${new Date(a.until).toLocaleString()}（${trunc(a.reason, 120)}）`)}`);
  }
}
// pisub usage: tokens from the ledger, grouped by provider+model (default), model, alias, day or workflow
export function cmdUsage(argv) {
  const o = parseArgs(argv, ['json']);
  const by = o.by || 'provider';
  const keyOf = {
    provider: r => `${r.p || '?'} / ${r.m || '?'}`,
    model: r => r.m || '?',
    alias: r => r.alias || '?',
    day: r => dayOf(r.t),
    workflow: r => r.wf || L('(not in a workflow)', '（不在工作流里）'),
  }[by];
  if (!keyOf) die(L(`--by must be provider, model, alias, day or workflow (not "${by}")`, `--by 只能是 provider、model、alias、day 或 workflow（不是「${by}」）`));
  let since;
  if (o.since !== undefined) {
    since = new Date(`${o.since}T00:00:00`).getTime();
    if (!Number.isFinite(since)) die(L(`--since takes a date like 2026-11-01 (not "${o.since}")`, `--since 要写成 2026-11-01 这样的日期（不是「${o.since}」）`));
  } else {
    const days = o.days !== undefined ? Number(o.days) : 7;
    if (!Number.isInteger(days) || days < 1) die(L('--days takes a whole number of days, 1 or more', '--days 要写 1 以上的整数天数'));
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    since = d.getTime() - (days - 1) * 86400000;
  }
  const recs = readUsage(since);
  const limits = recs.filter(r => r.kind === 'limit');
  const groups = new Map();
  for (const r of recs.filter(r => r.kind !== 'limit')) {
    const k = keyOf(r);
    const g = groups.get(k) || { key: k, agents: new Set(), replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    g.agents.add(r.id);
    g.replies += r.n || 0;
    g.input += r.in || 0;
    g.output += r.out || 0;
    g.cacheRead += r.cr || 0;
    g.cacheWrite += r.cw || 0;
    g.total += r.tot || 0;
    g.cost += r.cost || 0;
    groups.set(k, g);
  }
  const rows = [...groups.values()]
    .map(g => ({ ...g, agents: g.agents.size, cost: Math.round(g.cost * 1e4) / 1e4 }))
    .sort((a, b) => (by === 'day' ? (a.key < b.key ? -1 : 1) : b.total - a.total));
  if (o.json) return out(JSON.stringify({ since: dayOf(since), by, rows, limits: limits.map(l => ({ provider: l.p, at: l.t, until: l.until })) }));
  out(
    L(
      `pi usage since ${dayOf(since)}, by ${by}. Cost is the model's list price as pi reports it, not what a subscription bills.`,
      `pi 用量（${dayOf(since)} 起，按 ${{ provider: '提供方/模型', model: '模型', alias: '别名', day: '天', workflow: '工作流' }[by]}）。费用是 pi 按模型标价折算的，不是订阅实际收的钱。`
    )
  );
  if (!rows.length) out(L('No usage recorded in this period (usage is recorded from version 1.4.0 on).', '这段时间没有用量记录（1.4.0 起才开始记录）。'));
  else {
    // Column widths by display width: CJK characters take two columns
    const width = s => [...String(s)].reduce((n, c) => n + (c.codePointAt(0) > 0x2e7f ? 2 : 1), 0);
    const padR = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
    const padL = (s, w) => ' '.repeat(Math.max(0, w - width(s))) + s;
    const total = rows.reduce((t, r) => ({ ...t, agents: t.agents + r.agents, replies: t.replies + r.replies, input: t.input + r.input, output: t.output + r.output, cacheRead: t.cacheRead + r.cacheRead, total: t.total + r.total, cost: t.cost + r.cost }), { key: L('total', '合计'), agents: 0, replies: 0, input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 });
    const head = [by === 'day' ? L('day', '日期') : by === 'workflow' ? L('workflow', '工作流') : L('provider / model', '提供方 / 模型'), L('agents', '代理'), L('replies', '回答'), L('input', '输入'), L('output', '输出'), L('cache read', '缓存读'), L('total', '合计'), L('cost', '折算')];
    const cells = r => [r.key, String(r.agents), String(r.replies), fmtTokens(r.input), fmtTokens(r.output), fmtTokens(r.cacheRead), fmtTokens(r.total), `$${r.cost.toFixed(2)}`];
    const table = [head, ...rows.map(cells), ...(rows.length > 1 ? [cells(total)] : [])];
    const w = head.map((_, i) => Math.max(...table.map(t => width(t[i]))));
    for (const t of table) out(t.map((c, i) => (i ? padL(c, w[i]) : padR(c, w[i]))).join('  ').trimEnd());
  }
  if (limits.length) {
    out(L('Usage limits hit:', '额度用尽记录：'));
    for (const l of limits) out(`  ${l.p}  ${new Date(l.t).toLocaleString()}${l.until ? L(` (resting until ${new Date(l.until).toLocaleString()})`, `（冷却到 ${new Date(l.until).toLocaleString()}）`) : ''}`);
  }
}
export function cmdModels(argv) {
  const o = parseArgs(argv, ['pi', 'json']);
  if (o.pi) {
    // Pass through to pi's own model list
    const cli = findCli();
    if (!cli) die(noCli());
    const r = spawnSync(process.execPath, [cli, '--list-models', ...o._], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    process.exit(r.status ?? 1);
  }
  const cfg = loadConfig();
  const rows = Object.entries(cfg.aliases)
    .filter(([, a]) => a && typeof a === 'object')
    .map(([name, a]) => aliasInfo(name, a));
  if (o.json) return out(JSON.stringify({ defaultAlias: cfg.defaultAlias || '', aliases: rows, config: CONFIG_FILE }));
  if (!rows.length) {
    out(
      L(
        `No model aliases configured. Without --model, pi uses its own default model.\nAdd aliases in ${CONFIG_FILE} (see the README), or pass any provider/model that pi knows (\`pisub models --pi\` lists them).`,
        `没有配置模型别名。不指定 --model 时用 pi 自己的默认模型。\n可以在 ${CONFIG_FILE} 里加别名（见 README），也可以直接写 pi 认识的 provider/model（\`pisub models --pi\` 列出）。`
      )
    );
    return;
  }
  out(L(`Model aliases (${CONFIG_FILE}); * = default:`, `模型别名（${CONFIG_FILE}），* 为默认：`));
  for (const r of rows) {
    const target = r.model ? (r.pool.length ? `[${r.pool.join(' → ')}]/${r.model}` : r.provider ? `${r.provider}/${r.model}` : r.model) : L('(pi default)', '（pi 默认）');
    out(`${r.alias === cfg.defaultAlias ? "*" : " "} ${r.alias}  ${target}${r.thinking ? `  thinking=${r.thinking}` : ''}`);
  }
  out(L('Any provider/model that pi knows also works (`pisub models --pi` lists them).', '也可以直接写 pi 认识的任何 provider/model（`pisub models --pi` 列出）。'));
}
