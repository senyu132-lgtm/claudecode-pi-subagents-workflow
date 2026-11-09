// The broker: one background process per agent that drives `pi --mode rpc`, delivers its inbox and settles
// each round (provider rotation, overload backoff, interrupts, hang detection, the final answer).
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { SLOTS, acquireLock, checkId, hasInbox, hasSlot, inboxDir, inboxFiles, readState, releaseLock, releaseSlot, runDir, runningSlots, saveState, slotError, takeSlot } from './runs.mjs';
import { FILE_MODE, appendPrivate, continueText, errorTitle, isAlive, killTree, loadConfig, now, readJSON, sleep, trunc, writeJSON, writePrivate } from './core.mjs';
import { L } from '../i18n.mjs';
import { maybeAutoClean } from './maintenance.mjs';
import { appendUsage, isTransient, isUsageLimit, markExhausted, pickProvider, providerAvailable } from './models.mjs';
import { findCli, noCli } from './pi.mjs';
import { commitWorktree, ensureWorktree, minutesFrom, removeWorktree, worktreeReport } from './git.mjs';

// ---------- broker: the part that actually drives pi ----------
export async function cmdServe(argv) {
  const id = checkId(argv[0]);
  for (;;) {
    if (!acquireLock(id)) return;
    try {
      while (hasInbox(id)) {
        const s = new PiSession(id);
        await s.run();
        if (s.fatal) break;
      }
    } catch (e) {
      const st = readState(id);
      if (isAlive(Number(st.piPid))) killTree(st.piPid);
      const msg = L(`the broker failed: ${e?.message || e}`, `broker 出错：${e?.message || e}`);
      try { writePrivate(path.join(runDir(id), 'final.md'), `${errorTitle()}${msg}\n`); } catch {}
      saveState(id, { status: 'error', lastError: String(e?.stack || e), rounds: (st.rounds || 0) + 1, finishedAt: now() });
    } finally {
      releaseSlot();
      releaseLock(id);
    }
    // Check the inbox once more after releasing the lock, so a message that arrived as we exited is not lost
    if (!hasInbox(id)) return maybeAutoClean();
  }
}
export const lastAnswer = text => (text ? L(`\n\nIts last answer:\n${text}`, `\n\n它最后的回答：\n${text}`) : '');

