/**
 * One filesystem call per network share at a time, process-wide.
 *
 * `withTimeout` stops WAITING for a call; it cannot cancel it. The call keeps a
 * libuv threadpool thread (four by default, shared with every other filesystem
 * call in this server) until the OS gives up, which takes 21 s here for a share
 * on an unroutable address. So a timed-out call is not free: it is a thread
 * lost for that long. Before this gate, one scan of a project four folders deep
 * on such a share stranded all four threads, one per level: the scan took 21 s,
 * local stats waited up to 11.8 s, and local levels that were perfectly
 * readable came back as timeouts because their own calls could not get a
 * thread (#55). The watcher's poller had hit the same wall first (#14), and its
 * fix is what this module generalises.
 *
 * Two rules, for every call the scan and the watcher make to a path on a UNC
 * share:
 *
 * TURNS. Calls to one share take turns across the whole process, so it never
 * has two outstanding. The rule below only knows about a call once it has
 * timed out, so without turns, callers that start inside the same 3 s each
 * strand a thread: three watch streams opened together on a dead share left a
 * local stat waiting 14 s (#14), and four scans of one at once, with the rule
 * below but no turns, 21 s.
 *
 * NONE WHILE ONE IS STRANDED. A share with a timed-out call that has not come
 * back gets no new call until it does; the caller gets ESHARESTUCK at once
 * instead. So through this gate a dead share holds one thread, not the pool.
 *
 * One gate for the process, not one per module, because the threadpool is one
 * per process: a share already stuck in the watcher must also stop a scan from
 * piling on, and the reverse.
 *
 * Raising UV_THREADPOOL_SIZE was considered and not done. It moves the cliff
 * instead of removing it: each level of a deeper project, and each scan running
 * alongside, stranded one more thread, so any fixed size runs out. With the
 * gate a dead share costs the scan and the watcher one thread between them.
 *
 * The key is the SERVER, not the share (#68): a dead server with several of
 * its shares in use held one thread per share, and the pool has four. A mapped
 * drive letter is keyed by the server behind it once the scan has resolved it.
 * Local paths are not gated: they go straight to `withTimeout`.
 *
 * ONE BUDGET PER CALL, FROM THE MOMENT IT IS QUEUED (#69). A call that waited
 * its turn behind slow calls used to get its own full timeout after that, so a
 * caller could wait several timeouts in all. Now a call whose turn comes after
 * its budget has run out is not made at all (ETIMEDOUT, and nothing stranded),
 * and one that is made gets what is left, but at least MIN_CALL_MS, since a
 * call given almost no time would time out, strand a thread and mark a merely
 * slow share as stuck.
 */

import path from 'node:path';

import { isUncPath, samePathKey } from './paths.js';
import { DIR_TIMEOUT_MS, withTimeout } from './safety.js';

/** The code a refused call rejects with. `describeError` knows its wording. */
export const SHARE_STUCK = 'ESHARESTUCK';

/**
 * The share a path is on, as a key, or null for a local path.
 *
 * path.parse knows the UNC form: the root of \\server\share\x is \\server\share\.
 * Folded by samePathKey, because \\SERVER\Share and \\server\share are one share.
 */
/**
 * Drive roots the scan found mapped to a network share (#57). A mapped drive
 * reaches the same server as its UNC path and strands threads the same way,
 * so it is one share here too. Learnt from the scan, which already asks the
 * filesystem, rather than asked again: a scan's own calls on a drive it has
 * not classified yet go ungated, and every call after that is gated.
 */
/** drive root key -> the server key it reaches, or the root itself when unknown. */
const networkRoots = new Map();

/** `\\server` of a UNC path, folded, or null for anything else. */
function serverKeyOf(p) {
  const m = /^[\\/]{2}([^\\/?.][^\\/]*)/.exec(String(p));
  return m ? `\\\\${m[1].toLowerCase()}` : null;
}

/**
 * Records a drive root the scan found mapped to a share. `share` is the UNC
 * path it resolved to, when known, so the drive shares its server's gate.
 */
