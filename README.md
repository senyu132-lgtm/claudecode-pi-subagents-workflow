<div align="center">

# claudecode-pi-subagents-workflow

**Background sub-agents and multi-agent workflows for Claude Code that run on other models, so the grunt work doesn't eat your Claude quota.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?style=for-the-badge)](https://claude.com/claude-code)
[![Built with Claude Opus 5.5](https://img.shields.io/badge/built%20with-Claude%20Opus%205.5-8A63D2?style=for-the-badge)](https://www.anthropic.com/claude)
[![Powered by pi](https://img.shields.io/badge/powered%20by-pi-2EA44F?style=for-the-badge)](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
<br>
![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![EN · 中文](https://img.shields.io/badge/i18n-EN%20%C2%B7%20%E4%B8%AD%E6%96%87-blue)
![MIT](https://img.shields.io/badge/license-MIT-yellow)

**English** · [简体中文](README.zh-CN.md)

</div>

> [!NOTE]
> I ([senyu132-lgtm](https://github.com/senyu132-lgtm)) made this plugin with [Claude Code](https://claude.com/claude-code) running **Claude Opus 5.5**. The design, the code, the tests and these docs were all done in Claude Code sessions.

## Why I built it

Claude Code's sub-agents and dynamic workflows are great, but on a **Claude Pro** plan they burn through the quota fast. Every sub-agent runs on the same quota as your main chat, so a workflow that fans out to ten agents can use up a whole session's worth in one go. A lot of people I know are on Pro and basically can't use these features the way they're meant to be used.

At the same time, much of that delegated work doesn't need Claude. Fixing a pile of failing tests, cleaning up a messy dataset, pulling summary numbers out of a folder of spreadsheets: a decent model with clear instructions does this fine.

So this plugin splits the work. Claude keeps the parts that need its judgment: planning, breaking the work down, design, and reviewing what comes back. The rest goes to [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), an open-source coding agent that can run on whatever model you have: a ChatGPT subscription, DeepSeek, OpenRouter, Gemini, a local model, and so on. I tried to make pi agents behave as close to native sub-agents as possible, so Claude uses them the same way, and a lot of what used to cost Claude quota now costs whatever your other model costs.

## What it does

- **Claude only gets the result.** Claude starts an agent with `spawn` and keeps working. When the agent finishes, Claude gets one message with its final answer. Everything in between (tool calls, file reads, reasoning) stays on disk, so Claude's context doesn't fill up with it and the main conversation lasts longer.
- **Workflows.** After you type `/pi flow`, Claude can write a short script that runs many agents. The script format follows Claude Code's own Workflow scripts (`agent`, `pipeline`, `parallel`, `phase`), and adds a few things: answers can be checked against a JSON Schema (the agent is asked to redo it if they don't match), `sh()` runs your own check scripts, each model gets its own concurrency limit, and a re-run reuses the results of steps that didn't change.
- **You can watch and talk to them.** `/pi` opens a panel with all the agents. Click one to see what it's doing right now. Type into it to give it extra instructions, or to make a finished agent continue.
- **Any model, mixed in one job.** Give your models short names in a config file, for example `brain` for a strong one and `worker` for a cheap one, and use both in the same workflow.
- **It keeps going.** Every agent runs in its own background process, so it isn't killed when Claude Code restarts. If a provider says you've hit your usage limit, the agent can switch to another account and continue where it stopped. Rate limits and overloads are retried with increasing waits.
- **It costs nothing when you don't use it.** Nothing starts until the first use. The tools are deferred, which means their descriptions aren't even in Claude's context until Claude looks them up.
- **pi is a good worker for this.** pi starts from a short base prompt and a small set of tools, and by default the plugin runs it without loading your CLAUDE.md or AGENTS.md. Nearly all of its context goes to the task Claude gave it.
- **English and Chinese.** The CLI, the panel and the notifications can be switched to Chinese with one setting.

### Compared with native sub-agents

| | Native Claude Code | This plugin |
|---|---|---|
| Who pays for the sub-agents | Your Claude plan | Any provider pi supports, including subscriptions you already have |
| Which models | Claude models | Any model pi can use, mixed freely in one workflow |
| Main conversation stays clean | Yes | Yes, only final answers come back |
| Scripted multi-agent workflows | Yes | Yes, same script style, plus `sh()` checks and cached re-runs |

They work fine side by side. Give the work that needs Claude-level judgment to native sub-agents and the rest to pi.

## Quick start

### 1. Install pi and sign in

You need Node.js 18 or newer.

```bash
npm install -g @earendil-works/pi-coding-agent
pi
```

Inside pi, type `/login`, pick a provider and follow the steps (a browser sign-in for subscriptions, or an API key). Then check that pi can see some models:

```bash
pi --list-models
```

### 2. Install the plugin

At the Claude Code prompt:

```text
/plugin install pi-subagents --marketplace senyu132-lgtm/claudecode-pi-subagents-workflow
```

Answer `y` when it asks to add the marketplace, then choose a scope (the default, user scope, makes it available in all your projects).

Or from a terminal:

```bash
claude plugin install pi-subagents --marketplace senyu132-lgtm/claudecode-pi-subagents-workflow
```

In the desktop app, click **+** next to the prompt box, then **Plugins → Add marketplace**, enter `senyu132-lgtm/claudecode-pi-subagents-workflow`, and add **pi-subagents**.

### 3. Try it

Start a new Claude Code session and ask something like:

> Use a pi sub-agent to find all the TODO comments in this repo and group them by file.

Claude starts an agent and tells you it's running. Type `/pi` to watch it. When it's done, Claude receives the answer and carries on.

Without a config file, pi uses its own default model (the one you last picked in pi). To give Claude several models to choose from, set up a config file as described below.

## Everyday use

**Just ask Claude.** You don't have to name tools. "Hand this to pi", "split this across a few pi agents and review what comes back", or "let a cheap model do the first pass" all work. Claude has been told to keep planning and design work for itself and to send well-defined jobs to pi.

**The `/pi` panel**
- By default it lists the agents started in this session. **Show all** also shows agents from other sessions and from the command line.
- Click an agent to see its live output: messages, tool calls, errors, and what it's typing right now.
- Type in the box at the bottom. While the agent is running, your message is passed to it after its current step. If it has finished, it continues the same conversation, and Claude gets the new result when it's done.
- **Stop** stops it. For a workflow, the panel shows the current phase and every agent inside it; click one to open it.

**Workflows are off until you turn them on.** Type `/pi flow` in a session to allow them there, and `/pi flow off` to turn them off. This is on purpose: a workflow can start dozens of agents, so it only happens when you've said yes. The setting is remembered if you resume the session later.

**When a result looks wrong**, ask Claude to check the agent's log, or open it in the panel. The full record is always kept on disk.

## Security

Please read this before handing out real work.

- **pi agents don't ask before acting.** pi reads and writes files and runs shell commands with its own tools. Those don't go through Claude Code's permission prompts, permission rules or safety checks, so an agent can change or delete files and run commands without asking you first. Claude Code's permission settings don't apply to it.
- **Workflows run commands too.** A workflow script has no file or Node APIs of its own, but that is not a security boundary: `sh()` runs real commands on your machine, and every agent the script starts has the same tools as above.
- **What you can do about it:**
  - For jobs that only need to look (reviews, searches, analysis), use read-only mode: Claude can pass `readonly: true`, or use `--readonly` on the CLI. The agent then only gets pi's `read`, `grep`, `find` and `ls` tools.
  - Point `cwd` at the folder the job needs rather than your home folder.
  - Work in a git repository and commit before a big job, so you can see and undo what the agents changed.
  - Read workflow scripts before you let them run on anything important. Claude shows the script path when it starts one.
- **Where your data goes.** Whatever an agent reads is sent to the model provider you set up in pi. The plugin itself has no server and sends nothing anywhere else.

## Configuration

The config file is `~/.pi-subagents/config.json`. You don't need one at all; it just lets you name your models and tune a few things. Example:

```jsonc
{
  "language": "en",
  "defaultAlias": "worker",
  "aliases": {
    "brain":  { "providers": ["openai-codex", "openai-codex-2"], "model": "gpt-5.1-codex", "thinking": "high" },
    "worker": { "provider": "openrouter", "model": "deepseek/deepseek-chat", "thinking": "low" }
  },
  "flowConcurrency": { "brain": 3, "worker": 8, "default": 4 },
  "flowStaggerMs": { "worker": 1000 }
}
```

The provider and model names here are only examples. Run `pi --list-models` (or `pisub models --pi`) to see yours.

Every setting:

| Key | What it does | Default |
|---|---|---|
| `language` | `en` or `zh`, for the CLI, the panel and notifications. The `PISUB_LANG` environment variable overrides it. | `en` |
| `defaultAlias` | The alias used when Claude doesn't name a model. Empty means pi's own default model. | `""` |
| `aliases.<name>.provider` | The pi provider to use, e.g. `openrouter`. | |
| `aliases.<name>.providers` | A list of providers that serve the same model, used in order. See below. | |
| `aliases.<name>.model` | The model ID. | |
| `aliases.<name>.thinking` | Reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. | pi's default |
| `contextFiles` | `true` lets pi read AGENTS.md / CLAUDE.md files like it normally does. | `false` |
| `exhaustedCooldownMin` | How many minutes an account is skipped after a usage-limit error that doesn't say when it resets. | `60` |
| `overloadBackoffSec` | Wait times (seconds) between retries when the service is overloaded, after pi's own retries have failed. | `[20,40,80,160,300,300]` |
| `flowConcurrency` | In workflows, how many agents of each alias may run at once. `default` covers the rest. | `{"default": 4}` |
| `flowStaggerMs` | In workflows, the minimum gap between starting two agents of the same alias. Helps with providers that dislike bursts. | `{}` |

**Several accounts for one model (`providers`).** If you have more than one account with a provider, set each up in pi as its own provider (pi's docs on `models.json` and custom providers explain how), then list them under `providers`. When one account hits its usage limit, the agent switches to the next one and carries on. An exhausted account is skipped by every agent until it resets; `pisub accounts` shows which are resting and `pisub accounts reset` clears that.

Claude can see your aliases (the `status` tool with `models=true`), so you can just say "use brain for this one".

## Workflows

Turn them on with `/pi flow` first. After that you can ask Claude for something like "go through these 30 sales files with worker, get the monthly totals and flag odd rows, have brain double-check each report, then run my check script", and Claude will write and start a script like this one:

```js
export const meta = {
  name: 'sales-review',
  description: 'analyze each file with a cheap model, double-check with a strong one',
  phases: [{ title: 'Analyze' }, { title: 'Review' }],
}
const Verdict = { type: 'object', properties: { ok: { type: 'boolean' }, why: { type: 'string' } }, required: ['ok'] }

phase('Analyze')
const results = await pipeline(args.files,
  f => agent(`Read ${f}. Report the row count, revenue per month and any rows that look wrong. Don't edit the file.`,
             { model: 'worker', readonly: true, label: `analyze ${f}` }),
  (report, f) => agent(`Data file: ${f}\nReport:\n${report}\nRecompute the numbers from the file. Is the report right?`,
                       { model: 'brain', readonly: true, phase: 'Review', schema: Verdict, label: `review ${f}` }))

phase('Review')
const lint = await sh(['python', 'check_totals.py'])
return { results, lint: lint.stdout }
```

What's available in a script:

| | |
|---|---|
| `agent(prompt, options)` | Runs one pi agent and returns its final answer. Options: `model`, `label` (name shown in the panel), `phase`, `readonly`, `cwd`, `thinking`, `schema`. With `schema`, the answer must be JSON matching it; if it doesn't, the agent is asked to fix it (twice at most). Returns `null` if the agent fails. |
| `pipeline(items, step1, step2, ...)` | Sends each item through the steps on its own, without waiting for the other items. Each step gets `(previous result, original item, index)`. If a step throws or returns `null`, that item ends as `null`. |
| `parallel([() => ..., ...])` | Runs everything at once and waits for all of it. Anything that throws becomes `null`. |
| `sh(command, {cwd, timeoutSec, input})` | Runs a command and returns `{code, stdout, stderr}`. A string runs in bash (Git Bash on Windows); an array like `['python', 'x.py']` runs the program directly. |
| `phase(title)`, `log(text)`, `args` | Mark the current phase, write a line to the workflow log, read the input passed in at start. |
| `meta` | Name, description and phases. Must be plain values. `meta.concurrency` can override the concurrency limits. |

The script runs in a background process. Claude isn't notified about each agent, only once at the end, with whatever the script returns. If you change the script and run it again with `resume`, every `agent()` call whose prompt and options didn't change takes its old result from the cache, and only the changed or new ones run.

## Command line

The plugin comes with a CLI, `pisub`, that does everything without Claude. It's handy for scripts and batch jobs:

```bash
pisub spawn --model worker --cwd . --task-file task.md --wait   # run an agent and print only its final answer
pisub spawn --model brain "Review src/auth.ts for bugs"          # start it and print its id right away
pisub status                                                     # list agents
pisub log <id>                                                   # what it did
pisub send <id> "also cover the edge cases"                      # add instructions, or make a finished agent continue
pisub wait <id>                                                  # wait for it and print the answer
pisub stop <id>
pisub models                                                     # your aliases (--pi lists every model pi knows)
pisub accounts                                                   # accounts resting after a usage limit
pisub help
```

`pisub` means `node <plugin folder>/bin/pisub.mjs`. The plugin folder is usually `~/.claude/plugins/cache/claudecode-pi-subagents-workflow/pi-subagents/<version>/`, and a shell alias saves typing. Agents started from the CLI also show up in the panel under **Show all**.

## Where things are stored

Everything lives in `~/.pi-subagents/` (set `PI_SUBAGENTS_HOME` to use another folder):

- `config.json`: your settings
- `accounts.json`: accounts currently resting after a usage limit
- `runs/<id>/`: one folder per agent or workflow, containing `state.json` (status), `task.md` (the task), `view.jsonl` (the condensed log the panel shows), `events.jsonl` (full event stream), `final.md` (final answer), `session/` (pi's own session files), and the logs `serve.log` and `pi-stderr.log`

Old runs aren't deleted automatically. Delete folders under `runs/` whenever you like.

The plugin has no server of its own. Your code and prompts go only to the model provider you set up in pi.

## Troubleshooting

**"cannot find pi's CLI".** pi isn't installed globally, or it's somewhere the plugin doesn't look. Install it with `npm install -g @earendil-works/pi-coding-agent`, or set the `PI_CLI` environment variable to the full path of pi's `cli.js`.

**An agent fails right away.** Open it in the panel or run `pisub log <id>`. Most often the model name isn't one pi knows (check with `pisub models --pi`), or you aren't signed in to that provider. pi's own error output is in `runs/<id>/pi-stderr.log`.

**Claude never gets the result in `claude -p`.** That's expected: a non-interactive run ends with its turn, before any notification arrives. Use the CLI with `--wait` instead.

**Claude says workflows are off.** Type `/pi flow` in that session. It's a per-session switch.

**`sh()` fails on Windows.** String commands need bash, which comes with Git for Windows. If it's installed somewhere unusual, set `PISUB_BASH` to the full path of `bash.exe`. Or pass an array, `sh(['python', 'check.py'])`, which doesn't need a shell.

**The panel shows an agent as an error, but it was still working.** If the background process was killed (for example by a reboot), the agent is marked as failed. Send it a message and it continues from its saved session.

## Limitations

- pi can't see your conversation with Claude. Every task has to say what to do, where, and in what format. Claude is instructed to write tasks that way.
- Results are only as good as the model you choose. Treat answers from cheap models as hints and have a stronger model or Claude check them before you rely on them.
- Notifications need an interactive Claude Code session (terminal or desktop app).
- I've mainly used it on Windows 11. macOS and Linux are handled in the code but haven't been tested as much. Issues and pull requests are welcome.

## Uninstall

```bash
claude plugin uninstall pi-subagents
```

Then delete `~/.pi-subagents/` if you don't want to keep the logs.

## Development

```bash
node --test tests/flow.node-test.mjs   # the workflow engine
claude plugin test .                   # the plugin, against a simulated Claude Code
claude plugin validate .
```

To try your changes without touching your real data, point `PI_SUBAGENTS_HOME` at a scratch folder.

How the pieces fit together:

```mermaid
flowchart LR
    U([You]) <--> C[Claude Code]
    C -- "spawn / send / flow" --> M[plugin]
    M -- "final answers only" --> C
    M <--> P["/pi panel"]
    M --> S[pisub]
    S --> B1[background process] --> R1["pi --mode rpc"] --> X1[(model)]
    S --> B2[background process] --> R2["pi --mode rpc"] --> X2[(model)]
    S --> W[workflow runner] --> B1 & B2
    B1 & B2 & W -.-> D[("~/.pi-subagents/runs")]
```

- `hooks/register.tsx`: the Claude Code side. It registers the tools, draws the panel and sends the notifications.
- `bin/pisub.mjs`: the CLI and the background process that drives `pi --mode rpc` for each agent, including account switching and retries.
- `bin/flow.mjs`: the workflow engine: runs the script in its own context (Node's `vm`, which is not a security boundary), handles concurrency, schema checks and the resume cache.
- `bin/i18n.mjs`: English/Chinese strings.

## Credits

- Made by [senyu132-lgtm](https://github.com/senyu132-lgtm) with [Claude Code](https://claude.com/claude-code) running Claude Opus 5.5.
- Built on [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
- Not affiliated with Anthropic or the pi project.

## License

[MIT](LICENSE)
