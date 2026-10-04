/**
 * The Sept's facts about a project's git repository (#186, owner decisions
 * 2026-10-02): its branch, and how many commits on it are not yet on its
 * remote. Read from the .git folder as files, through readForDisplay (the one
 * producer of a file body) and the share gate, and never by running git:
 * nothing may need a tool beyond Claude Code, LayerCake and Windows (CLAUDE.md).
 *
 * Errors are values. No .git, a folder that cannot be read, a file caught
 * mid-write or a layout this does not understand each give a state that says
 * so, and the castle shows less; nothing throws (owner: "be prepared to not
 * crash if it is not available").
 *
 * Only these are read: the .git file's `gitdir:` line and `commondir` (a
 * worktree, never followed onto a network share the project is not on, #193), HEAD, the branch's ref (loose, else packed-refs), the config's
 * `[branch "<name>"]` section for its upstream, the upstream's ref, and the
 * branch's reflog. What is served: the branch name (clipped), whether HEAD is
 * detached, and a count. Never a remote URL, a commit message or a path.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { readForDisplay } from './readfile.js';
import { staysOffNewShares, timedFsCall } from './sharegate.js';

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** A branch name as git allows it, closely enough: no `..`, no backslash, no control characters. */
const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[^\s\\~^:?*[\x00-\x1f\x7f]{1,200}$/;
const MAX_BRANCH_CHARS = 60;

/** Files read before, by path: { mtimeMs, size, content } (or null for one that failed). */
const cache = new Map();
const MAX_CACHE = 200;

/** A file's text, re-read only when its stat changed. { content } or { error }. */
async function readCached(file) {
  let st;
  try {
    st = await timedFsCall(file, () => fs.stat(file));
  } catch (err) {
    cache.delete(file);
    return { error: err.code || 'EREAD' };
  }
  const had = cache.get(file);
  if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return had.value;
  const r = await readForDisplay(file);
  const value = r.error ? { error: r.error.code || 'EREAD' } : r.truncated ? { error: 'ETOOBIG' } : { content: r.content };
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

async function exists(p) {
  try {
    return await timedFsCall(p, () => fs.stat(p));
  } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? null : { error: err.code || 'ESTAT' };
  }
}

/**
 * Where this checkout's git folder is: the nearest ancestor of `projectDir`
 * holding .git. A .git folder is both the place of HEAD and of the shared refs;
 * a .git file (a worktree or a submodule) names its folder in a `gitdir:` line,
 * and a worktree's folder names the shared one in `commondir`. The same walk
 * scan.js makes to find the repository's root (#120), from the other end.
 */
async function gitDirs(projectDir) {
  let dir = path.resolve(projectDir);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const st = await exists(dotGit);
    if (st?.error) return { reason: 'unreadable' };
    if (st) {
      if (st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
      const pointer = await readCached(dotGit);
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(pointer.content || '')?.[1];
      if (!gitdir) return { reason: 'unreadable' };
      const gitDir = path.resolve(dir, gitdir);
      // Never followed onto a share the project is not on (#193): looking
      // there connects out, and this runs every other tick.
      if (!staysOffNewShares(dir, gitDir)) return { reason: 'share' };
      const common = await readCached(path.join(gitDir, 'commondir'));
      const commonDir = common.content ? path.resolve(gitDir, common.content.trim()) : gitDir;
      if (!staysOffNewShares(dir, commonDir)) return { reason: 'share' };
      return { gitDir, commonDir };
    }
    const up = path.dirname(dir);
    if (up === dir) return { reason: 'none' };
    dir = up;
  }
}

/** A ref's commit: its loose file, else its line in packed-refs. Null when it has none. */
async function refSha(commonDir, ref) {
  if (!/^refs\/[A-Za-z0-9._\/-]+$/.test(ref) || ref.split('/').includes('..')) return null;
  const loose = await readCached(path.join(commonDir, ...ref.split('/')));
  const sha = loose.content?.trim();
  if (sha && SHA_RE.test(sha)) return sha;
  const packed = await readCached(path.join(commonDir, 'packed-refs'));
  for (const line of (packed.content || '').split('\n')) {
    const [s, name] = line.trim().split(' ');
    if (name === ref && SHA_RE.test(s || '')) return s;
  }
  return null;
}

/** The branch's upstream ref from config's `[branch "<name>"]` (remote, merge); else origin's of the same name. */
async function upstreamRef(commonDir, branch) {
  const config = await readCached(path.join(commonDir, 'config'));
  const lines = (config.content || '').split('\n');
  let inSection = false;
  let remote = null;
  let merge = null;
  for (const raw of lines) {
    const line = raw.trim();
    const head = /^\[\s*branch\s+"(.*)"\s*\]$/.exec(line);
    if (head) inSection = head[1] === branch;
    else if (line.startsWith('[')) inSection = false;
    else if (inSection) {
      const kv = /^(\w+)\s*=\s*(.*)$/.exec(line);
      if (kv?.[1] === 'remote') remote = kv[2].trim();
      if (kv?.[1] === 'merge') merge = kv[2].trim();
    }
  }
  if (remote && merge?.startsWith('refs/heads/')) return `refs/remotes/${remote}/${merge.slice('refs/heads/'.length)}`;
  return `refs/remotes/origin/${branch}`;
}

/**
 * Commits on the branch since it last stood where its remote does, from the
 * branch's own reflog (`<old> <new> <who> <when>\t<what>` a line): counted
 * back from the newest line to the one that left it at the remote's commit.
 * A commit counts one; an amend none (it replaces one). A reset, rebase or
 * anything else on the way means the log cannot say, and so does a remote
 * commit the log never held (a fresh clone, an expired log): null.
 */
function aheadFromReflog(text, remote) {
  const lines = String(text || '').split('\n').filter(Boolean);
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const [meta, what = ''] = lines[i].split('\t');
    const [, to] = meta.split(' ');
    if (to === remote) return n;
    if (/^commit \(amend\)/.test(what)) continue;
    if (/^commit( \((?:initial|merge)\))?:/.test(what)) n += 1;
    else return null;
  }
  return null;
}

