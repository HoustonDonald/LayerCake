/**
 * LayerCake's own data, under appDataRoot():
 *   cards/<sessionId>.json      summary card per session, so a session stays
 *                               browsable after Claude Code cleans up its transcript
 *   summaries/<sessionId>.json  AI summaries, made once on request
 *   usage-ledger.json           every AI summary LayerCake ran, with its usage
 *
 * Writes go through snapshot.js's atomicWrite, so no mutating fs call appears
 * here: this module is policy (what may be written, and where), the same shape
 * as writefile.js. Every target is checked to sit inside the root, and the root
 * is refused if it falls inside Claude Code's data or ~/.claude, for the same
 * reason the snapshot store is: that tree is not ours to write.
 *
 * Reads go through readForDisplay, the one file-body reader.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { appDataRoot, claudeTrees, isInsideDir } from './paths.js';
import { readForDisplay } from './readfile.js';
import { DIR_TIMEOUT_MS, withTimeout } from './safety.js';
import { atomicWrite } from './snapshot.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Enough history to answer "what has LayerCake cost me"; old entries roll off. */
const MAX_LEDGER_ENTRIES = 2000;

const inside = isInsideDir;

function root() {
  const r = appDataRoot();
  // A UNC or device path (\\server\share, \\localhost\C$, \\?\C:) can name
  // the forbidden tree in a spelling the check below would not recognise.
  // LayerCake's data belongs on a local drive, so those are refused outright.
  if (/^[\\/]{2}/.test(r)) {
    throw new Error(`LayerCake data must be on a local drive path, not ${r}.`);
  }
  for (const forbidden of claudeTrees()) {
    if (inside(r, forbidden)) {
      throw new Error(`Refusing to keep LayerCake data inside ${forbidden}; set LAYERCAKE_APPDATA_DIR elsewhere.`);
    }
  }
  return r;
}

function target(...parts) {
  const r = root();
  const t = path.join(r, ...parts);
  if (!inside(t, r)) throw new Error('Path escapes the LayerCake data folder.');
  return t;
}

function checkId(id) {
  if (!ID_RE.test(String(id || ''))) throw new Error('Not a session id.');
}

async function readJson(file) {
  const result = await readForDisplay(file);
  return result.parsed ?? null;
}

