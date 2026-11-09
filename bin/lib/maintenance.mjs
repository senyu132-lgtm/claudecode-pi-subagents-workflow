// pisub apply (bring an isolated agent's branch in) and cleaning up old runs.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, RUNS, TERMINAL, die, loadConfig, now, out, parseArgs, writePrivate } from './core.mjs';
import { checkId, hasInbox, isServing, readState, runDir } from './runs.mjs';
import { L } from '../i18n.mjs';
import { git, gitOut } from './git.mjs';

// ---------- applying an isolated agent's work, and removing old runs ----------
// pisub apply <id> [--check] [--3way]: bring an agent's branch into the repository it was started from.
// Plain apply changes only the working tree and refuses as a whole when anything conflicts; --3way merges what
// it can and leaves conflict markers (like git apply --3way, it also stages the result).
export function cmdApply(argv) {
  const o = parseArgs(argv, ['check', '3way']);
  const id = checkId(o._[0]);
  const w = readState(id).worktree;
  if (!w) die(L(`${id} did not work in a worktree, so there is nothing to apply (its changes are already in its folder)`, `${id} 不是在 worktree 里工作的，没有要应用的东西（它的改动本来就在它的目录里）`));
  const ref = `refs/heads/${w.branch}`;
  if (!git(w.root, ['rev-parse', '--verify', '-q', ref]).ok) die(L(`branch ${w.branch} no longer exists in ${w.root}`, `${w.root} 里已经没有分支 ${w.branch}`));
  const diff = git(w.root, ['diff', '--binary', '--no-color', '--no-ext-diff', w.base, ref], { raw: true });
  if (!diff.ok) die(diff.err);
  if (!diff.out.length) return out(L(`${w.branch} has no changes; nothing to apply`, `${w.branch} 没有改动，不用应用`));
  const files = (gitOut(w.root, ['diff', '--name-only', w.base, ref]) || '').split('\n').filter(Boolean);
  const args = ['apply', '--binary', '--whitespace=nowarn', ...(o.check ? ['--check'] : []), ...(o['3way'] ? ['--3way'] : [])];
  const r = git(w.root, args, { input: diff.out });
  const list = files.slice(0, 30).map(f => `  ${f}`).join('\n') + (files.length > 30 ? '\n  …' : '');
  if (!r.ok) {
    if (r.err) process.stderr.write(r.err + '\n');
    die(
      o['3way']
        ? L(`merged ${w.branch} into ${w.root} with conflicts: fix the conflict markers in the files listed above`, `已把 ${w.branch} 合入 ${w.root}，但有冲突：请处理上面列出的文件里的冲突标记`)
        : L(
            `${w.branch} does not apply cleanly to ${w.root}${o.check ? '' : ', so nothing was changed'}. Your files have moved on since the agent started. Options: pisub apply ${id} --3way (merge, leaving conflict markers), or review with git -C "${w.root}" diff ${w.base.slice(0, 12)} ${w.branch}`,
            `${w.branch} 不能干净地应用到 ${w.root}${o.check ? '' : '，所以什么都没改'}。代理开始之后你的文件又改过了。可以：pisub apply ${id} --3way（合并，冲突处留下标记），或者用 git -C "${w.root}" diff ${w.base.slice(0, 12)} ${w.branch} 查看`
          )
    );
  }
  if (o.check) return out(L(`${w.branch} applies cleanly to ${w.root} (${files.length} ${files.length === 1 ? 'file' : 'files'}):\n${list}`, `${w.branch} 可以干净地应用到 ${w.root}（${files.length} 个文件）：\n${list}`));
  out(
    L(
      `Applied ${w.branch} to ${w.root} (${files.length} ${files.length === 1 ? 'file' : 'files'}, not committed):\n${list}\nThe branch is kept; remove it with pisub clean ${id} --branches`,
      `已把 ${w.branch} 应用到 ${w.root}（${files.length} 个文件，没有提交）：\n${list}\n分支还保留着，不需要了用 pisub clean ${id} --branches 删除`
    )
  );
}

