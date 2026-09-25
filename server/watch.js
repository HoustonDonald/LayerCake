/**
 * Filesystem watcher for a resolved lineage.
 *
 * Read-only by construction: `fs.watch` observes, it does not mutate, so this
 * module stays on the right side of the "writes live in snapshot.js and
 * writefile.js only" invariant. Nothing here opens a file body either. The
 * signal it emits is a path and a verb, never content, which keeps it far away
 * from becoming a second file reader that skips the scan allowlist.
 *
 * Three decisions worth knowing before changing anything here:
 *
 * DIRECTORIES ARE WATCHED, NOT FILES. Watching a file binds the watch to the
 * inode behind it, and an atomic save replaces that inode. LayerCake's own
 * `atomicWrite` is temp-file-plus-rename, and so is every editor worth using,
 * so a per-file watch would go deaf on exactly the event it exists to catch.
 * The parent directory sees create, delete, rename and modify for every child.
 *
 * NON-RECURSIVE, ALWAYS. `fs.watch` supports `recursive: true` on Windows and
 * macOS, and on Linux only since Node 20.13. More to the point, the scan
 * already tells us every directory that actually holds something, so a
 * recursive watch on `~/.claude` would buy nothing and subscribe us to
 * `projects/`, `sessions/` and the rest of the runtime state the scan is
 * careful to skip.
 *
 * UNC PATHS ARE NOT WATCHED. `fs.watch` opens its directory handle eagerly and
 * takes no timeout, so binding one against a disconnected share can block the
 * event loop with no way to race it. Every other filesystem call in this server
 * goes through `withTimeout` for exactly that reason; this one cannot, so it
 * declines instead. The paths are reported as unwatched rather than dropped.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLAUDE_DIR_TREES, isUncPath, samePathKey } from './paths.js';
import { describeError } from './safety.js';

/** agents, skills, commands, hooks, rules, memory. Read from the manifest, never retyped. */
const TREE_NAMES = new Set(CLAUDE_DIR_TREES.map((t) => t.name.toLowerCase()));

/**
 * True for a path inside one of the .claude/ config subtrees.
 *
 * These are the directories whose contents are OPEN: any .md under `agents/` is
 * an agent, so a file appearing there is news even though no scan ever probed
 * that exact name. Everywhere else the set of interesting names is closed and
 * the scan already enumerated it, absences included.
 *
 * Matched on the segment after `.claude` so it survives the depth-3 nesting of
 * `skills/<name>/SKILL.md` without hard-coding a depth.
 */
function inConfigTree(absPath) {
  const parts = String(absPath).split(/[\\/]/);
  const i = parts.lastIndexOf('.claude');
  return i !== -1 && i + 1 < parts.length && TREE_NAMES.has(parts[i + 1].toLowerCase());
}

/**
 * Coalescing window. One logical change produces several native events: Windows
 * reports a rename as delete-then-create, and most editors touch a file two or
 * three times on save. 250ms is long enough to fold those together and short
 * enough that the banner still feels immediate.
 */
export const DEBOUNCE_MS = 250;

/**
 * Scratch files produced BY a write rather than being a config file.
 *
 * This is not tidiness. Claude Code rewrites `~/.claude.json` continuously
 * while a session is running, and each rewrite is a lock file plus a temp file
 * plus a rename. Without this filter the banner is permanently lit with
 * `.claude.json.lock` and `.claude.json.tmp.61380.46b69858cf08`, which buries
 * the one event that matters underneath and trains the user to ignore it.
 *
 * Dropping these loses nothing: the rename that publishes the change still
 * fires an event naming the real file. An atomic write is exactly the shape
 * this tool's own `atomicWrite` uses, so `.layercake-tmp-` is here too.
 *
 * The first three were observed on Windows with Claude Code 2.1.229 running.
 * The editor swap files are the same class by inspection, not measurement.
 */
export function isTransientArtifact(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return (
    lower.endsWith('.lock') ||
    lower.includes('.tmp.') ||
    lower.endsWith('.tmp') ||
    lower.startsWith('.layercake-tmp-') ||
    lower.endsWith('.swp') ||
    lower.endsWith('.swx') ||
    lower.endsWith('~')
  );
}

/**
 * Upper bound on directory handles per stream. A deep project under a deep home
 * directory lands around sixty; the cap exists so a pathological ancestor chain
 * cannot open hundreds. Truncation is reported, never silent.
 */
export const MAX_WATCHED_DIRS = 256;

/**
 * The directories that cover a lineage, plus the ones deliberately left out.
 *
 * Both files and absences contribute their PARENT: absence is data in this
 * tool, so a CLAUDE.md that does not exist yet still has to raise an event the
 * moment someone creates it, and the only thing that can see that is the
 * directory it will appear in.
 *
 * Deduped with samePathKey because a project under the home directory makes the
 * walk pass through home a second time and re-find everything the user level
 * already reported. Watching those twice would double every event.
 */
