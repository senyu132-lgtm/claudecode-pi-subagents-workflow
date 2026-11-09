// Git helpers, the fingerprint of a workflow agent's input files, and worktrees for isolated agents.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { L } from '../i18n.mjs';
import { runDir } from './runs.mjs';
import { sleepSync, trunc } from './core.mjs';

export function minutesFrom(e) {
  const m = /try again in ~?\s*(\d+)\s*min/i.exec(e || '');
  return m ? Math.max(1, Number(m[1])) : null;
}

// ---------- git ----------
export function git(cwd, args, { input, raw } = {}) {
  const r = spawnSync('git', args, { cwd, input, windowsHide: true, maxBuffer: 512 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' });
  return { ok: r.status === 0, out: r.stdout ?? (raw ? Buffer.alloc(0) : ''), err: String(r.stderr || r.error?.message || '').trim() };
}
export const gitOut = (cwd, args) => {
  const r = git(cwd, args);
  return r.ok ? r.out.trim() : null;
};
// Commits made for you use your git identity if you have one. Hooks and signing are skipped: nobody is
// there to type a passphrase, and a slow pre-commit hook should not hold up an agent.
export function gitCommit(cwd, message) {
  const named = gitOut(cwd, ['config', 'user.email']);
  const who = named ? [] : ['-c', 'user.name=pi-subagents', '-c', 'user.email=pi-subagents@localhost'];
  return git(cwd, [...who, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message]);
}

// What the repository around cwd looks like now: HEAD plus a hash of every uncommitted change (path, status,
// size, modification time). Cheap, and writes nothing. null outside a repository.
export function gitSignature(cwd) {
  const root = gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const head = gitOut(root, ['rev-parse', '-q', '--verify', 'HEAD']) || '';
  const st = git(root, ['--no-optional-locks', '-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!st.ok) return null;
  const h = crypto.createHash('sha1');
  const entries = st.out.split('\0').filter(Boolean);
  for (const e of entries) {
    let f = 'x';
    try {
      const s = fs.statSync(path.join(root, e.slice(3)));
      f = `${s.size}:${Math.round(s.mtimeMs)}`;
    } catch {}
    h.update(`${e}\0${f}\n`);
  }
  return { root, head, dirty: entries.length, sig: h.digest('hex').slice(0, 16) };
}

// ---------- workflow inputs: fingerprint of the files an agent reads ----------
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
export const HASH_FULL_MAX = 64 * 1024 * 1024; // bigger files are fingerprinted by size and modification time
export function hashInputs(paths, cwd) {
  const h = crypto.createHash('sha1');
  let files = 0;
  const walk = (abs, rel) => {
    let s;
    try {
      s = fs.lstatSync(abs);
    } catch {
      return h.update(`missing ${rel}\n`);
    }
    if (s.isSymbolicLink()) return h.update(`link ${rel} ${fs.readlinkSync(abs)}\n`);
    if (s.isDirectory()) {
      h.update(`dir ${rel}\n`);
      for (const name of fs.readdirSync(abs).sort()) if (!SKIP_DIRS.has(name)) walk(path.join(abs, name), `${rel}/${name}`);
      return;
    }
    if (!s.isFile()) return;
    if (++files > 100000) throw new Error(L(`inputs cover more than 100000 files; name narrower paths`, `inputs 涵盖的文件超过 100000 个，请写得更具体`));
    h.update(`file ${rel} ${s.size}\n`);
    if (s.size > HASH_FULL_MAX) h.update(`mtime ${Math.round(s.mtimeMs)}\n`);
    else h.update(fs.readFileSync(abs));
  };
  for (const p of paths) walk(path.resolve(cwd, p), p.replace(/\\/g, '/'));
  return h.digest('hex').slice(0, 16);
}

// ---------- worktrees: agents that change files without touching yours ----------
export const MAX_UNTRACKED = 50 * 1024 * 1024; // untracked files bigger than this are not copied into a worktree

// A new branch pi/<id> checked out under the agent's run directory. It starts from HEAD plus your
// uncommitted changes (edits to tracked files and untracked, non-ignored files), committed on the branch as
// a "snapshot" commit, so the agent sees what you see. Ignored files (node_modules, build output, ignored
// data) are not there. Throws when it cannot be done.
export function createWorktree(id, cwd) {
  const root = gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error(L(`isolation "worktree" needs a working directory inside a git repository (${cwd} is not)`, `isolation "worktree" 要求工作目录在 git 仓库里（${cwd} 不是）`));
  const head = gitOut(root, ['rev-parse', '-q', '--verify', 'HEAD']);
  if (!head) throw new Error(L('isolation "worktree" needs a repository with at least one commit', 'isolation "worktree" 要求仓库里至少有一次提交'));
  const prefix = gitOut(cwd, ['rev-parse', '--show-prefix']) || '';
  const dir = path.join(runDir(id), 'wt');
  const branch = `pi/${id}`;
  let r;
  for (let i = 0; i < 4; i++) {
    r = git(root, ['worktree', 'add', '-q', '-b', branch, dir, head]);
    if (r.ok) break;
    // Another agent may be holding a git lock: clean up the half-made attempt and try again
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    git(root, ['worktree', 'prune']);
    git(root, ['branch', '-q', '-D', branch]);
    sleepSync(300 * (i + 1));
  }
  if (!r.ok) throw new Error(L(`could not create a git worktree: ${r.err}`, `创建 git worktree 失败：${r.err}`));

  const notes = [];
  let staged = false;
  // Edits to tracked files: applied to the index (in git's own line endings), checked out below
  const diff = git(root, ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff'], { raw: true });
  if (diff.ok && diff.out.length) {
    const a = git(dir, ['apply', '--cached', '--binary', '--whitespace=nowarn'], { input: diff.out });
    if (a.ok) staged = true;
    else notes.push(L(`your uncommitted edits to tracked files could not be copied in (${trunc(a.err, 200)})`, `你对已跟踪文件的未提交修改没能复制进来（${trunc(a.err, 200)}）`));
  }
  // Untracked, non-ignored files: copied as they are
  const list = git(root, ['-c', 'core.quotePath=false', 'ls-files', '-o', '--exclude-standard', '-z']);
  const copied = [];
  const skipped = [];
  for (const rel of list.ok ? list.out.split('\0').filter(Boolean) : []) {
    try {
      const src = path.join(root, rel);
      const s = fs.statSync(src);
      if (!s.isFile()) continue;
      if (s.size > MAX_UNTRACKED) {
        skipped.push(rel);
        continue;
      }
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(src, path.join(dir, rel));
      copied.push(rel);
    } catch {}
  }
  if (copied.length) {
    const a = git(dir, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: copied.join('\0') });
    if (a.ok) staged = true;
  }
  if (skipped.length)
    notes.push(L(`untracked files over 50 MB were not copied in: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ' …' : ''}`, `超过 50 MB 的未跟踪文件没有复制进来：${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? ' …' : ''}`));
  let base = head;
  if (staged && !git(dir, ['diff', '--cached', '--quiet']).ok) {
    const c = gitCommit(dir, 'pi-subagents: snapshot of uncommitted changes');
    if (c.ok) {
      base = gitOut(dir, ['rev-parse', 'HEAD']) || head;
      git(dir, ['reset', '-q', '--hard']);
    } else notes.push(L(`your uncommitted changes could not be committed in the worktree (${trunc(c.err, 200)})`, `未提交的修改没能在 worktree 里提交（${trunc(c.err, 200)}）`));
  }
  return { root, dir, branch, head, base, prefix, notes };
}
// Before a round: bring back a worktree removed after an earlier round. Returns an error message or ''.
export function ensureWorktree(w) {
  if (fs.existsSync(w.dir)) return '';
  git(w.root, ['worktree', 'prune']);
  const has = git(w.root, ['rev-parse', '-q', '--verify', `refs/heads/${w.branch}`]).ok;
  let r = git(w.root, has ? ['worktree', 'add', '-q', w.dir, w.branch] : ['worktree', 'add', '-q', '-b', w.branch, w.dir, w.base]);
  // A snapshot commit nothing points to any more may have been garbage-collected: start from HEAD then
  if (!r.ok && !has) {
    r = git(w.root, ['worktree', 'add', '-q', '-b', w.branch, w.dir, w.head]);
    // The branch starts from HEAD now: compare with that from here on, or every change would look like none
    if (r.ok) w.base = w.head;
  }
  return r.ok ? '' : r.err;
}
// After a round: commit what the agent changed on its branch. Returns { changed, stat, error? } or null.
export function commitWorktree(st) {
  const w = st.worktree;
  if (!w || !fs.existsSync(w.dir)) return null;
  // If staging fails the worktree may still hold changes: report that, so it is kept and never removed
  const add = git(w.dir, ['add', '-A']);
  let error = add.ok ? '' : L(`git add failed: ${add.err}`, `git add 失败：${add.err}`);
  if (!error && !git(w.dir, ['diff', '--cached', '--quiet']).ok) {
    const c = gitCommit(w.dir, `pi-subagents: ${st.name || st.id} (round ${(st.rounds || 0) + 1})`);
    if (!c.ok) error = c.err;
  }
  const d = git(w.root, ['diff', '--shortstat', w.base, w.branch]);
  // The base cannot be compared (its snapshot commit is gone): keep the branch rather than call it unchanged
  if (!d.ok && !error) error = L(`could not compare the branch with its base ${String(w.base).slice(0, 12)}: ${d.err}`, `没法把分支和起点 ${String(w.base).slice(0, 12)} 比较：${d.err}`);
  const stat = d.ok ? d.out.trim() : '';
  return { changed: !!stat || !!error, stat, ...(error ? { error: trunc(error, 300) } : {}) };
}
export function removeWorktree(w) {
  if (!git(w.root, ['worktree', 'remove', '--force', w.dir]).ok) {
    try { fs.rmSync(w.dir, { recursive: true, force: true }); } catch {}
    git(w.root, ['worktree', 'prune']);
  }
  git(w.root, ['branch', '-q', '-D', w.branch]);
}
// Tells the agent where it is working. Prepended to its first task.
export function worktreeIntro(w) {
  const here = path.join(w.dir, w.prefix || '');
  return (
    L(
      `(Isolation: you are working in your own git worktree, ${here}, a copy of the repository ${w.root} on branch ${w.branch}. Make every change inside this worktree: when the task names a path under ${w.root}, use the same relative path under ${w.dir}. Do not commit; your changes are committed for review when you finish. Files matched by .gitignore are not committed and are removed with the worktree.`,
      `（隔离说明：你在自己的 git worktree 里工作，目录 ${here}，它是仓库 ${w.root} 的一份拷贝，分支 ${w.branch}。所有修改都在这个 worktree 里做：任务里提到 ${w.root} 下的路径时，改用 ${w.dir} 下相同的相对路径。不要自己提交，你做完后改动会自动提交，供人审查。被 .gitignore 忽略的文件不会提交，会随 worktree 一起删掉。`
    ) +
    (w.notes.length ? ' ' + L('Note: ', '注意：') + w.notes.join(L('; ', '；')) : '') +
    L(')\n\n', '）\n\n')
  );
}
// What happened to an agent's worktree, for its final answer and the notification
export function worktreeReport(w, rep, id) {
  if (!w || !rep) return '';
  w = { ...w, id };
  if (!rep.changed) return L(`(No changes to files git keeps (files matched by .gitignore do not count), so the worktree and branch ${w.branch} were removed.)`, `（没有改动 git 会记录的文件（被 .gitignore 忽略的不算），worktree 和分支 ${w.branch} 已删除。）`);
  const q = `git -C "${w.root}"`;
  const base = w.base.slice(0, 12);
  return L(
    `Changes are committed on branch ${w.branch}${rep.stat ? ` (${rep.stat})` : ''}${rep.error ? `, but the last commit failed: ${rep.error}` : ''}. Worktree: ${w.dir}\n` +
      `  review:  ${q} diff ${base} ${w.branch}\n` +
      `  apply to your working tree:  pisub apply ${w.id}   (check first: pisub apply ${w.id} --check)\n` +
      `  clean up afterwards:  pisub clean ${w.id} --branches`,
    `改动已提交到分支 ${w.branch}${rep.stat ? `（${rep.stat}）` : ''}${rep.error ? `，但最后一次提交失败：${rep.error}` : ''}。worktree：${w.dir}\n` +
      `  查看：  ${q} diff ${base} ${w.branch}\n` +
      `  应用到你的工作区：  pisub apply ${w.id}   （先检查：pisub apply ${w.id} --check）\n` +
      `  用完清理：  pisub clean ${w.id} --branches`
  );
}