export class PiSession {
  constructor(id) {
    this.id = id;
    this.dir = runDir(id);
    this.cfg = loadConfig();
    this.pending = new Map();
    this.reqSeq = 0;
    this.busy = false;
    this.closing = false;
    this.stopping = false;
    this.fatal = false;
    this.lastAssistant = null;
    this.retries = 0;
    this.sent = []; // messages sent to pi that have not shown up in its events yet (to label who sent them)
    this.live = { text: '', thinking: '', tool: '' };
    this.liveTimer = null;
    // For the pane and the transcript row: tool calls over the agent's whole life, and the last few of them
    this.toolUses = readState(id)?.toolUses || 0;
    this.recent = [];
    this.badLines = 0; // stdout lines that were not JSON
    // Tool calls running now (pi may run several at once), each with its own start time
    this.toolsOpen = new Map();
    this.toolSeq = 0;
    // Inbox files the system would not let us read yet, and since when
    this.unreadable = new Map();
    this.stopTimer = null;
    this.lastEventAt = now();
    this.idleAfterSettle = false; // the run settled while a message was being delivered
    this.rejected = ''; // why pi turned down the last prompt
    this.gaveUp = ''; // why the broker killed pi (hung, broken protocol)
    // Interrupt (send --mode interrupt): abort the current step, wait until pi is idle, then send the new
    // instruction as a prompt. While `interrupting`, the agent_settled that the abort brings does not end the round;
    // `gen` goes up with every interrupt, so a resume planned before it (account switch, backoff) is dropped.
    this.interrupting = false;
    this.gen = 0;
    this.wakeRetry = null;
    // Usage not yet written to the ledger: provider+model -> sums
    this.usageAcc = new Map();
    this.usageFlushedAt = now();
  }
  // The tokens of one reply, added up per provider and model until the next flush to the ledger
  addUsage(m) {
    const u = m.usage;
    if (!u || typeof u !== 'object') return;
    const num = v => (Number.isFinite(+v) ? +v : 0);
    const key = `${m.provider || ''}\0${m.model || ''}`;
    const a = this.usageAcc.get(key) || { p: m.provider || '', m: m.model || '', n: 0, in: 0, out: 0, cr: 0, cw: 0, tot: 0, cost: 0 };
    a.n++;
    a.in += num(u.input);
    a.out += num(u.output);
    a.cr += num(u.cacheRead);
    a.cw += num(u.cacheWrite);
    a.tot += num(u.totalTokens) || num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
    a.cost += num(u.cost?.total);
    this.usageAcc.set(key, a);
    if (now() - this.usageFlushedAt > 300000) this.flushUsage();
  }
  flushUsage() {
    this.usageFlushedAt = now();
    if (!this.usageAcc.size) return;
    const st = readState(this.id) || {};
    for (const a of this.usageAcc.values()) appendUsage({ t: now(), id: this.id, wf: st.parent || '', alias: st.alias || '', ...a, cost: Math.round(a.cost * 1e6) / 1e6 });
    this.usageAcc.clear();
  }
  view(entry) {
    appendPrivate(path.join(this.dir, 'view.jsonl'), JSON.stringify({ t: now(), ...entry }) + '\n');
  }
  event(rec) {
    appendPrivate(path.join(this.dir, 'events.jsonl'), JSON.stringify({ t: now(), ...rec }) + '\n');
  }
  state(patch) {
    return saveState(this.id, patch);
  }
  writeLive(force) {
    if (this.liveTimer && !force) return;
    const flush = () => {
      this.liveTimer = null;
      try { writeJSON(path.join(this.dir, 'live.json'), { t: now(), ...this.live, tools: this.toolUses, recent: this.recent }); } catch {}
    };
    if (force) {
      clearTimeout(this.liveTimer);
      flush();
    } else this.liveTimer = setTimeout(flush, 400);
  }
  // Every request has a deadline: a pi that stops answering must not leave the agent waiting forever
  send(cmd, timeoutMs = (Number(this.cfg.rpcTimeoutSec) || 60) * 1000) {
    const id = `b${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) return reject(new Error(L('pi has exited', 'pi 已退出')));
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        const e = new Error(L(`pi did not answer "${cmd.type}" within ${Math.round(timeoutMs / 1000)}s`, `pi 在 ${Math.round(timeoutMs / 1000)} 秒内没有回应「${cmd.type}」`));
        e.timeout = true;
        reject(e);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: r => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ ...cmd, id }) + '\n');
    });
  }
  // pi hung or broke the protocol: kill it. The round then ends with this reason as its error.
  giveUp(reason) {
    if (this.closing || this.gaveUp) return;
    this.gaveUp = reason;
    this.view({ k: 'error', text: reason });
    killTree(this.child?.pid);
  }
  async run() {
    let st = readState(this.id);
    const cli = findCli();
    if (!cli) {
      this.fatal = true;
      return this.failWithoutPi(noCli());
    }
    const pool = Array.isArray(st.pool) ? st.pool : [];
    if (pool.length && (!st.provider || !providerAvailable(st.provider))) {
      const p = pickProvider(pool);
      if (!p) {
        this.fatal = true;
        return this.failWithoutPi(L(`every provider in the pool is cooling down (${pool.join(', ')})`, `轮换池里的提供方都在冷却中（${pool.join('、')}）`));
      }
      this.view({ k: 'info', text: L(`provider ${st.provider} is cooling down; switching to ${p}`, `提供方 ${st.provider} 在冷却中，改用 ${p}`) });
      st = this.state({ provider: p, accountsTried: [...new Set([...(st.accountsTried || []), p])] });
    }
    let workCwd = st.cwd;
    if (st.worktree) {
      const base = st.worktree.base;
      const err = ensureWorktree(st.worktree);
      if (err) {
        this.fatal = true;
        return this.failWithoutPi(L(`could not set up the agent's git worktree again: ${err}`, `没能重新建立代理的 git worktree：${err}`));
      }
      if (st.worktree.removed || st.worktree.base !== base) st = this.state({ worktree: { ...st.worktree, removed: false } });
      workCwd = path.join(st.worktree.dir, st.worktree.prefix || '');
    }
    // Global limit across every session and workflow on this machine
    const max = Number(this.cfg.maxAgents) || 0;
    if (max > 0 && !hasSlot()) {
      let shown = false;
      let broken = 0;
      while (!takeSlot(max, this.id)) {
        // Not one slot file could be written (permissions, a full disk): waiting would never end
        if (!slotError) broken = 0;
        else if (++broken >= 30) {
          this.fatal = true;
          return this.failWithoutPi(L(`could not write the slot files in ${SLOTS}: ${slotError}`, `没法在 ${SLOTS} 里写空位文件：${slotError}`));
        }
        if (!shown) {
          shown = true;
          this.state({ status: 'queued' });
          this.view({ k: 'info', text: L(`waiting for a free slot: ${runningSlots()} pi agents are running on this machine (maxAgents is ${max})`, `等待空位：本机已有 ${runningSlots()} 个 pi 代理在运行（maxAgents 为 ${max}）`) });
        }
        if (inboxFiles(this.id).some(f => readJSON(path.join(inboxDir(this.id), f), {})?.control === 'stop')) {
          this.fatal = true;
          return this.failWithoutPi(L('stopped while waiting for a free slot; it never started', '排队等空位时被停止，没有开始运行'), 'stopped');
        }
        await sleep(1000 + Math.floor(Math.random() * 500));
      }
    }
    const args = [cli, '--mode', 'rpc', '--session-dir', path.join(this.dir, 'session'), '--name', this.id];
    // By default pi skips context files, so the task it was given is all it works from (per task: contextFiles)
    if (!(st.contextFiles ?? this.cfg.contextFiles)) args.push('--no-context-files');
    if (st.model) args.push('--model', st.provider ? `${st.provider}/${st.model}` : st.model);
    if (st.thinking) args.push('--thinking', st.thinking);
    // Read-only: only pi's four read tools. --tools alone keeps MCP tools, so MCP is switched off as well, and
    // project-local pi extensions and settings are ignored. This limits tools; it is not a filesystem sandbox.
    if (st.readonly) args.push('--tools', 'read,grep,find,ls', '--no-mcp', '--no-approve');
    if (st.sessionFile && fs.existsSync(st.sessionFile)) args.push('--session', st.sessionFile);
    // startedAt: when pi first started (after any wait for a slot), for how long an agent took
    this.state({ status: 'running', brokerPid: process.pid, ...(st.startedAt ? {} : { startedAt: now() }) });
    const errLog = fs.openSync(path.join(this.dir, 'pi-stderr.log'), 'a', FILE_MODE);
    this.child = spawn(process.execPath, args, {
      cwd: workCwd,
      stdio: ['pipe', 'pipe', errLog],
      windowsHide: true,
      detached: process.platform !== 'win32', // its own process group, so killTree also ends its shell commands
    });
    fs.closeSync(errLog);
    this.state({ piPid: this.child.pid });

    let buf = Buffer.alloc(0);
    const MAX_LINE = 64 * 1024 * 1024;
    this.child.stdout.on('data', chunk => {
      this.lastEventAt = now();
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let i;
      while ((i = buf.indexOf(10)) >= 0) {
        let line = buf.subarray(0, i).toString('utf8');
        buf = buf.subarray(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          // stdout is reserved for protocol records: count garbage, keep a few samples, give up if it keeps coming
          if (++this.badLines <= 5) this.view({ k: 'error', text: L(`pi sent a line that is not JSON (skipped): ${trunc(line, 200)}`, `pi 输出了一行不是 JSON 的内容（已跳过）：${trunc(line, 200)}`) });
          if (this.badLines === 100) this.giveUp(L('pi sent 100 lines that are not valid JSON; its RPC output looks broken', 'pi 输出了 100 行不合法的 JSON，RPC 输出看起来坏了'));
          continue;
        }
        this.onRecord(rec).catch(e => this.view({ k: 'error', text: L(`broker internal error: ${e?.message || e}`, `broker 内部错误：${e?.message || e}`) }));
      }
      if (buf.length > MAX_LINE) {
        buf = Buffer.alloc(0);
        this.giveUp(L('pi sent more than 64 MB without a line break; its RPC output looks broken', 'pi 输出了超过 64 MB 却没有换行，RPC 输出看起来坏了'));
      }
    });
    this.child.stdin.on('error', () => {});
    // Watchdog: a working agent that goes silent (no tool running), or a tool call that never ends, is hung
    const stall = (Number(this.cfg.stallTimeoutMin) || 0) * 60000;
    const tool = (Number(this.cfg.toolTimeoutMin) || 0) * 60000;
    const tick = Math.max(500, Math.min(15000, Math.min(stall || Infinity, tool || Infinity) / 4));
    this.watchdog = setInterval(() => {
      if (this.closing || !this.busy || this.waitingRetry) return;
      if (this.toolsOpen.size > 0) {
        if (tool && now() - Math.min(...this.toolsOpen.values()) > tool) this.giveUp(L(`a tool call has been running for over ${this.cfg.toolTimeoutMin} min (toolTimeoutMin); treating it as hung`, `一个工具调用已运行超过 ${this.cfg.toolTimeoutMin} 分钟（toolTimeoutMin），按卡死处理`));
      } else if (stall && now() - this.lastEventAt > stall) {
        this.giveUp(L(`pi sent nothing for ${this.cfg.stallTimeoutMin} min while working (stallTimeoutMin); treating it as hung`, `pi 工作中 ${this.cfg.stallTimeoutMin} 分钟没有任何输出（stallTimeoutMin），按卡死处理`));
      }
    }, tick);

    // When pi exits (an unknown model makes it quit at once), fail every request still waiting for an answer;
    // otherwise run() would wait forever on get_state and the broker would quietly die and be restarted
    const exited = new Promise(resolve => {
      let done = false;
      const end = code => {
        if (done) return;
        done = true;
        for (const p of this.pending.values()) p.reject(new Error(L('pi has exited', 'pi 已退出')));
        this.pending.clear();
        resolve(code);
      };
      this.child.on('close', end);
      this.child.on('error', e => {
        try { appendPrivate(path.join(this.dir, 'pi-stderr.log'), `${e.message}\n`); } catch {}
        end(-1);
      });
    });
    try {
      const s = await this.send({ type: 'get_state' });
      if (s.success) {
        const patch = {};
        if (s.data?.sessionFile) patch.sessionFile = s.data.sessionFile;
        // No model was chosen: record the default model pi picked, so the panel can show it
        const m = s.data?.model;
        if (!st.model && m && typeof m === 'object' && (m.id || m.name)) {
          patch.provider = String(m.provider || '');
          patch.model = String(m.id || m.name);
        }
        if (Object.keys(patch).length) this.state(patch);
      }
    } catch (e) {
      if (e.timeout) this.giveUp(L(`pi did not finish starting up: ${e.message}`, `pi 没能完成启动：${e.message}`));
    }
    this.inboxTimer = setInterval(() => this.pumpInbox().catch(() => {}), 300);
    this.pumpInbox().catch(() => {});

    const code = await exited;
    clearInterval(this.inboxTimer);
    clearInterval(this.watchdog);
    clearTimeout(this.liveTimer);
    for (const p of this.pending.values()) p.reject(new Error(L('pi has exited', 'pi 已退出')));
    if (!this.closing) {
      // pi exited by itself (unknown model, crash, ...) or was killed as hung
      let tail = '';
      try { tail = fs.readFileSync(path.join(this.dir, 'pi-stderr.log'), 'utf8').slice(-1500); } catch {}
      this.fatal = true;
      this.failWithoutPi(this.gaveUp || L(`the pi process exited unexpectedly (exit code ${code}). ${tail.trim()}`, `pi 进程意外退出（退出码 ${code}）。${tail.trim()}`));
    }
    // pi has exited, so Windows lets go of the folder: now an unchanged worktree can be removed
    this.dropWorktreeNow();
  }
  failWithoutPi(msg, status = 'error') {
    // The round ends here, once: a stop's 15-second fallback must not finalize it a second time
    this.closing = true;
    clearTimeout(this.stopTimer);
    const st = readState(this.id);
    // Messages still queued can no longer be delivered: say which, instead of dropping them silently
    const dropped = [];
    for (const f of inboxFiles(this.id)) {
      const m = readJSON(path.join(inboxDir(this.id), f), null);
      if (typeof m?.text === 'string') dropped.push(trunc(m.text, 200));
      try { fs.unlinkSync(path.join(inboxDir(this.id), f)); } catch {}
    }
    const lost = dropped.length
      ? L(`\n(${dropped.length} queued ${dropped.length === 1 ? 'message was' : 'messages were'} not delivered: ${dropped.join(' | ')})`, `\n（${dropped.length} 条排队的消息没送到：${dropped.join(' | ')}）`)
      : '';
    if (lost) this.view({ k: 'error', text: lost.trim() });
    const wt = this.wrapWorktree();
    writePrivate(path.join(this.dir, 'final.md'), `${status === 'stopped' ? L('[stopped] ', '【已停止】') : errorTitle()}${msg}${lost}${wt}\n`);
    if (status === 'error') this.view({ k: 'error', text: msg });
    this.view({ k: 'done', status, round: (st.rounds || 0) + 1 });
    this.state({ status, lastError: status === 'error' ? msg : '', finishedAt: now(), rounds: (st.rounds || 0) + 1 });
    if (!this.child || this.child.exitCode !== null) this.dropWorktreeNow();
  }
  // Commit what the agent changed on its branch. Returns the text added to its final answer (none for
  // workflow agents: there the answer is the script's value, and the workflow summary lists the branches).
  wrapWorktree() {
    const st = readState(this.id);
    if (!st.worktree || st.worktree.removed) return '';
    const rep = commitWorktree(st);
    if (!rep) return '';
    this.state({ worktree: { ...st.worktree, report: rep } });
    if (!rep.changed) this.dropWorktree = true;
    return st.origin === 'flow' ? '' : '\n\n' + worktreeReport(st.worktree, rep, this.id);
  }
  dropWorktreeNow() {
    if (!this.dropWorktree) return;
    this.dropWorktree = false;
    const st = readState(this.id);
    if (!st.worktree) return;
    removeWorktree(st.worktree);
    this.state({ worktree: { ...st.worktree, removed: true } });
  }
  // Deliver queued messages in order. A message leaves the inbox only after pi answered it (accepted or turned
  // down): if the broker dies in between, the next broker delivers it again (at least once, never lost).
  async pumpInbox() {
    if (this.closing) return;
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        for (const f of inboxFiles(this.id)) {
          if (this.closing) return;
          const file = path.join(inboxDir(this.id), f);
          let msg = null;
          let readErr = null;
          try {
            msg = readJSON(file, null, true);
          } catch (e) {
            readErr = e;
          }
          // Windows can refuse a file for a moment (a virus scanner holding it): try again on the next pass,
          // keeping the order, and set it aside only if it stays unreadable for 30 s
          if (readErr?.code) {
            if (!this.unreadable.has(f)) this.unreadable.set(f, now());
            if (now() - this.unreadable.get(f) < 30000) return;
          }
          this.unreadable.delete(f);
          if (!msg) {
            if (!fs.existsSync(file)) continue; // gone already
            try { fs.renameSync(file, `${file}.bad`); } catch {}
            this.view({ k: 'error', text: L(`skipped a message file that could not be read: ${f} (${readErr?.message || 'not a message'})`, `跳过了一个读不了的消息文件：${f}（${readErr?.message || '不是消息'}）`) });
            continue;
          }
          if (msg.control === 'stop') {
            try { fs.unlinkSync(file); } catch {}
            await this.stop();
            return;
          }
          if (this.stopping) {
            try { fs.unlinkSync(file); } catch {}
            continue;
          }
          try {
            await this.deliver(msg);
          } catch (e) {
            // No answer: the message stays in the inbox, unacknowledged
            if (e.timeout) this.giveUp(e.message);
            return;
          }
          try { fs.unlinkSync(file); } catch {}
        }
      } while (this.repump && !this.closing);
    } finally {
      this.pumping = false;
    }
    // Nothing is running and nothing is queued: this round is over
    if (this.closing || this.busy || hasInbox(this.id)) return;
    if (this.rejected) return this.finalize('error', this.rejected);
    if (this.idleAfterSettle) return this.finalize('done');
  }
  async deliver(msg) {
    if (this.busy && msg.mode === 'interrupt') return this.interrupt(msg);
    if (this.busy) {
      const entry = { text: msg.text, from: msg.from || 'claude', mode: msg.mode };
      this.sent.push(entry);
      const r = await this.send({ type: msg.mode === 'follow_up' ? 'follow_up' : 'steer', message: msg.text });
      if (r.success) return r;
      // Not delivered: forget it as sent, so a later message with the same text is not credited to this sender
      const i = this.sent.lastIndexOf(entry);
      if (i >= 0) this.sent.splice(i, 1);
      if (this.busy) {
        this.view({ k: 'error', text: L(`pi turned the message down, so it was not delivered: ${r.error} (message: ${trunc(msg.text, 200)})`, `pi 没收下这条消息，没送到：${r.error}（消息：${trunc(msg.text, 200)}）`) });
        return r;
      }
      // The run ended while the message was on its way: start a new run with it instead
    }
    this.sent.push({ text: msg.text, from: msg.from || 'claude', mode: 'prompt' });
    this.busy = true;
    this.idleAfterSettle = false;
    this.rejected = '';
    this.state({ status: 'running' });
    const r = await this.send({ type: 'prompt', message: msg.text });
    if (!r.success) {
      // Turned down before it started: no run and no agent_settled will follow, so the round must end here
      this.busy = false;
      this.rejected = L(`pi rejected the message: ${r.error}`, `pi 拒绝了消息：${r.error}`);
      this.view({ k: 'error', text: this.rejected });
    } else if (r.data?.disposition === 'handled') {
      // An extension command or input handler consumed it: no run starts, so no agent_settled will come
      this.busy = false;
      this.idleAfterSettle = true;
      this.view({ k: 'info', text: L('pi handled the message itself; no model run was started', 'pi 自己处理了这条消息，没有启动模型运行') });
    }
    return r;
  }
  // Interrupt: stop the current step (an answer half written, a command half run are dropped), wait until pi is
  // idle, then send the new instruction as a prompt in the same session.
  // Tested with pi 1.5.0: steer-then-abort aborts the queued message too and the model never answers; so abort
  // first (pi answers it once idle), then prompt. pi sends agent_settled{aborted:true} before it answers the abort.
  async interrupt(msg) {
    this.gen++;
    this.view({ k: 'info', text: L('Interrupted: stopping the current step and switching to the new instruction', '收到打断：中止当前这一步，马上改做新要求') });
    this.interrupting = true;
    try {
      if (this.waitingRetry) {
        // Waiting out an overload (pi is idle anyway): cut the wait short and do not resume the old step
        this.wakeRetry?.();
      } else {
        try {
          const r = await this.send({ type: 'abort' }, 15000);
          if (!r.success) this.view({ k: 'error', text: L(`could not stop the current step: ${r.error}; sending the new instruction anyway`, `中止当前这一步失败：${r.error}；仍尝试发送新要求`) });
        } catch (e) {
          if (this.closing) throw e;
          this.view({ k: 'error', text: L(`could not stop the current step: ${e.message}; sending the new instruction anyway`, `中止当前这一步失败：${e.message}；仍尝试发送新要求`) });
        }
      }
      // Let the events the abort brought (in the same batch of output) be handled first
      await sleep(50);
    } finally {
      this.interrupting = false;
    }
    if (this.closing || this.stopping) return { success: true };
    const entry = { text: msg.text, from: msg.from || 'claude', mode: 'interrupt' };
    this.sent.push(entry);
    this.lastAssistant = null;
    this.retries = 0;
    this.busy = true;
    this.idleAfterSettle = false;
    this.rejected = '';
    this.state({ status: 'running' });
    // If pi did not stop after all, streamingBehavior turns this into a steer instead of a refusal
    const r = await this.send({ type: 'prompt', message: msg.text, streamingBehavior: 'steer' });
    if (!r.success) {
      const i = this.sent.lastIndexOf(entry);
      if (i >= 0) this.sent.splice(i, 1);
      this.busy = false;
      this.rejected = L(`after the interrupt pi turned the new instruction down: ${r.error} (message: ${trunc(msg.text, 200)})`, `打断后 pi 拒收了新要求：${r.error}（消息：${trunc(msg.text, 200)}）`);
      this.view({ k: 'error', text: this.rejected });
    }
    return r;
  }
  async stop() {
    this.stopping = true;
    for (const f of inboxFiles(this.id)) try { fs.unlinkSync(path.join(inboxDir(this.id), f)); } catch {}
    this.view({ k: 'info', text: L('Stop requested', '收到停止请求') });
    if (this.busy && !this.waitingRetry) {
      try { await this.send({ type: 'clear_queue' }); } catch {}
      try { await this.send({ type: 'abort' }); } catch {}
      // abort is followed by agent_settled, which finalizes; force it after 15 s just in case
      this.stopTimer = setTimeout(() => { if (!this.closing) this.finalize('stopped'); }, 15000);
    } else await this.finalize('stopped');
  }
  async onRecord(rec) {
    const t = rec.type;
    if (t === 'response') {
      const p = this.pending.get(rec.id);
      if (p) {
        this.pending.delete(rec.id);
        p.resolve(rec);
      }
      return;
    }
    if (t === 'extension_ui_request') {
      if (['select', 'confirm', 'input', 'editor'].includes(rec.method)) {
        this.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: rec.id, cancelled: true }) + '\n');
        this.view({ k: 'info', text: L(`a pi extension opened a dialog (${rec.method}: ${trunc(rec.title || rec.message || '', 100)}); cancelled automatically`, `pi 扩展弹出了对话框（${rec.method}：${trunc(rec.title || rec.message || '', 100)}），已自动取消`) });
      }
      return;
    }
    if (t === 'tool_execution_update') return;
    if (t === 'message_update') {
      const ev = rec.assistantMessageEvent || {};
      if (ev.type === 'text_delta') this.live.text += ev.delta || '';
      else if (ev.type === 'thinking_delta') this.live.thinking += ev.delta || '';
      else if (ev.type === 'toolcall_start') this.live.tool = ev.toolName || '';
      else return;
      this.writeLive();
      return;
    }
    // Slimmed event stream, for debugging
    const lean = { ...rec };
    if (t === 'agent_end') delete lean.messages;
    if (t === 'turn_end') {
      delete lean.message;
      delete lean.toolResults;
    }
    if (!((t === 'message_start' || t === 'message_end') && rec.message?.role === 'system') && t !== 'message_start') this.event(lean);

    switch (t) {
      case 'agent_start':
        this.busy = true;
        break;
      case 'message_end': {
        const m = rec.message || {};
        if (m.role === 'user') {
          const text = typeof m.content === 'string' ? m.content : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
          const i = this.sent.findIndex(s => s.text === text);
          const src = i >= 0 ? this.sent.splice(i, 1)[0] : { from: 'system', mode: 'prompt' };
          this.view({ k: 'user', from: src.from, mode: src.mode, text });
        } else if (m.role === 'assistant') {
          this.lastAssistant = m;
          this.addUsage(m);
          for (const c of m.content || []) {
            if (c.type === 'thinking' && c.thinking?.trim()) this.view({ k: 'thinking', text: trunc(c.thinking, 4000) });
            else if (c.type === 'text' && c.text?.trim()) this.view({ k: 'text', text: trunc(c.text, 40000) });
          }
          // The step cut off by an interrupt or a stop also ends with an error ("This operation was aborted"): expected, just note it
          if (m.stopReason === 'error')
            this.view(this.interrupting || this.stopping ? { k: 'info', text: L('the current step was stopped', '当前这一步已中止') } : { k: 'error', text: m.errorMessage || L('unknown error', '未知错误') });
          this.live = { text: '', thinking: '', tool: '' };
          this.writeLive(true);
        }
        break;
      }
      case 'tool_execution_start': {
        this.toolsOpen.set(rec.toolCallId || `#${++this.toolSeq}`, now());
        const args = summarizeArgs(rec.args);
        this.view({ k: 'tool', name: rec.toolName, args });
        this.toolUses++;
        this.recent = [...this.recent, { name: rec.toolName || '', args: trunc(args, 160) }].slice(-3);
        this.writeLive();
        break;
      }
      case 'tool_execution_end': {
        // Match the call by its id; without one, the oldest open call is the best guess
        const open = rec.toolCallId && this.toolsOpen.has(rec.toolCallId) ? rec.toolCallId : this.toolsOpen.keys().next().value;
        if (open !== undefined) this.toolsOpen.delete(open);
        const text = (rec.result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        this.view({ k: 'tool_end', name: rec.toolName, ok: !rec.isError, ms: rec.durationMs, out: trunc(text, 1500) });
        break;
      }
      case 'auto_retry_start':
        this.state({ status: 'retrying' });
        this.view({ k: 'retry', text: L(`pi auto-retry ${rec.attempt}/${rec.maxAttempts} (in ${Math.round(rec.delayMs / 1000)}s): ${trunc(rec.errorMessage, 300)}`, `pi 自动重试 ${rec.attempt}/${rec.maxAttempts}（${Math.round(rec.delayMs / 1000)} 秒后）：${trunc(rec.errorMessage, 300)}`) });
        break;
      case 'auto_retry_end':
        this.state({ status: 'running' });
        break;
      case 'compaction_start':
        this.view({ k: 'info', text: L(`context compaction started (${rec.reason})`, `上下文压缩开始（${rec.reason}）`) });
        break;
      case 'compaction_end':
        this.view({
          k: 'info',
          text: rec.result
            ? L(`context compacted: ${rec.result.tokensBefore} → about ${rec.result.estimatedTokensAfter} tokens`, `上下文压缩完成：${rec.result.tokensBefore} → 约 ${rec.result.estimatedTokensAfter} tokens`)
            : L(`context compaction failed: ${rec.errorMessage || 'aborted'}`, `上下文压缩失败：${rec.errorMessage || '已中止'}`),
        });
        break;
      case 'agent_settled':
        this.toolsOpen.clear();
        await this.onSettled(rec);
        break;
    }
  }
  async onSettled(rec) {
    // The settle that an interrupt's abort brings: interrupt() sends the new instruction, the round goes on
    if (this.closing || this.interrupting) return;
    const gen = this.gen;
    const st = readState(this.id);
    if (this.stopping) return this.finalize('stopped');
    let last = this.lastAssistant;
    const pool = Array.isArray(st.pool) ? st.pool : [];
    // Test hook only: with PISUB_TEST_FAKE_LIMIT=<provider>, that provider's first success is treated as a usage-limit error
    if (process.env.PISUB_TEST_FAKE_LIMIT && process.env.PISUB_TEST_FAKE_LIMIT === st.provider && !this.fakedLimit && last && last.stopReason !== 'error') {
      this.fakedLimit = true;
      last = { stopReason: 'error', errorMessage: 'You have hit your usage limit (test). Try again in ~3 min.' };
      this.view({ k: 'error', text: L(`(test) simulated error: ${last.errorMessage}`, `（测试）模拟报错：${last.errorMessage}`) });
    }
    if (last?.stopReason === 'error') {
      const err = last.errorMessage || '';
      if (pool.length && isUsageLimit(err)) {
        markExhausted(st.provider, minutesFrom(err) ?? this.cfg.exhaustedCooldownMin, err);
        const next = pickProvider(pool, [st.provider]);
        if (next) {
          const r = await this.send({ type: 'set_model', provider: next, modelId: st.model });
          if (r.success) {
            this.view({ k: 'info', text: L(`${st.provider} hit its usage limit; carrying on with ${next}`, `${st.provider} 额度用完，换成 ${next} 接着做`) });
            this.state({ provider: next, accountsTried: [...new Set([...(st.accountsTried || []), next])] });
            this.lastAssistant = null;
            // Interrupted while switching: the new instruction is already running, do not resume the old step
            if (gen !== this.gen) return;
            return this.resume();
          }
          this.view({ k: 'error', text: L(`switching to ${next} failed: ${r.error}`, `切换到 ${next} 失败：${r.error}`) });
        }
        return this.finalize('error', L(`every provider in the pool hit its usage limit (last error: ${err})`, `轮换池里的提供方额度都用完了（最后报错：${err}）`));
      }
      if (isTransient(err) && this.retries < this.cfg.overloadBackoffSec.length) {
        const sec = this.cfg.overloadBackoffSec[this.retries++];
        this.state({ status: 'waiting' });
        this.view({ k: 'retry', text: L(`service unavailable; retrying in ${sec}s (attempt ${this.retries}): ${trunc(err, 300)}`, `服务暂时不可用，${sec} 秒后再试（第 ${this.retries} 次）：${trunc(err, 300)}`) });
        this.waitingRetry = true;
        // An interrupt can cut this wait short
        await new Promise(resolve => {
          const timer = setTimeout(resolve, sec * 1000);
          this.wakeRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wakeRetry = null;
        this.waitingRetry = false;
        if (this.closing || this.stopping || gen !== this.gen) return;
        this.lastAssistant = null;
        return this.resume();
      }
      return this.finalize('error', err);
    }
    if (rec.aborted || last?.stopReason === 'aborted') return this.finalize('stopped');
    this.retries = 0;
    // Someone sent a message while it was wrapping up (or one is on its way to pi): keep going
    if (hasInbox(this.id) || this.pumping) {
      this.busy = false;
      this.idleAfterSettle = true;
      return this.pumpInbox();
    }
    return this.finalize('done');
  }
  async resume() {
    this.busy = true;
    this.state({ status: 'running' });
    const text = continueText();
    this.sent.push({ text, from: 'system', mode: 'prompt' });
    const r = await this.send({ type: 'prompt', message: text });
    if (!r.success) return this.finalize('error', L(`could not resume: ${r.error}`, `续做失败：${r.error}`));
  }
  async finalize(status, errText) {
    if (this.closing) return;
    this.closing = true;
    // Before the status says the round ended: a workflow then finds this round's usage in the ledger
    this.flushUsage();
    clearInterval(this.inboxTimer);
    clearTimeout(this.stopTimer);
    let text = null;
    let stats = null;
    try { text = (await this.send({ type: 'get_last_assistant_text' }, 15000)).data?.text ?? null; } catch {}
    try { stats = (await this.send({ type: 'get_session_stats' }, 15000)).data ?? null; } catch {}
    const answerChars = (text || '').trim().length;
    let final = answerChars ? text : L('(pi finished without writing a final answer)', '（pi 结束了，但没有写最终回答）');
    if (status === 'error') final = errorTitle() + (errText || L('unknown error', '未知错误')) + lastAnswer(text);
    if (status === 'stopped') final = L('[stopped]', '【已停止】') + lastAnswer(text);
    // Before the status says "done": a workflow reading this agent's state then sees its branch
    final += this.wrapWorktree();
    writePrivate(path.join(this.dir, 'final.md'), final + '\n');
    const st = readState(this.id);
    const round = (st.rounds || 0) + 1;
    this.view({ k: 'done', status, round });
    this.state({
      status,
      rounds: round,
      finishedAt: now(),
      lastError: status === 'error' ? errText || '' : '',
      finalPreview: trunc(final, 300),
      answerChars,
      toolUses: this.toolUses,
      usage: stats?.tokens,
      cost: stats?.cost,
      context: stats?.contextUsage,
      sessionFile: stats?.sessionFile || st.sessionFile,
    });
    this.live = { text: '', thinking: '', tool: '' };
    this.writeLive(true);
    this.child.stdin.end();
    const child = this.child;
    setTimeout(() => { if (child.exitCode === null) killTree(child.pid); }, 15000).unref();
  }
}
export function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  args = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined));
  if (typeof args.command === 'string') return trunc(args.command, 500);
  if (typeof args.path === 'string') {
    const extra = Object.entries(args).filter(([k]) => !['path', 'content', 'oldText', 'newText', 'edits'].includes(k));
    const n = args.content ? String(args.content).length : 0;
    return args.path + (extra.length ? ' ' + JSON.stringify(Object.fromEntries(extra)) : '') + (n ? L(` (writes ${n} chars)`, `（写入 ${n} 字）`) : '');
  }
  return trunc(JSON.stringify(args), 300);
}
