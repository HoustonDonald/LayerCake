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

import fs from 'node:fs/promises';
import path from 'node:path';

import { appDataRoot, claudeDataDir, homeDir, samePathKey } from './paths.js';
import { readForDisplay } from './readfile.js';
import { DIR_TIMEOUT_MS, withTimeout } from './safety.js';
import { atomicWrite } from './snapshot.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Enough history to answer "what has LayerCake cost me"; old entries roll off. */
const MAX_LEDGER_ENTRIES = 2000;

function inside(child, parent) {
  const c = samePathKey(child);
  const p = samePathKey(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function root() {
  const r = appDataRoot();
  for (const forbidden of [claudeDataDir(), path.join(homeDir(), '.claude')]) {
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

export async function readLedger() {
  const data = await readJson(target('usage-ledger.json'));
  return Array.isArray(data?.entries) ? data.entries : [];
}

export async function appendLedger(entry) {
  const entries = await readLedger();
  entries.push(entry);
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

/** Where the data lives, for the UI to state. */
export function dataRoot() {
  return root();
}
