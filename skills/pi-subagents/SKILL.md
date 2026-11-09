---
name: pi-subagents
description: Load before handing work to pi sub-agents (the pi coding agent running other models in the background); loading it wakes this session's pi tools and completion notifications.
---

# pi sub-agents

pi (a lean coding agent that can run almost any model) is wrapped as background agents that behave much like Claude Code's native sub-agents:
- they run in the background and you are notified automatically when they finish (as a background-task notice, like a finished background Bash command), with **only the final answer**;
- their transcripts stay on disk, out of your context, until you ask for them;
- you and the user can both add instructions mid-way.

Use them to save the user's Claude quota: you plan, split, review and decide; pi does well-specified legwork.

## Waking up and loading the tools
- The plugin is dormant by default: no process and no polling at session start.
- Loading this skill, the first pi tool call, or the user typing `/pi` wakes it.
- The tools are deferred. Fetch them with ToolSearch before use: `select:mcp__pi-subagents__spawn,mcp__pi-subagents__send,mcp__pi-subagents__status,mcp__pi-subagents__log,mcp__pi-subagents__result,mcp__pi-subagents__stop` (only the ones you need).

## Two ways to use it

### 1. Tools (preferred in interactive sessions)

| Tool | What it does |
|---|---|
| `spawn` | Hand out a task; returns an id immediately. Params: `task` (required, self-contained), `model` (alias or provider/model), `name`, `cwd`, `readonly`, `thinking`, `isolation` (`'worktree'`: edits go to its own branch) |
| `send` | Message a running agent. `mode`: `steer` (default) arrives after the current step (one reply plus the tools it called), usually seconds to tens of seconds; `interrupt` stops the current step at once (a half-written reply or half-run command is dropped) and carries on with the new message in the same session, for when it is heading the wrong way; `follow_up` waits until the current task is done. A finished agent takes no more messages |
| `status` | Status. `models=true` lists the model aliases the user configured |
| `log` | Its transcript (only for debugging; it enters your context) |
| `result` | Its final answer (only if a notification got lost) |
| `stop` | Stop it |

- Do not poll after spawning and do not watch it with `log`. When it is done you get a background-task notice: `Background command "pi sub-agent <name> done" completed`. Read the output-file it names: it holds `[pi sub-agent results]` and each agent's `<pi-result>`. If you can't read it (a permission prompt), fetch the answer with `result` by id.
- An agent is closed once it has given its final answer (`send` is refused). To carry on, `spawn` a new one and put the context it needs, and the old result, into the task.
- That notice is a background command the plugin starts itself (it only prints the results file). You didn't start it and the user didn't say it.
- Notifications are merged: results that land close together share one. While you are working, the engine queues it like any other background task.
- Rarely (no Bash/PowerShell in the session, or the background command was refused) it falls back to a `[pi sub-agent notification, not a user message]` message with the same content. If the user set `noticeFallback: false`, it never falls back: the results wait, and a line above the prompt tells the user, who can retry.
- `claude -p` (headless) exits at the end of the turn and never sees notifications. Use the CLI with `--wait` there.
- The user can watch any agent live in the `/pi` pane and talk to it; their messages are labeled "You".

### 2. CLI (batch workers, `claude -p`, sessions without the plugin)

```bash
node "{{PISUB}}" spawn --model <alias> --cwd <dir> --task-file <instructions file> --wait
```
- `--wait`: wait until it finishes and print only the final answer to stdout. Good inside a background shell command, which notifies you when it ends.
- Without `--wait`: prints the id right away; later use `pisub wait <id>` or `pisub result <id>`.
- Other commands: `send`, `status`, `log`, `stop`, `models`, `accounts`, `usage` (tokens and cost; `--by provider|model|alias|day|workflow`, `--days N`), `apply <id>` (bring a worktree agent's branch into the user's files; `--check` first), `clean`, `help`.
- Agents started from the CLI also show up under "Show all" in the `/pi` pane.
- The script gets the result, so the plugin does not notify.