// Remove finished runs: their folders (task, transcript, tool output) and worktrees. Branches with changes are
// kept unless branches is set, since they may hold work nobody applied yet.
export function cleanRuns({ days = 0, ids = null, dryRun = false, branches = false } = {}) {
  const cutoff = now() - days * 86400000;
  let names = ids;
  if (!names) {
    try { names = fs.readdirSync(RUNS); } catch { names = []; }
  }
  const removed = [];
  const busy = [];
  const kept = [];
  for (const id of names) {
    const st = readState(id);
    if (!st) continue;
    if (!TERMINAL.has(st.status) || isServing(id) || hasInbox(id)) {
      if (ids) busy.push(id);
      continue;
    }
    if (!ids && (st.finishedAt || st.updatedAt || st.createdAt || 0) > cutoff) continue;
    removed.push(id);
    if (dryRun) continue;
    const w = st.worktree;
    const repo = w && fs.existsSync(w.root);
    if (repo && fs.existsSync(w.dir) && !git(w.root, ['worktree', 'remove', '--force', w.dir]).ok) {
      try { fs.rmSync(w.dir, { recursive: true, force: true }); } catch {}
      git(w.root, ['worktree', 'prune']);
    }
    if (repo && git(w.root, ['rev-parse', '--verify', '-q', `refs/heads/${w.branch}`]).ok) {
      // A branch that could not be deleted is listed as kept, so it is not left behind unnoticed
      if (!branches || !git(w.root, ['branch', '-q', '-D', w.branch]).ok) kept.push(`${w.branch} (${w.root})`);
    }
    try { fs.rmSync(runDir(id), { recursive: true, force: true }); } catch {}
    if (repo) git(w.root, ['worktree', 'prune']);
  }
  return { removed, busy, kept };
}
export function cmdClean(argv) {
  const o = parseArgs(argv, ['dry-run', 'branches', 'json']);
  const ids = o._.length ? o._.map(checkId) : null;
  const days = o.days !== undefined ? Number(o.days) : Number(loadConfig().keepRunsDays) || 0;
  if (!ids && !(days >= 0)) die(L('--days must be a number of days', '--days 必须是天数'));
  if (!ids && !days && o.days === undefined) die(L('keepRunsDays is 0 in config.json, so say how old with --days N (0 = every finished run)', 'config.json 里 keepRunsDays 是 0，请用 --days N 指定多少天以前的（0 = 所有已结束的）'));
  const r = cleanRuns({ days, ids, dryRun: !!o['dry-run'], branches: !!o.branches });
  if (o.json) return out(JSON.stringify(r));
  out(
    o['dry-run']
      ? L(`Would remove ${r.removed.length} finished ${r.removed.length === 1 ? 'run' : 'runs'}`, `将删除 ${r.removed.length} 个已结束的运行`)
      : L(`Removed ${r.removed.length} finished ${r.removed.length === 1 ? 'run' : 'runs'}`, `已删除 ${r.removed.length} 个已结束的运行`)
  );
  if (r.busy.length) out(L(`Not finished, left alone: ${r.busy.join(', ')}`, `还没结束，没动：${r.busy.join('、')}`));
  if (r.kept.length) out(L(`Branches kept (they may hold changes nobody applied; add --branches to delete them):\n  `, `保留的分支（里面可能有还没应用的改动；加 --branches 一起删）：\n  `) + r.kept.join('\n  '));
}
// Once a day a broker, on its way out, removes runs older than keepRunsDays (0 turns this off)
export function maybeAutoClean() {
  const days = Number(loadConfig().keepRunsDays) || 0;
  if (days <= 0) return;
  const mark = path.join(HOME, 'last-clean');
  try {
    if (now() - fs.statSync(mark).mtimeMs < 86400000) return;
  } catch {}
  try {
    writePrivate(mark, String(now()));
    cleanRuns({ days });
  } catch {}
}
