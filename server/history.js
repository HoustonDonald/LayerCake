/**
 * Prompt history: <claudeDataDir>/history.jsonl, one line per submitted prompt
 * across every project, appended by Claude Code when a prompt is sent.
 *
 * It outlives transcripts (Claude Code cleans transcripts up after
 * cleanupPeriodDays; this file it keeps), so for a session whose transcript is
 * gone it is the only record left, and it holds prompts only, never replies.
 *
 * Only display, timestamp, project and sessionId are kept. `pastedContents`
 * holds whatever the user pasted, which can be a secret, and never leaves this
 * module. Read-only, through the shared tail.
 */

import path from 'node:path';

import { JsonlTail } from './jsonl.js';
import { claudeDataDir } from './paths.js';

const PREVIEW_CHARS = 2000;

let tail = null;
let entries = [];

function clip(text) {
  const s = typeof text === 'string' ? text : '';
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS - 1)}…` : s;
}

/** All history entries, brought up to date. Missing file means no history, not an error. */
export async function readHistory() {
  const file = path.join(claudeDataDir(), 'history.jsonl');
  if (!tail || tail.file !== file) {
    entries = [];
    tail = new JsonlTail(
      file,
      (r) => {
        if (!r || typeof r.display !== 'string') return;
        entries.push({
          text: clip(r.display),
          at: typeof r.timestamp === 'number' ? new Date(r.timestamp).toISOString() : null,
          project: typeof r.project === 'string' ? r.project : null,
          sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
        });
      },
      () => {
        entries = [];
      }
    );
  }
  try {
    await tail.refresh();
  } catch {
    return [];
  }
  return entries;
}
