/**
 * Filesystem watcher for a resolved lineage.
 *
 * Read-only by construction: `fs.watch` observes and the poller below only
 * lists directories and stats files, so this module stays on the right side of
 * the "writes live in snapshot.js and writefile.js only" invariant. Nothing here
 * opens a file body either. The signal it emits is a path and a verb, never
 * content, which keeps it far away from becoming a second file reader that skips
 * the scan allowlist.
 *
 * Four decisions worth knowing before changing anything here:
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
 * NETWORK PATHS ARE POLLED, NOT WATCHED. `fs.watch` opens its directory handle
 * eagerly, inside the synchronous call (that is why it can throw ENOENT on the
 * spot), and takes no timeout, so binding one against a disconnected share can
 * block the event loop with no way to race it: 21 s, measured, for a share on
 * an unroutable address. A directory on a share is polled
 * instead: a listing, plus a stat per config file in it, every POLL_MS. Those
 * calls run on libuv's threadpool and each goes through `timedFsCall`, the same
 * per-share gate the scan uses (sharegate.js), so a dead share costs a timeout,
 * one thread and a reported state, never a stalled server. "On a share" means
 * a UNC path, or a path on a drive letter the scan found mapped to one
 * (`lineage.networkDrives`, #57): `Z:\proj` reaches the same server as
 * `\\server\share\proj` and stalls the same way.
 *
 * ONE FILTER FOR BOTH. Native events and polled differences go through the same
 * `isReportable`, read from the scan result and the manifest, so a share-side
 * level is filtered exactly as the same level on a local disk would be.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLAUDE_DIR_TREES, isUncPath, samePathKey } from './paths.js';
import { describeError, isSecret } from './safety.js';
import { SHARE_STUCK, shareKeyOf, timedFsCall } from './sharegate.js';

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
 * Every folder between a config subtree's root and a path inside it: for
 * `.claude/skills/x/SKILL.md`, `.claude/skills/x` and `.claude/skills`. Empty
 * for a path outside the subtrees, and for a subtree root itself.
 *
 * These are where new config lands. A skill is a new FOLDER in skills/, so the
 * watch that sees it is the one on skills/, and skills/ holds no file of its
 * own, so nothing else puts it in the watched set. Without this, a new skill
 * raised no event at all (#56): the watch on .claude does not reliably report
 * a change one level down, and on a share, where .claude is polled and a
 * folder is compared by presence only, it cannot. Same segment rule as
 * inConfigTree, so the two agree on what a subtree is.
 */
function treeFoldersAbove(absPath) {
  const parts = String(absPath).split(/[\\/]/);
  const i = parts.lastIndexOf('.claude');
  if (i === -1 || i + 2 >= parts.length || !TREE_NAMES.has(parts[i + 1].toLowerCase())) return [];
  const folders = [];
  let dir = path.dirname(absPath);
  // parts[i + 1] is the subtree root; the last part is absPath's own name.
  for (let n = parts.length - i - 3; n >= 0; n -= 1) {
    folders.push(dir);
    dir = path.dirname(dir);
  }
  return folders;
}

/**
 * Whether a path is on a network share: a UNC path, or a path on a drive
 * letter the scan found mapped to a share. Read from the scan result, which
 * already asked the filesystem, so the watcher forms no opinion of its own.
 */
function onNetworkTest(lineage) {
  const roots = new Set((lineage.networkDrives || []).map((d) => samePathKey(d.root)));
  return (p) => isUncPath(p) || (roots.size > 0 && roots.has(samePathKey(path.parse(path.resolve(p)).root)));
}

/**
 * Coalescing window. One logical change produces several native events: Windows
 * reports a rename as delete-then-create, and most editors touch a file two or
 * three times on save. 250ms is long enough to fold those together and short
 * enough that the banner still feels immediate.
 */
export const DEBOUNCE_MS = 250;