/**
 * The state for one project: { repo: false, reason } with no repository or one
 * that cannot be read, else { repo: true, branch, detached, ahead } where
 * `ahead` is a count, or null when it cannot be told.
 */
export async function readGitState(projectDir) {
  try {
    const dirs = await gitDirs(projectDir);
    if (!dirs.gitDir) return { repo: false, reason: dirs.reason };
    const head = await readCached(path.join(dirs.gitDir, 'HEAD'));
    if (head.error) return { repo: false, reason: head.error === 'ENOENT' ? 'none' : 'unreadable' };
    const text = (head.content || '').trim();
    const ref = /^ref:\s*(refs\/heads\/(.+))$/.exec(text);
    if (!ref) {
      return SHA_RE.test(text) ? { repo: true, branch: null, detached: text.slice(0, 7), ahead: null } : { repo: false, reason: 'unreadable' };
    }
    const branch = ref[2];
    if (!BRANCH_RE.test(branch)) return { repo: false, reason: 'unreadable' };
    const shown = branch.length > MAX_BRANCH_CHARS ? `${branch.slice(0, MAX_BRANCH_CHARS - 1)}…` : branch;
    const local = await refSha(dirs.commonDir, ref[1]);
    const remote = await refSha(dirs.commonDir, await upstreamRef(dirs.commonDir, branch));
    let ahead = null;
    if (local && remote && local === remote) ahead = 0;
    else if (local && remote) {
      const log = await readCached(path.join(dirs.commonDir, 'logs', ...ref[1].split('/')));
      ahead = log.content !== undefined ? aheadFromReflog(log.content, remote) : null;
    }
    return { repo: true, branch: shown, detached: null, ahead, unborn: !local };
  } catch {
    // Anything this did not foresee is still a value: the castle carries on.
    return { repo: false, reason: 'unreadable' };
  }
}