## Workflows (the user must type /pi flow first)
- Off by default in every session. Only after the user types `/pi flow` in this session does the tool `mcp__pi-subagents__flow` exist (deferred; fetch it with ToolSearch).
- It stays on when this session restarts or is resumed; `/pi flow off` turns it off.
- If it is off, do not use it and do not fall back to the CLI: `pisub flow run` refuses too. You may suggest the user turn it on.
- Good for multi-step orchestration with loops, branches or fan-out, e.g. "N data files: cheap model analyzes each → a script checks the numbers → strong model reviews each report → disputed ones get redone".
- Written like Claude Code's Workflow scripts: `meta`, `agent`, `pipeline`, `parallel`, `phase`, `log`, `args`, plus `sh` for checking scripts. Details are in the tool description. Plain JavaScript.
- Before a large or expensive workflow, run it once with `dryRun: true`: no model is called and nothing starts. `agent()` returns sample data from its schema, and `sh()` runs only commands marked `readonly: true` (mark your check scripts that way). The report gives script errors with line numbers, the agents a real run would start per model and phase, and problems such as unknown aliases. Fix what it finds, then run for real.
- You are notified once, with the script's return value; agents inside are not reported one by one. The summary on top includes the tokens used and "Worth a second look": agents that finished far faster, called no tool, wrote far less or copied another answer, compared with their phase and model. Spot-check those first.
- Failures: a failed agent returns `null` and the final notification lists every failure with its reason. Use `retries`, `required: true` or `meta.failFast: true` when a missing result must not pass silently. Always `await` agent() and sh().
- Agents that edit files in parallel: give them `isolation: 'worktree'`; their branches are listed at the end and applied with `pisub apply <id>`.
- Resume: pass the old workflow id as `resume`; unchanged `agent()` calls come from the cache. Give `inputs` for the files an agent reads so changes to them re-run it; `sh(cmd, { cache: true })` is not re-run once it succeeded.
- Debugging: `status <workflow id>` lists its agents; `log` shows the workflow's narration or one agent's transcript.

## Choosing a model
- `status` with `models=true` (or `pisub models`) lists the aliases the user configured, with the default marked `*`.
- Without `model`, the configured default is used, or pi's own default model if none is configured.
- Any `provider/model` that pi knows also works (`pisub models --pi` lists them).
- Treat conclusions from weaker models as hints and verify them before acting on them.
- Keep planning, task breakdown, architecture and UI/design decisions for yourself.

## Handled automatically
- **Provider pools**: an alias can list several pi providers serving the same model. On a usage-limit error the agent switches to the next one and carries on. Exhausted providers cool down, shared by all agents. `pisub accounts` shows them; `pisub accounts reset [provider]` resets.
- **Overloads**: 429, "overloaded" and the like are retried by pi first, then by the broker with backoff (20 s up to 5 min, 6 times).
- **Session hygiene**: pi does not read the project's CLAUDE.md/AGENTS.md (`--no-context-files`), and stdin is handled for you.
- **Hangs and crashes**: pi not answering, an agent going silent, an endless tool call, or a dead background process all end the agent with an error you are notified about. A message that had not reached pi yet is delivered by a new background process.
- **Machine-wide limit**: at most `maxAgents` (default 16) pi agents run at once; the rest show as queued and start when a slot frees up.
- **Old runs**: finished runs older than `keepRunsDays` (default 30) are deleted.

## Writing tasks
- pi cannot see this conversation. Put paths, goal, constraints and output format in the task.
- Put long instructions in a file and make the task "read <file> first".
- Ask for machine-checkable output and keep a checking script, so cut corners show up.
- Ask for a short final answer (a summary, counts, file paths) and have bulky output written to files. The final answer is all that enters your context, so keep it small and read the files only when you need them.

## Where things are
- Each agent's run directory is `~/.pi-subagents/runs/<id>/`:
  - `state.json`: status
  - `view.jsonl`: condensed transcript
  - `events.jsonl`: full event stream
  - `final.md`: final answer
  - `session/`: pi's session files
  - `journal.jsonl`: a workflow's results (for resume); `wt/`: an isolated agent's worktree
  - `serve.log`, `pi-stderr.log`: broker and pi logs
- Config: `~/.pi-subagents/config.json`. Provider cooldowns: `~/.pi-subagents/accounts.json`. Usage ledger: `~/.pi-subagents/usage/<year-month>.jsonl` (read it with `pisub usage`).