/**
 * How often a directory on a network share is polled.
 *
 * 5 s is the trade between how soon a share-side change shows and how much a
 * LayerCake window costs the file server while it sits open. One round is a
 * stat of the share root, a listing per polled directory and a stat per config
 * file present in it, repeated for as long as the window is open, over what may
 * be a VPN. Faster buys little: the bar's only action is "rescan", nobody waits
 * on it the way they wait on a build, and through `\\localhost\C$` a local
 * change was visible through the share within 5 ms, so here the interval alone
 * sets the delay (a remote server's client-side metadata caching can add to it;
 * not measured). Slower starts to read as "the bar missed it".
 *
 * Rounds never overlap: the next is armed only when the last has finished, so
 * a slow share stretches the interval instead of stacking calls behind it.
 */
export const POLL_MS = 5000;

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
 * Upper bound on directories per stream, watched and polled together. A deep
 * project under a deep home directory lands around sixty; the cap exists so a
 * pathological ancestor chain cannot open hundreds of handles or poll hundreds
 * of share folders. Truncation is reported, never silent.
 */
export const MAX_WATCHED_DIRS = 256;

/**
 * The directories that cover a lineage, split by how they are covered, plus the
 * ones deliberately left out.
 *
 * Both files and absences contribute their PARENT: absence is data in this
 * tool, so a CLAUDE.md that does not exist yet still has to raise an event the
 * moment someone creates it, and the only thing that can see that is the
 * directory it will appear in.
 *
 * Deduped with samePathKey because a project under the home directory makes the
 * walk pass through home a second time and re-find everything the user level
 * already reported. Watching those twice would double every event.
 *
 * `polled` entries carry `scanError` when the directory is there only because
 * the scan could not read it; see the level loop below.
 */
export function watchTargets(lineage) {
  const dirs = new Map();
  const polled = new Map();
  const skipped = new Map();
  const onNetwork = onNetworkTest(lineage);

  const consider = (target, scanError = null) => {
    const key = samePathKey(target);
    if (dirs.has(key) || polled.has(key) || skipped.has(key)) return;
    if (dirs.size + polled.size >= MAX_WATCHED_DIRS) {
      skipped.set(key, { absPath: target, reason: `Over the ${MAX_WATCHED_DIRS} directory cap` });
      return;
    }
    if (onNetwork(target)) polled.set(key, { absPath: target, scanError });
    else dirs.set(key, target);
  };

  for (const level of lineage.levels) {
    // Directory entries (runtime state such as skills/.trash) are covered
    // through their parent like everything else, and are not watched
    // themselves: nothing inside them is config.
    for (const entry of level.entries) {
      consider(path.dirname(entry.absPath));
      for (const folder of treeFoldersAbove(entry.absPath)) consider(folder);
    }
    for (const missing of level.absent) {
      // A subtree that exists but holds no config yet is where its first
      // file will land, so it is watched itself, not only through .claude.
      if (missing.dirExists) consider(missing.absPath);
      consider(path.dirname(missing.absPath));
    }

    // A share-side level the scan could not reach at all has no entries and no
    // absences, so nothing above lists its directory, and the bar would say
    // "watching" with no gap while the project's share is down. Polling that
    // directory is what lets the bar name the share as unreachable, and raise
    // an event when it answers again. ENOENT is left out: that is a folder
    // missing from a share that did answer, which is no different from a
    // missing local ancestor, and those are not watched either.
    if (level.dir && onNetwork(level.dir)) {
      const levelKey = samePathKey(level.dir);
      const unread = level.errors.find(
        (e) => e.code !== 'ENOENT' && e.path && samePathKey(e.path) === levelKey
      );
      if (unread) consider(level.dir, { code: unread.code, message: unread.message });
    }
  }

  return { dirs: [...dirs.values()], polled: [...polled.values()], skipped: [...skipped.values()] };
}

/**
 * True when a share-side call failed because the share is not answering: it
 * timed out, or sharegate.js refused it because an earlier call (from this
 * stream, another stream, or a scan) timed out and has not come back. Either
 * way the rest of the round would only be refused too.
 */