export function watchTargets(lineage) {
  const dirs = new Map();
  const skipped = new Map();

  const consider = (target) => {
    const key = samePathKey(target);
    if (dirs.has(key) || skipped.has(key)) return;
    if (isUncPath(target)) {
      skipped.set(key, { absPath: target, reason: 'Network path, not watched' });
      return;
    }
    if (dirs.size >= MAX_WATCHED_DIRS) {
      skipped.set(key, { absPath: target, reason: `Over the ${MAX_WATCHED_DIRS} directory cap` });
      return;
    }
    dirs.set(key, target);
  };

  for (const level of lineage.levels) {
    for (const entry of level.entries) {
      // A directory entry is watched itself as well as through its parent: the
      // tree roots (agents/, skills/, hooks/) are where new files actually land.
      if (entry.type === 'dir') consider(entry.absPath);
      consider(path.dirname(entry.absPath));
    }
    for (const missing of level.absent) {
      consider(path.dirname(missing.absPath));
    }
  }

  return { dirs: [...dirs.values()], skipped: [...skipped.values()] };
}

/**
 * Starts watching everything a lineage touches.
 *
 * `onChange` receives a coalesced array of `{ dir, name, absPath, kind }`. It is
 * called on a timer, never synchronously from inside a filesystem event, so a
 * slow consumer cannot stall the watcher.
 *
 * Errors are values here as everywhere else: a directory that cannot be watched
 * lands in `errors` and the rest still start. One unreadable ancestor must not
 * cost you the watch on your own project.
 */
export function watchLineage(lineage, onChange) {
  const { dirs, skipped } = watchTargets(lineage);
  const watchers = [];
  const watched = [];
  const errors = [];

  /**
   * Everything the scan probed, present or not.
   *
   * The absences are the half that makes this work: a CLAUDE.md that does not
   * exist yet is still a path the scan looked for, so its creation is reportable
   * without the watcher needing any opinion of its own about what counts as
   * config. That opinion lives in the manifest, and this reads it secondhand
   * through the scan result rather than forming a second one.
   */
  const known = new Set();
  for (const level of lineage.levels) {
    for (const entry of level.entries) known.add(samePathKey(entry.absPath));
    for (const missing of level.absent) known.add(samePathKey(missing.absPath));
  }

  /** key -> change, so repeated events on one path collapse to the last one. */
  let pending = new Map();
  let timer = null;
  let closed = false;

  function flush() {
    timer = null;
    if (closed || pending.size === 0) return;
    const batch = [...pending.values()];
    pending = new Map();
    try {
      onChange(batch);
    } catch {
      /* A throwing consumer must not take the watcher down with it. */
    }
  }

  function record(dir, filename, eventType) {
    if (closed) return;
    if (isTransientArtifact(filename)) return;
    // macOS can omit the filename. Falling back to the directory keeps the
    // event useful: "something under here moved" is still actionable.
    const absPath = filename ? path.join(dir, filename) : dir;

    // Watching a directory subscribes you to everything in it, and `~/.claude`
    // holds `history.jsonl`, `daemon.log`, `backups/` and the session store
    // alongside the config. Those rewrite continuously while Claude Code runs,
    // so an unfiltered banner is lit permanently and says nothing.
    //
    // The scan already decided what counts as config, absences included, and
    // the manifest already says which subtrees are open-ended. Asking those two
    // is the whole filter: no second list to keep in step, and a target added
    // to the manifest starts being watched without anything here changing.
    if (filename && !known.has(samePathKey(absPath)) && !inConfigTree(absPath)) return;
    pending.set(samePathKey(absPath), {
      dir,
      name: filename || null,
      absPath,
      // 'rename' covers create, delete and move on every platform; 'change' is
      // a content or metadata write. Passing the raw verb through lets the UI
      // stay honest instead of guessing which one happened.
      kind: eventType === 'change' ? 'change' : 'rename',
    });
    if (timer === null) timer = setTimeout(flush, DEBOUNCE_MS);
  }

  for (const dir of dirs) {
    try {
      // persistent:false so watchers never hold the process open by themselves.
      // The HTTP server is what keeps this process alive; a stranded watcher
      // should not be able to outlive it.
      const watcher = fs.watch(dir, { persistent: false, recursive: false }, (eventType, filename) =>
        record(dir, filename, eventType)
      );
      // An error after start (the directory is deleted out from under us, a
      // share drops) arrives here. Recording and closing that one watcher beats
      // an unhandled 'error' event taking down the server.
      watcher.on('error', (err) => {
        errors.push({ path: dir, ...describeError(err) });
        try {
          watcher.close();
        } catch {
          /* already gone */
        }
      });
      watchers.push(watcher);
      watched.push(dir);
    } catch (err) {
      // ENOENT is the common case and is not a failure: it means a probed
      // parent does not exist yet, which the scan already reports as absence.
      if (err && err.code === 'ENOENT') {
        skipped.push({ absPath: dir, reason: 'Does not exist' });
      } else {
        errors.push({ path: dir, ...describeError(err) });
      }
    }
  }

  return {
    watchedCount: watched.length,
    watched,
    skipped,
    errors,
    close() {
      if (closed) return;
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = new Map();
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          /* closing an already-dead watcher is not worth reporting */
        }
      }
      watchers.length = 0;
    },
  };
}