export function markNetworkRoot(root, share = null) {
  const key = samePathKey(path.parse(path.resolve(root)).root);
  networkRoots.set(key, serverKeyOf(share) || key);
}

export function shareKeyOf(p) {
  const root = samePathKey(path.parse(path.resolve(p)).root);
  if (isUncPath(p)) return serverKeyOf(p) || root;
  // Found after the #13/#57 and #55 merges: without this a mapped drive had no
  // key, so every mapped drive fell into one null group in the watcher and
  // none of their calls were gated.
  return networkRoots.get(root) || null;
}

/** share key -> the set of its timed-out calls that have not settled yet. */
const stuckCalls = new Map();

export function isShareStuck(shareKey) {
  return (stuckCalls.get(shareKey)?.size || 0) > 0;
}

function rememberStuck(shareKey, raw) {
  let calls = stuckCalls.get(shareKey);
  if (!calls) {
    calls = new Set();
    stuckCalls.set(shareKey, calls);
  }
  calls.add(raw);
  const release = () => {
    calls.delete(raw);
    if (calls.size === 0 && stuckCalls.get(shareKey) === calls) stuckCalls.delete(shareKey);
  };
  raw.then(release, release);
}

/** share key -> the settled tail of its queue of calls. */
const turns = new Map();

function onTurn(shareKey, work) {
  const before = turns.get(shareKey) || Promise.resolve();
  const turn = before.then(work);
  const settled = turn.then(
    () => {},
    () => {}
  );
  turns.set(shareKey, settled);
  settled.then(() => {
    if (turns.get(shareKey) === settled) turns.delete(shareKey);
  });
  return turn;
}

/** The least a call that is actually made gets, whatever its wait (#69). */
const MIN_CALL_MS = 500;

function queuedTooLong(label) {
  const err = new Error(`Timed out waiting for its turn on a slow share: ${label}`);
  err.code = 'ETIMEDOUT';
  return err;
}

function stuckError(label) {
  const err = new Error(`Not tried, an earlier call to its share has not returned: ${label}`);
  err.code = SHARE_STUCK;
  return err;
}

/**
 * One filesystem call, raced against DIR_TIMEOUT_MS, and gated when `target`
 * is on a share.
 *
 * `start` is a function rather than a promise so that a call the gate refuses
 * is never made at all: a started call is already a thread. `ms` is the whole
 * budget, counted from now, the wait for a turn included (#69).
 *
 * Rejects with ETIMEDOUT when this call timed out (the share is then stuck
 * until the call comes back) or its turn came too late to try it, and with
 * ESHARESTUCK when it was not tried.
 */
export function timedFsCall(target, start, label = target, ms = DIR_TIMEOUT_MS) {
  const shareKey = shareKeyOf(target);
  if (shareKey === null) return withTimeout(start(), ms, label);
  const deadline = Date.now() + ms;
  return onTurn(shareKey, () => {
    if (isShareStuck(shareKey)) return Promise.reject(stuckError(label));
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(queuedTooLong(label));
    const raw = start();
    // Marked stuck before this rejection settles the turn, so the next call in
    // the queue already sees it.
    return withTimeout(raw, Math.max(left, MIN_CALL_MS), label).catch((err) => {
      if (err?.code === 'ETIMEDOUT') rememberStuck(shareKey, raw);
      throw err;
    });
  });
}

/**
 * A call gated only when `target` is on a share, and made as-is on a local
 * disk (#66). For reading a file whole and for the write path: locally such a
 * call is not bounded by a timeout, because an antivirus scan on close can
 * legitimately take longer and abandoning a write reports an error for a
 * write that then lands. On a share the same call could hang for 21 s and
 * strand a threadpool thread, so there it takes its turn and its budget like
 * every other share call.
 */
export function shareGatedCall(target, start, label = target, ms = DIR_TIMEOUT_MS) {
  return shareKeyOf(target) === null ? start() : timedFsCall(target, start, label, ms);
}
