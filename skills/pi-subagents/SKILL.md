---
name: pi-subagents
description: Load before handing work to pi sub-agents (the pi coding agent running other models in the background); loading it wakes this session's pi tools and completion notifications.
---

# pi sub-agents

pi (a lean coding agent that can run almost any model) is wrapped as background agents that behave much like Claude Code's native sub-agents:
- they run in the background and you are notified automatically when they finish, with **only the final answer**;
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
| `spawn` | Hand out a task; returns an id immediately. Params: `task` (required, self-contained), `model` (alias or provider/model), `name`, `cwd`, `readonly`, `thinking` |
| `send` | Message an agent: while running it is a steer (`mode=follow_up` queues it after the current task); after it finished it resumes its previous session |
| `status` | Status. `models=true` lists the model aliases the user configured |
| `log` | Its transcript (only for debugging; it enters your context) |
| `result` | Its final answer (only if a notification got lost) |
| `stop` | Stop it |

- Do not poll after spawning and do not watch it with `log`. A `[pi sub-agent notification]` arrives by itself.
- Notifications are merged: results that land close together share one; while you are working they wait until your turn ends.
- `claude -p` (headless) exits at the end of the turn and never sees notifications. Use the CLI with `--wait` there.
- The user can watch any agent live in the `/pi` pane and talk to it; their messages are labeled "You".

### 2. CLI (batch workers, `claude -p`, sessions without the plugin)

```bash
node "{{PISUB}}" spawn --model <alias> --cwd <dir> --task-file <instructions file> --wait
```
- `--wait`: wait until it finishes and print only the final answer to stdout. Good inside a background shell command, which notifies you when it ends.
- Without `--wait`: prints the id right away; later use `pisub wait <id>` or `pisub result <id>`.
- Other commands: `send`, `status`, `log`, `stop`, `models`, `accounts`, `help`.
- Agents started from the CLI also show up under "Show all" in the `/pi` pane.
- The script gets the result, so the plugin does not notify. Exception: if the user resumes a finished agent from the pane, it is adopted into this session and you are notified when it is done.

## Workflows (the user must type /pi flow first)
- Off by default in every session. Only after the user types `/pi flow` in this session does the tool `mcp__pi-subagents__flow` exist (deferred; fetch it with ToolSearch).
- It stays on when this session restarts or is resumed; `/pi flow off` turns it off.
- If it is off, do not use it and do not fall back to the CLI: `pisub flow run` refuses too. You may suggest the user turn it on.
- Good for multi-step orchestration with loops, branches or fan-out, e.g. "N data files: cheap model analyzes each → a script checks the numbers → strong model reviews each report → disputed ones get redone".
- Written like Claude Code's Workflow scripts: `meta`, `agent`, `pipeline`, `parallel`, `phase`, `log`, `args`, plus `sh` for checking scripts. Details are in the tool description. Plain JavaScript.
- You are notified once, with the script's return value; agents inside are not reported one by one.
- Resume: pass the old workflow id as `resume`; unchanged `agent()` calls come from the cache.
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

## Writing tasks
- pi cannot see this conversation. Put paths, goal, constraints and output format in the task.
- Put long instructions in a file and make the task "read <file> first".
- Ask for machine-checkable output and keep a checking script, so cut corners show up.

## Where things are
- Each agent's run directory is `~/.pi-subagents/runs/<id>/`:
  - `state.json`: status
  - `view.jsonl`: condensed transcript
  - `events.jsonl`: full event stream
  - `final.md`: final answer
  - `session/`: pi's session files
  - `serve.log`, `pi-stderr.log`: broker and pi logs
- Config: `~/.pi-subagents/config.json`. Provider cooldowns: `~/.pi-subagents/accounts.json`.