/** All stored summary cards: sessionId -> card. */
export async function readCards() {
  const dir = target('cards');
  const out = new Map();
  let names = [];
  try {
    names = await withTimeout(fs.readdir(dir), DIR_TIMEOUT_MS, dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const m = /^(.+)\.json$/.exec(name);
    if (!m || !ID_RE.test(m[1])) continue;
    const card = await readJson(path.join(dir, name));
    if (card && card.sessionId === m[1]) out.set(m[1], card);
  }
  return out;
}

export async function writeCard(card) {
  checkId(card.sessionId);
  await atomicWrite(target('cards', `${card.sessionId}.json`), JSON.stringify(card, null, 2));
}

export async function readAiSummary(sessionId) {
  checkId(sessionId);
  return readJson(target('summaries', `${sessionId}.json`));
}

export async function writeAiSummary(sessionId, summary) {
  checkId(sessionId);
  await atomicWrite(target('summaries', `${sessionId}.json`), JSON.stringify(summary, null, 2));
}

/**
 * The ledger's entries. A missing file is an empty ledger; any other failure
 * (locked, timed out, unparseable, over the read cap) throws, because treating
 * it as empty would let the next append overwrite every recorded run.
 */
export async function readLedger() {
  const result = await readForDisplay(target('usage-ledger.json'));
  if (result.error?.code === 'ENOENT') return [];
  if (result.error || result.truncated || !Array.isArray(result.parsed?.entries)) {
    const err = new Error(
      `The usage ledger could not be read (${result.error?.code || (result.truncated ? 'too large' : 'unparseable')}); it was left untouched.`
    );
    err.status = 500;
    throw err;
  }
  return result.parsed.entries;
}

/**
 * Replaces the entry with this id, or appends it if it is gone. A summary run
 * writes a "running" entry before it starts and replaces it when it ends, so
 * a run cut off by a shutdown leaves a trace instead of nothing (#3).
 */
export async function putLedgerEntry(entry) {
  const entries = await readLedger();
  const i = entries.findIndex((e) => e && e.id === entry.id);
  if (i === -1) entries.push(entry);
  else entries[i] = entry;
  const kept = entries.slice(-MAX_LEDGER_ENTRIES);
  await atomicWrite(target('usage-ledger.json'), JSON.stringify({ entries: kept }, null, 2));
}

const LAUNCH_ID_RE = /^[0-9a-f]{16}$/;

/**
 * A launched session's record and its --settings file. The record holds the
 * ingest secret, so a session keeps reporting across a LayerCake restart; it
 * sits under the same user ACL as ~/.claude, where the settings file that
 * carries the same secret must live for Claude Code to read it anyway.
 * Returns the settings file's path.
 */
export async function writeLaunch(record, settings) {
  if (!LAUNCH_ID_RE.test(String(record.id || ''))) throw new Error('Not a launch id.');
  const settingsPath = target('launches', `${record.id}.settings.json`);
  await atomicWrite(target('launches', `${record.id}.json`), JSON.stringify(record, null, 2));
  await atomicWrite(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}

/** A launch record by id, or null. */
export async function readLaunch(id) {
  if (!LAUNCH_ID_RE.test(String(id || ''))) return null;
  const record = await readJson(target('launches', `${id}.json`));
  return record && record.id === id && typeof record.secret === 'string' ? record : null;
}

/**
 * Rewrites a launch's record, never its settings file: which session ids the
 * launch has carried (/clear and /resume change it) and which of them ended,
 * so both survive a LayerCake restart.
 */
export async function updateLaunchRecord(record) {
  if (!LAUNCH_ID_RE.test(String(record.id || ''))) throw new Error('Not a launch id.');
  await atomicWrite(target('launches', `${record.id}.json`), JSON.stringify(record, null, 2));
}

/** Every readable launch record, so launches can be restored at startup. */
export async function listLaunchRecords() {
  let names;
  try {
    names = await withTimeout(fs.readdir(target('launches')), DIR_TIMEOUT_MS, 'launches');
  } catch {
    return []; // no launch yet
  }
  const records = [];
  for (const name of names) {
    const m = /^([0-9a-f]{16})\.json$/.exec(name);
    if (!m) continue;
    const record = await readLaunch(m[1]).catch(() => null);
    if (record) records.push(record);
  }
  return records;
}

/** Where the data lives, for the UI to state. */
export function dataRoot() {
  return root();
}

/**
 * The page key for one run of a server (#189, #198): 32 random bytes in hex,
 * new every time a server starts, so a key that ever leaked dies with its run.
 * It is never in the page: the launch that opens the window hands it over in
 * the address's fragment, and the page keeps it for that tab only.
 */
export function newRunKey() {
  return crypto.randomBytes(32).toString('hex');
}

const KEY_RE = /^[0-9a-f]{64}$/;

/**
 * The running server's record, { port, key, pid, startedAt }, written once it
 * listens: how a launch finds this user's LayerCake, on a port Windows chose
 * (#198), and the key it must prove it holds before a window opens on it. In
 * LayerCake's data folder, which in its default place (%LOCALAPPDATA%) only
 * this user can read. A record left by a server that has gone is harmless: the
 * launch's challenge fails and it starts its own.
 */
export async function writeRunRecord(record) {
  await atomicWrite(target('server.json'), `${JSON.stringify(record)}\n`);
}

/** The run record, or null when there is none or it is not one. */
export async function readRunRecord() {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(target('server.json'), 'utf8'));
  } catch {
    return null;
  }
  const { port, key, pid } = parsed || {};
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !KEY_RE.test(String(key)) || !Number.isInteger(pid)) return null;
  return { port, key, pid, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null };
}

/**
 * The page's preferences (#198): the last and recent folders, muted files and
 * the notification choice. They lived in the browser's storage, which belongs
 * to the page's origin, and every run is a new origin now (a new port), so they
 * are kept here instead. The server stores them and never acts on them: a mute
 * still filters nothing it sends (#13). Each field is checked; anything else
 * is dropped.
 */
const PREF_TEXT = 4096;
const textPref = (v) => (typeof v === 'string' && v.length <= PREF_TEXT ? v : undefined);
function cleanPrefs(input) {
  const p = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  if (p.lastDir === null) out.lastDir = null;
  else if (textPref(p.lastDir) !== undefined) out.lastDir = p.lastDir;
  if (Array.isArray(p.recent)) out.recent = p.recent.filter((d) => textPref(d) !== undefined).slice(0, 12);
  if (p.muted && typeof p.muted === 'object' && !Array.isArray(p.muted)) {
    out.muted = Object.fromEntries(
      Object.entries(p.muted)
        .filter(([k, v]) => textPref(k) !== undefined && textPref(v) !== undefined)
        .slice(0, 2000)
    );
  }
  if (typeof p.notify === 'boolean') out.notify = p.notify;
  return out;
}

export async function readPrefs() {
  return cleanPrefs(await readJson(target('prefs.json')));
}

// One update at a time, so two quick changes (a mute, then a folder) cannot
// read the same old file and lose one of them.
let prefsQueue = Promise.resolve();
export function updatePrefs(patch) {
  const run = prefsQueue.then(async () => {
    const next = { ...(await readPrefs()), ...cleanPrefs(patch) };
    await atomicWrite(target('prefs.json'), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
  prefsQueue = run.catch(() => {});
  return run;
}