function shareUnresponsive(err) {
  return err?.code === 'ETIMEDOUT' || err?.code === SHARE_STUCK;
}

/**
 * Starts watching everything a lineage touches.
 *
 * `onChange` receives a coalesced array of `{ dir, name, absPath, kind }`. It is
 * called on a timer, never synchronously from inside a filesystem event, so a
 * slow consumer cannot stall the watcher.
 *
 * `onCoverage` receives a new `coverage()` whenever it has moved since the last
 * one sent: after the first poll round, when a share drops or comes back, and
 * when a native watch fails after it started. The caller sends `coverage()`
 * itself once, as its ready frame; this is everything after that.
 *
 * Errors are values here as everywhere else: a directory that cannot be watched
 * lands in `errors` and the rest still start. One unreadable ancestor must not
 * cost you the watch on your own project, and one dead share must not cost you
 * the watch on anything else.
 */
export function watchLineage(lineage, onChange, onCoverage) {
  const { dirs, polled, skipped } = watchTargets(lineage);
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

  /**
   * Whether a child of `dir` is worth an event.
   *
   * Watching a directory subscribes you to everything in it, and `~/.claude`
   * holds `history.jsonl`, `daemon.log`, `backups/` and the session store
   * alongside the config. Those rewrite continuously while Claude Code runs,
   * so an unfiltered banner is lit permanently and says nothing.
   *
   * The scan already decided what counts as config, absences included, and
   * the manifest already says which subtrees are open-ended. Asking those two
   * is the whole filter: no second list to keep in step, and a target added
   * to the manifest starts being watched without anything here changing.
   */
  function isReportable(dir, filename) {
    // macOS can omit the filename, and a share folder that could not be read
    // is reported whole. "Something under here moved" is still actionable.
    if (!filename) return true;
    if (isTransientArtifact(filename)) return false;
    const absPath = path.join(dir, filename);
    return known.has(samePathKey(absPath)) || inConfigTree(absPath);
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
    if (!isReportable(dir, filename)) return;
    const absPath = filename ? path.join(dir, filename) : dir;
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

  /**
   * A natively watched folder was deleted.
   *
   * Node on Windows says so by reporting the folder ITSELF as renamed, by its
   * full \\?\ path, and then again, about 130,000 times a second for as long
   * as the handle stays open (measured, Node 24.3, no 'error' event at all).
   * Unhandled, that is a spinning core and a bar re-lit on every debounce, from
   * deleting one skill folder: 3.3 s of server CPU and 14 change frames in the
   * 3 s after. Closing the handle stops it (31 ms and none, same measurement).
   *
   * Reported as a change to the folder itself, because its parent may not be
   * watched or may not count the folder's name as config (a deleted .claude/),
   * and it stops counting as watched: it no longer exists.
   */
  function watchedFolderGone(dir, watcher) {
    const at = watched.indexOf(dir);
    // Events already queued behind the first one arrive after this ran.
    if (at === -1) return;
    watched.splice(at, 1);
    try {
      watcher.close();
    } catch {
      /* already gone */
    }
    record(dir, null, 'rename');
    skipped.push({ absPath: dir, reason: 'Deleted after the watch started' });
    sendCoverage();
  }

  for (const dir of dirs) {
    try {
      // persistent:false so watchers never hold the process open by themselves.
      // The HTTP server is what keeps this process alive; a stranded watcher
      // should not be able to outlive it.
      const watcher = fs.watch(dir, { persistent: false, recursive: false }, (eventType, filename) => {
        // A child is always reported by its name alone; only the folder's own
        // report of its deletion carries an absolute path.
        if (filename && path.isAbsolute(filename)) watchedFolderGone(dir, watcher);
        else record(dir, filename, eventType);
      });
      // An error after start arrives here. (Deleting the folder is not one on
      // Windows, where it arrives as the event above.) Recording and closing
      // that one watcher beats an unhandled 'error' event taking down the
      // server. It stops counting as watched and the client is told, or the
      // bar would go on claiming a folder nobody is looking at.
      watcher.on('error', (err) => {
        errors.push({ path: dir, ...describeError(err) });
        const at = watched.indexOf(dir);
        if (at !== -1) watched.splice(at, 1);
        try {
          watcher.close();
        } catch {
          /* already gone */
        }
        sendCoverage();
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

  // --- share-side folders: polled -------------------------------------------

  /**
   * share key -> { key, root, targets }. Grouped by share because a share is
   * what goes down: when its root does not answer, every folder on it is
   * unreachable, and asking each of them separately would only queue more
   * calls behind the one already stuck.
   *
   * A target's `snapshot` is null until its first good read, then a map of
   * reportable child -> { name, isDir, mtimeMs, size }. `failed` means it has
   * not been read since it last could not be, which decides what that next
   * good read reports.
   */
  const shares = new Map();
  for (const { absPath, scanError } of polled) {
    // path.parse knows the UNC form: the root of \\server\share\x is \\server\share\.
    // A mapped drive's root is the letter, Z:\, which is the same share.
    const root = path.parse(path.resolve(absPath)).root;
    // The gate's own key, so what counts as one share here is what sharegate.js
    // counts as one.
    const key = shareKeyOf(absPath);
    if (!shares.has(key)) shares.set(key, { key, root, targets: [] });
    shares.get(key).targets.push({
      absPath,
      snapshot: null,
      failed: Boolean(scanError),
      down: false,
      error: scanError ? { code: scanError.code, message: `Not read at scan time: ${scanError.message}` } : null,
    });
  }

  /**
   * Every folder on a share moves to the gap list at once. A folder already
   * marked down keeps the reason it was first given: a dead share alternates
   * between a timeout and the OS's own quick failure, and re-sending coverage
   * every time the wording of why changed would say nothing new.
   */
  function shareDown(share, detail) {
    for (const target of share.targets) {
      if (target.down) continue;
      target.failed = true;
      target.down = true;
      target.error = { code: detail.code, message: `Share not reachable: ${detail.message}` };
    }
  }

  /**
   * Compares one good read with the last, and records the difference through
   * the same `record` a native event goes through.
   */
  function settle(target, next) {
    const before = target.snapshot;
    if (before === null) {
      // The first good read has nothing to compare with. A folder that could
      // not be read before it (at scan time, or since this stream opened) is
      // reported whole, because what is in it now was never seen.
      if (target.failed) record(target.absPath, null, 'rename');
    } else {
      for (const [key, now] of next) {
        const was = before.get(key);
        if (!was || was.isDir !== now.isDir) {
          record(target.absPath, now.name, 'rename');
        } else if (!now.isDir && (now.mtimeMs !== was.mtimeMs || now.size !== was.size)) {
          // Directories are compared by presence only: a directory's mtime moves
          // whenever anything inside it does, so comparing it would report the
          // folder on every edit to a file that is already reported by name.
          record(target.absPath, now.name, 'change');
        }
      }
      for (const [key, was] of before) {
        if (!next.has(key)) record(target.absPath, was.name, 'rename');
      }
    }
    target.snapshot = next;
    target.failed = false;
    target.down = false;
    target.error = null;
  }

  /** One folder. Returns false when the share stopped answering mid-round. */
  async function pollDir(share, target) {
    let names;
    try {
      names = await timedFsCall(target.absPath, () => fs.promises.readdir(target.absPath));
    } catch (err) {
      if (shareUnresponsive(err)) {
        shareDown(share, describeError(err));
        return false;
      }
      if (err?.code !== 'ENOENT') {
        target.failed = true;
        target.down = false;
        target.error = describeError(err);
        return true;
      }
      // A folder that does not exist yet reads as an empty one: everything the
      // scan expected in it is absent, which is what it was at scan time, and
      // its creation shows up as those files appearing.
      names = [];
    }

    const next = new Map();
    for (const name of names) {
      if (closed) return false;
      if (!isReportable(target.absPath, name)) continue;
      const absPath = path.join(target.absPath, name);
      // Never stat'ed, the same as in the scan, which records a credential
      // file's name in `redacted` without touching the file itself.
      if (isSecret(absPath)) continue;
      const key = samePathKey(absPath);
      try {
        const st = await timedFsCall(absPath, () => fs.promises.stat(absPath));
        next.set(key, { name, isDir: st.isDirectory(), mtimeMs: st.mtimeMs, size: st.size });
      } catch (err) {
        if (shareUnresponsive(err)) {
          shareDown(share, describeError(err));
          return false;
        }
        // Gone since the listing (ENOENT) drops out and reads as a delete.
        // Anything else keeps what was last seen, so a passing error is never
        // reported as a deletion; a file that really went is missing from the
        // next listing.
        const was = target.snapshot?.get(key);
        if (was && err?.code !== 'ENOENT') next.set(key, was);
      }
    }
    if (closed) return false;
    settle(target, next);
    return true;
  }

  /**
   * One round for one share, one call at a time.
   *
   * Sequential on purpose. Calls in parallel would finish a round sooner, but a
   * share that dies mid-round would then strand one threadpool thread per call
   * in flight instead of one. Each call also waits its turn at the share in
   * sharegate.js, behind other streams and any scan, so the share never has
   * two calls outstanding in the process. The round stops at the first call
   * that times out or is refused because an earlier one is still out.
   */
  async function pollShare(share) {
    if (closed) return;
    try {
      await timedFsCall(share.root, () => fs.promises.stat(share.root));
    } catch (err) {
      shareDown(share, describeError(err));
      return;
    }
    for (const target of share.targets) {
      if (closed) return;
      if (!(await pollDir(share, target))) return;
    }
  }

  let pollTimer = null;
  let firstRound = true;
  /** The last coverage sent, serialized, so an unchanged one is not sent again. */
  let sentCoverage = null;

  /**
   * `always` is for the end of the first round, which is sent even unchanged:
   * until then a share's reachability is unknown, and it is also the moment a
   * change on the share can first be told apart from the baseline.
   */
  function sendCoverage(always = false) {
    if (closed) return;
    const now = coverage();
    const serialized = JSON.stringify(now);
    if (serialized === sentCoverage && !always) return;
    sentCoverage = serialized;
    try {
      onCoverage?.(now);
    } catch {
      /* same as onChange: a throwing consumer must not stop the watcher */
    }
  }

  async function pollRound() {
    pollTimer = null;
    await Promise.all(
      [...shares.values()].map((share) =>
        pollShare(share).catch((err) => {
          // Every call above is caught already; this is for a bug, and an
          // unhandled rejection here would take the whole server down.
          for (const target of share.targets) {
            target.failed = true;
            target.error = describeError(err);
          }
        })
      )
    );
    if (closed) return;
    sendCoverage(firstRound);
    firstRound = false;
    pollTimer = setTimeout(pollRound, POLL_MS);
    // Like persistent:false on the native watchers: polling alone must never
    // keep the process alive.
    pollTimer.unref();
  }

  /**
   * What is covered right now, and what is not. The shape of the ready frame.
   *
   * A polled folder counts as watched until a round finds it unreadable, then
   * moves to `errors` with the reason, so "watching N folders" never includes a
   * share that is not answering.
   */
  function coverage() {
    const pollErrors = [];
    let polling = 0;
    for (const share of shares.values()) {
      for (const target of share.targets) {
        if (target.error) pollErrors.push({ path: target.absPath, ...target.error });
        else polling += 1;
      }
    }
    return {
      watchedCount: watched.length + polling,
      polled: [...shares.values()].flatMap((share) => share.targets.map((t) => t.absPath)),
      pollMs: POLL_MS,
      skipped,
      errors: [...errors, ...pollErrors],
    };
  }

  // On a timer rather than inline, so the caller has sent its ready frame
  // before any coverage can follow it.
  if (shares.size > 0) {
    pollTimer = setTimeout(pollRound, 0);
    pollTimer.unref();
  }

  return {
    coverage,
    close() {
      if (closed) return;
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
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
