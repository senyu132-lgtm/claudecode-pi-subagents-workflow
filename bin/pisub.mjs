#!/usr/bin/env node
// pisub: run the pi coding agent as a background "sub-agent" for Claude Code.
// Each agent is a broker process detached from the Claude session; the broker drives `pi --mode rpc`.
// Run directories live in ~/.pi-subagents/runs/<id>/ (set PI_SUBAGENTS_HOME to move the root).
//
// Usage (full help: `node pisub.mjs help`):
//   spawn  [--model alias|provider/model] [--thinking lvl] [--cwd dir] [--readonly] [--worktree]
//          [--name name] [--owner session-id] [--wait] [--timeout sec] [--json]
//          (--task-file file | --stdin | task text...)
//   send   <id> [--mode steer|interrupt|follow_up] [--from claude|user] [--wait] (--stdin | text...)
//   status [id] [--owner session-id] [--json] [--limit N]
//   log    <id> [--tail N] [--full]
//   result <id> | wait <id> [--timeout sec] | stop <id>
//   models [--json] | models --pi [search]
//   accounts [reset [provider]]
//   usage  [--days N | --since date] [--by provider|model|alias|day|workflow] [--json]
//   flow   run|enable|disable ...  (pi workflows, see help)
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { CONFIG_FILE, DIR_MODE, HOME, RUNS, SELF, die, loadConfig, mkdirp, now, out } from './lib/core.mjs';
import { L, language } from './i18n.mjs';
import { cmdAccounts, cmdLog, cmdModels, cmdResult, cmdSend, cmdSpawn, cmdStatus, cmdStop, cmdUsage, cmdWait } from './lib/cli.mjs';
import { cmdFlow, cmdFlowServe } from './lib/flow.mjs';
import { cmdApply, cmdClean } from './lib/maintenance.mjs';
import { cmdServe } from './lib/broker.mjs';

const HELP_EN = `pisub: run the pi coding agent as a background sub-agent
  spawn  [--model alias|provider/model] [--thinking level] [--cwd dir] [--readonly] [--worktree]
         [--name name] [--owner session-id] [--wait] [--timeout sec] [--json]
         (--task-file file | --stdin | task text)
         Start a pi sub-agent. Prints its id right away; with --wait, waits and prints only its final answer.
         Without --model: the configured defaultAlias, or pi's own default model.
         --worktree: work in its own git worktree (branch pi/<id>) instead of your files; its changes are
         committed on that branch, and the final answer says how to review and apply them.
  send   <id> [--mode steer|interrupt|follow_up] [--from claude|user] [--wait] (--text-file file | --stdin | text)
         Message a running agent: steer (default; delivered once the current step is done), interrupt (stop the
         current step and switch to this now) or follow_up (after the current task). An agent that has given its
         final answer is closed and takes no more messages.
  status [id] [--owner session-id] [--json] [--limit N]   show status
  log    <id> [--tail N] [--full] [--json]                show what it did
  result <id>                                             print its final answer
  wait   <id> [--timeout sec]                             wait for it, then print its final answer
  stop   <id>                                             stop it
  models [--json]                                         list model aliases from config.json
  models --pi [search]                                    list the models pi knows (pi --list-models)
  accounts [reset [provider]]                             show / reset provider-pool cooldowns
  usage  [--days N | --since 2026-11-01] [--by provider|model|alias|day|workflow] [--json]
                                                          tokens used (default: the last 7 days, by provider and model)
  apply  <id> [--check] [--3way]                          apply a --worktree agent's branch to your working tree
                                                          (--check: only test; --3way: merge, leaving conflict markers)
  clean  [id...] [--days N] [--branches] [--dry-run]      remove finished runs (default: older than keepRunsDays)
                                                          and their worktrees; --branches also deletes pi/<id> branches
  paths                                                   print the run directory and other paths (JSON)
  flow run --owner session-id (--script-file script | --stdin-json) [--args JSON | --args-file file]
           [--resume old-workflow-id] [--cwd dir] [--wait] [--json] [--dry-run]
         Start a pi workflow (script API like Claude Code's Workflow: meta, agent, pipeline, parallel,
         phase, log, args, plus sh). The user must first type /pi flow in that session.
         --stdin-json reads {script|scriptPath, args, resume, cwd, dryRun} from stdin.
         --dry-run: run the script with fake agents (sample data from their schema; sh() only when readonly: true)
         and print a report: script errors, the agents a real run would start, the return value. Starts nothing.
  flow enable|disable --session session-id                turn workflows on/off for a session (used by the plugin)
Config: ${CONFIG_FILE}
Runs:   ${RUNS}
Language: English (set "language": "zh" in config.json or PISUB_LANG=zh for Chinese)`;

