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
 * The key is the share, not the server, so a dead server with several of its
 * shares in use holds one thread per share. Local paths are not gated: they go
 * straight to `withTimeout`. A mapped drive letter pointing at a share is not
 * recognised as a network path (`isUncPath`), so it keeps the old behaviour.
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
export function shareKeyOf(p) {
  if (!isUncPath(p)) return null;
  return samePathKey(path.parse(path.resolve(p)).root);
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
 * is never made at all: a started call is already a thread. The time spent
 * waiting for a turn is not counted against the timeout; it is bounded by the
 * calls ahead in the queue, each of which is.
 *
 * Rejects with ETIMEDOUT when this call timed out (the share is then stuck
 * until the call comes back), and with ESHARESTUCK when it was not tried.
 */
export function timedFsCall(target, start, label = target) {
  const shareKey = shareKeyOf(target);
  if (shareKey === null) return withTimeout(start(), DIR_TIMEOUT_MS, label);
  return onTurn(shareKey, () => {
    if (isShareStuck(shareKey)) return Promise.reject(stuckError(label));
    const raw = start();
    // Marked stuck before this rejection settles the turn, so the next call in
    // the queue already sees it.
    return withTimeout(raw, DIR_TIMEOUT_MS, label).catch((err) => {
      if (err?.code === 'ETIMEDOUT') rememberStuck(shareKey, raw);
      throw err;
    });
  });
}
