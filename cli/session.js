/**
 * `layercake session`: the health of a directory's current Claude Code session,
 * from the terminal. Reads the same normalized model the browser does, through
 * the server modules directly, never over HTTP. Reads files only: no Claude
 * usage, ever (AI summaries are a browser action).
 */

import { computeHealth } from '../server/health.js';
import { samePathKey } from '../server/paths.js';
import { discoverSessions, getReader, liveSessions, retentionDays } from '../server/sessions.js';
import { sessionCard } from '../server/summaries.js';
import { elide, out, padEnd, paint, plural, shortenPath } from './format.js';

function tokens(n) {
  if (n == null) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function ago(iso) {
  if (!iso) return '-';
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} days ago`;
}

/** Sessions whose working directory is `dir` itself, newest first, with their cards. */
async function sessionsIn(dir) {
  const found = await discoverSessions({ force: true });
  const live = await liveSessions();
  const retention = await retentionDays();
  const key = samePathKey(dir);
  const rows = [];
  for (const info of found.values()) {
    const reader = await getReader(info.sessionId);
    if (!reader.model.cwd || samePathKey(reader.model.cwd) !== key) continue;
    rows.push({
      reader,
      card: sessionCard(reader.model, { size: reader.size, mtimeMs: reader.mtimeMs }, retention),
      live: live.find((l) => l.sessionId === info.sessionId) || null,
    });
  }
  return rows.sort((a, b) => String(b.card.lastAt || '').localeCompare(String(a.card.lastAt || '')));
}

const STATE_PAINT = { error: paint.red, warning: paint.yellow, working: paint.green, idle: (s) => s, offline: paint.dim };

export async function runSession(dir, { list = false, home }) {
  const rows = await sessionsIn(dir);
  if (!rows.length) {
    out(`No Claude Code sessions recorded for ${dir}.`);
    return;
  }

  if (list) {
    out(paint.bold(`${plural(rows.length, 'session')} in ${shortenPath(dir, home)}`));
    for (const r of rows) {
      const mark = r.live ? paint.green('●') : ' ';
      out(`${mark} ${padEnd(ago(r.card.lastAt), 13)} ${padEnd(plural(r.card.prompts, 'prompt'), 11)} ${elide(r.card.title, 70)}`);
    }
    return;
  }

  const current = rows.find((r) => r.live) || rows[0];
  const { model } = current.reader;
  const card = current.card;
  const health = computeHealth(model, current.live, { mtimeMs: current.reader.mtimeMs });
  const label = health.states.find((s) => s.state === health.state)?.label || health.state;
  const c = health.context;

  out(`${paint.bold('Session')}   ${card.title}  ${paint.dim(card.titleSource === 'ai' ? '(title by Claude Code)' : card.titleSource === 'custom' ? '(your title)' : '(first prompt)')}`);
  out(`${paint.bold('State')}     ${(STATE_PAINT[health.state] || ((s) => s))(label)}  ${paint.dim(health.reasons.join('; '))}`);
  out(`${paint.bold('Model')}     ${model.modelName || model.modelId || Object.keys(model.models)[0] || '-'}${model.effort ? `, effort ${model.effort}` : ''}${model.permissionMode ? `, ${model.permissionMode} mode` : ''}  ${paint.dim(`Claude Code ${model.version || '?'}`)}`);
  if (c.tokens != null) {
    out(`${paint.bold('Context')}   ${tokens(c.tokens)} of ${tokens(c.window)} (${Math.round(c.pct * 100)}%)  ${paint.dim('estimated from the last API call')}`);
  }
  out(
    `${paint.bold('Activity')}  ${card.prompts} prompts, ${card.tools} tool calls` +
      `${model.toolFailures ? ` (${model.toolFailures} failed)` : ''}, ${card.filesEdited} files edited,` +
      ` ${card.subagents} subagents, ${card.compactions} compactions, ${card.errors} API errors`
  );
  if (model.mcp.failed.length) out(`${paint.bold('MCP')}       ${paint.yellow(`failed to connect: ${model.mcp.failed.join(', ')}`)}`);
  const atStart = model.instructions.filter((i) => i.reason === 'session_start').map((i) => shortenPath(i.path, home));
  const later = model.instructions.filter((i) => i.reason !== 'session_start').map((i) => shortenPath(i.path, home));
  out(`${paint.bold('Memory')}    loaded at start: ${atStart.join(', ') || 'none recorded'}`);
  if (later.length) out(`          loaded later: ${later.join(', ')}`);
  const lastPrompt = [...model.turns].reverse().find((t) => t.kind === 'prompt');
  if (lastPrompt) out(`${paint.bold('Last')}      ${elide(lastPrompt.text.replace(/\s+/g, ' ').trim(), 90)}  ${paint.dim(ago(lastPrompt.at))}`);
  if (card.recaps.length) out(`${paint.bold('Recap')}     ${elide(card.recaps[card.recaps.length - 1].text.replace(/\s+/g, ' '), 200)}`);
  if (rows.length > 1) out(paint.dim(`\n${plural(rows.length - 1, 'other session')} here: layercake session --list`));
}