const HELP_ZH = `pisub —— 把 pi 编码代理当后台子代理用
  spawn  [--model 别名|provider/model] [--thinking 级别] [--cwd 目录] [--readonly] [--worktree]
         [--name 名称] [--owner 会话id] [--wait] [--timeout 秒] [--json]
         (--task-file 文件 | --stdin | 任务文本)
         启动一个 pi 子代理，默认立即返回编号；--wait 则等它做完并只输出最终回答。
         不写 --model：用配置里的 defaultAlias，没有就用 pi 自己的默认模型。
         --worktree：在它自己的 git worktree（分支 pi/<编号>）里干活，不碰你的文件；改动提交到这个分支，
         最终回答里会写怎么查看和应用。
  send   <id> [--mode steer|interrupt|follow_up] [--from claude|user] [--wait] (--text-file 文件 | --stdin | 文本)
         给运行中的代理发消息：插话（steer，默认，当前这一步做完后送达）、打断（interrupt，中止当前这一步、
         马上改做这条）或追加（follow_up，做完当前任务后处理）。交出最终回答的代理已关闭，不再接收消息。
  status [id] [--owner 会话id] [--json] [--limit N]    查看状态
  log    <id> [--tail N] [--full] [--json]            查看工作过程
  result <id>                                         输出最终回答
  wait   <id> [--timeout 秒]                          等它做完并输出最终回答
  stop   <id>                                         停止
  models [--json]                                     列出 config.json 里的模型别名
  models --pi [搜索词]                                 列出 pi 认识的模型（pi --list-models）
  accounts [reset [提供方]]                            查看/重置轮换池的冷却
  usage  [--days N | --since 2026-11-01] [--by provider|model|alias|day|workflow] [--json]
                                                      用了多少 token（默认：最近 7 天，按提供方和模型）
  apply  <id> [--check] [--3way]                      把 --worktree 代理的分支应用到你的工作区
                                                      （--check 只检查；--3way 合并，冲突处留标记）
  clean  [id...] [--days N] [--branches] [--dry-run]  删除已结束的运行（默认：早于 keepRunsDays 天的）
                                                      和它们的 worktree；--branches 连 pi/<id> 分支一起删
  paths                                               输出运行目录等路径（JSON）
  flow run --owner 会话id (--script-file 脚本 | --stdin-json) [--args JSON | --args-file 文件]
           [--resume 旧工作流编号] [--cwd 目录] [--wait] [--json] [--dry-run]
         启动 pi 工作流（脚本写法同 Claude Code 的 Workflow：meta、agent、pipeline、parallel、phase、log、args，另有 sh）。
         必须先由用户在该会话里输入 /pi flow 开启。--stdin-json 从标准输入读 {script|scriptPath, args, resume, cwd, dryRun}。
         --dry-run：用假代理把脚本走一遍（agent() 按 schema 造样例数据；sh() 只执行标了 readonly: true 的），
         报告脚本错误、真跑会启动哪些代理、返回值。什么都不启动。
  flow enable|disable --session 会话id                 开关某个会话的工作流（由插件调用）
配置：${CONFIG_FILE}
运行目录：${RUNS}
语言：中文（config.json 里 "language": "en" 或 PISUB_LANG=en 切换为英文）`;

const [cmd, ...rest] = process.argv.slice(2);
// Completion notices that could not go into Claude's own temp folder are written to HOME/notify/<session>/;
// they are only read once, so anything older than a week can go
function cleanNotices() {
  const root = path.join(HOME, 'notify');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return; }
  const old = now() - 7 * 86400000;
  for (const d of dirs) {
    const dir = path.join(root, d);
    try {
      for (const f of fs.readdirSync(dir)) {
        const file = path.join(dir, f);
        try { if (fs.statSync(file).mtimeMs < old) fs.unlinkSync(file); } catch {}
      }
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch {}
  }
}
// The mod asks for these once per session. `tmp` is where it looks for Claude Code's per-project temp folder
// (the completion notices go there, so reading them needs no permission prompt).
const cmdPaths = () => {
  cleanNotices();
  let real = '';
  try { real = fs.realpathSync(os.tmpdir()); } catch {}
  const tmp = [...new Set([os.tmpdir(), real].filter(Boolean))];
  let fallback = true;
  try { fallback = loadConfig().noticeFallback !== false; } catch {}
  out(JSON.stringify({ home: HOME, runs: RUNS, config: CONFIG_FILE, pisub: SELF, node: process.execPath, lang: language(), tmp, noticeFallback: fallback }));
};
const table = {
  paths: cmdPaths,
  spawn: cmdSpawn,
  send: cmdSend,
  status: cmdStatus,
  log: cmdLog,
  result: cmdResult,
  wait: cmdWait,
  stop: cmdStop,
  models: cmdModels,
  accounts: cmdAccounts,
  usage: cmdUsage,
  flow: cmdFlow,
  apply: cmdApply,
  clean: cmdClean,
  _serve: cmdServe,
  _flow: cmdFlowServe,
};
const HELP = L(HELP_EN, HELP_ZH);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') out(HELP);
else if (!table[cmd]) die(`${L('unknown command', '不认识的命令')}: ${cmd}\n${HELP}`);
else {
  mkdirp(RUNS);
  if (process.platform !== 'win32') try { fs.chmodSync(HOME, DIR_MODE); } catch {}
  await table[cmd](rest);
}
