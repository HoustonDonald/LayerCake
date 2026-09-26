/**
 * /api/session* routes: session history, one session's detail and turns, a
 * live update stream, AI summaries, and LayerCake's own usage.
 *
 * Every route is behind the same guards as the rest of /api (they are
 * registered after them in app.js). Sessions are addressed only by an id that
 * sessions.js discovered, the way files are addressed only through a scan
 * result; nothing here accepts a path.
 *
 * These routes carry content (prompts and replies), unlike /api/watch, which
 * by rule carries paths and verbs only. That is why they are separate routes
 * and the watch stream stays as it is.
 */

import path from 'node:path';

import { dataRoot, readAiSummary, readCards, readLedger, writeCard } from './appdata.js';
import { computeHealth, HEALTH_STATES } from './health.js';
import { readHistory } from './history.js';
import { samePathKey } from './paths.js';
import {
  discoverSessions,
  getReader,
  liveSessions,
  retentionDays,
  SESSION_ID_RE,
  subagentActivity,
} from './sessions.js';
import { estimateSummary, sessionCard, summarizeWithClaude } from './summaries.js';
import { MAX_TEXT_CHARS } from './transcript.js';

const PREVIEW_CHARS = 300;
const STREAM_POLL_MS = 1000;
const STREAM_KEEPALIVE_MS = 30000;
const MAX_STREAMS = 4;
/** A live session's card changes on every turn; rewriting it that often buys nothing. */
const PERSIST_MIN_MS = 60_000;

const lastPersisted = new Map();
const streams = new Set();
let summarizing = null;

function clip(text, max) {
  if (typeof text !== 'string') return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sendError(res, err) {
  res.status(err.status || 500).json({ message: err.message, code: err.code || null });
}

/** True when `child` is `dir` or inside it, compared the way the filesystem compares. */
function underDir(child, dir) {
  if (!child || !dir) return false;
  const c = samePathKey(child);
  const d = samePathKey(dir);
  return c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

function turnSummary(t) {
  return {
    n: t.n,
    at: t.at,
    endAt: t.endAt,
    kind: t.kind,
    preview: clip(t.text.replace(/\s+/g, ' ').trim(), PREVIEW_CHARS),
    images: t.images,
    source: t.source,
    interrupted: t.interrupted,
    responsePreview: clip(t.responseText.replace(/\s+/g, ' ').trim(), PREVIEW_CHARS),
    tools: t.tools.length,
    toolErrors: t.tools.filter((x) => x.error).length,
    running: t.tools.some((x) => !x.done),
    apiCalls: t.apiCalls,
    usage: t.usage,
    contextTokens: t.contextTokens,
    durationMs: t.durationMs,
  };
}

function sessionDetail(model) {
  return {
    sessionId: model.sessionId,
    cwd: model.cwd,
    gitBranch: model.gitBranch,
    version: model.version,
    entrypoint: model.entrypoint,
    firstAt: model.firstAt,
    lastAt: model.lastAt,
    aiTitle: model.aiTitle,
    customTitle: model.customTitle,
    agentName: model.agentName,
    awaySummaries: model.awaySummaries,
    modelId: model.modelId,
    modelName: model.modelName,
    models: model.models,
    effort: model.effort,
    permissionMode: model.permissionMode,
    planMode: model.planMode,
    totals: model.totals,
    context: model.context,
    compactions: model.compactions,
    errors: model.errors,
    notices: model.notices,
    subagents: model.subagents,
    instructions: model.instructions,
    skills: model.skills,
    mcp: model.mcp,
    hooks: model.hooks,
    filesEdited: model.filesEdited.slice(0, 500),
    filesEditedCount: model.filesEdited.length,
    toolFailures: model.toolFailures,
    permissionDenials: model.permissionDenials,
    backgroundPending: model.backgroundPending,
    costState: model.costState,
    continuedIn: model.continuedIn,
    parse: { lines: model.lines, badLines: model.badLines, unknown: model.unknown },
    turns: model.turns.map(turnSummary),
  };
}

async function liveFor(sessionId) {
  return (await liveSessions()).find((s) => s.sessionId === sessionId) || null;
}

/**
 * Persists a card when it changed, at most once a minute per session. A failure
 * here must not fail the listing, so it is reported rather than thrown.
 */
async function persistCard(card, stored, now) {
  if (stored && stored.size === card.size && stored.mtimeMs === card.mtimeMs) return false;
  if (stored && now - (lastPersisted.get(card.sessionId) || 0) < PERSIST_MIN_MS) return false;
  await writeCard(card);
  lastPersisted.set(card.sessionId, now);
  return true;
}

export function registerSessionRoutes(app) {
  /**
   * Every session LayerCake can show, in three kinds:
   *   sessions    transcript on disk (full detail available)
   *   expired     transcript cleaned up, but LayerCake kept its card
   *   promptOnly  known only from history.jsonl: prompts, no replies
   * `dir` limits the list to sessions whose working directory is that
   * directory or inside it; without it, every project is included.
   */
  app.get('/api/sessions', async (req, res) => {
    try {
      const dir = String(req.query.dir || '').trim();
      const [found, live, retention, history, stored] = await Promise.all([
        discoverSessions({ force: true }),
        liveSessions(),
        retentionDays(),
        readHistory(),
        readCards().catch(() => new Map()),
      ]);
      const liveById = new Map(live.map((s) => [s.sessionId, s]));
      const now = Date.now();
      const inScope = (cwd) => !dir || underDir(cwd, dir);

      const sessions = [];
      let saved = 0;
      let persistError = null;
      for (const info of found.values()) {
        let reader;
        try {
          reader = await getReader(info.sessionId);
        } catch {
          continue;
        }
        const card = sessionCard(reader.model, { size: reader.size, mtimeMs: reader.mtimeMs }, retention);
        try {
          if (await persistCard(card, stored.get(card.sessionId), now)) saved += 1;
        } catch (err) {
          persistError = err.message;
        }
        if (!inScope(card.cwd)) continue;
        const l = liveById.get(card.sessionId);
        sessions.push({ ...card, transcript: 'on-disk', live: Boolean(l), status: l?.status || null, pid: l?.pid || null });
      }

      const expired = [];
      for (const card of stored.values()) {
        if (found.has(card.sessionId) || !inScope(card.cwd)) continue;
        expired.push({ ...card, transcript: 'expired', live: false });
      }

      const byId = new Map();
      for (const h of history) {
        if (!h.sessionId || !SESSION_ID_RE.test(h.sessionId)) continue;
        if (found.has(h.sessionId) || stored.has(h.sessionId)) continue;
        if (!inScope(h.project)) continue;
        const g = byId.get(h.sessionId) || { sessionId: h.sessionId, cwd: h.project, prompts: 0, startedAt: h.at, lastAt: h.at, firstPrompt: h.text };
        g.prompts += 1;
        g.lastAt = h.at || g.lastAt;
        byId.set(h.sessionId, g);
      }
      const promptOnly = [...byId.values()].map((g) => ({
        ...g,
        title: clip(g.firstPrompt.replace(/\s+/g, ' ').trim(), 90) || '(no text)',
        firstPrompt: clip(g.firstPrompt, 400),
        transcript: 'none',
        live: false,
      }));

      const byRecent = (a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || ''));
      res.json({
        dir: dir || null,
        retentionDays: retention,
        dataRoot: dataRoot(),
        live,
        sessions: sessions.sort(byRecent),
        expired: expired.sort(byRecent),
        promptOnly: promptOnly.sort(byRecent),
        persist: { saved, error: persistError },
        states: HEALTH_STATES,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/session/:id', async (req, res) => {
    try {
      const reader = await getReader(req.params.id);
      const live = await liveFor(req.params.id);
      const retention = await retentionDays();
      res.json({
        ...sessionDetail(reader.model),
        card: sessionCard(reader.model, { size: reader.size, mtimeMs: reader.mtimeMs }, retention),
        live,
        health: computeHealth(reader.model, live, { mtimeMs: reader.mtimeMs }),
        activity: await subagentActivity(reader),
        aiSummary: await readAiSummary(req.params.id).catch(() => null),
        estimate: estimateSummary(reader.model),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/session/:id/turn/:n', async (req, res) => {
    try {
      const reader = await getReader(req.params.id);
      const n = Number(req.params.n);
      const t = reader.model.turns.find((x) => x.n === n);
      if (!t) return res.status(404).json({ message: 'No such turn.' });
      return res.json({
        ...turnSummary(t),
        text: clip(t.text, MAX_TEXT_CHARS),
        textTruncated: t.text.length > MAX_TEXT_CHARS,
        responseText: clip(t.responseText, MAX_TEXT_CHARS),
        responseTruncated: t.responseText.length > MAX_TEXT_CHARS,
        toolCalls: t.tools.map((x) => ({ id: x.id, name: x.name, summary: x.summary, at: x.at, endAt: x.endAt, done: x.done, error: x.error })),
        subagents: reader.model.subagents.filter((s) => s.turn === n),
      });
    } catch (err) {
      return sendError(res, err);
    }
  });

  /** Prompts of a session whose transcript is gone, from history.jsonl. */
  app.get('/api/history/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!SESSION_ID_RE.test(id)) return res.status(400).json({ message: 'Not a session id.' });
    const prompts = (await readHistory()).filter((h) => h.sessionId === id).map((h) => ({ at: h.at, text: h.text }));
    if (!prompts.length) return res.status(404).json({ message: 'No history for that session.' });
    return res.json({ sessionId: id, prompts });
  });

  /**
   * Live updates for one session, as Server-Sent Events over a fetch stream
   * (the token cannot ride in a query string; see /api/watch). Each update is
   * small state, not content: the client refetches the detail when lastAt moves.
   */
  app.get('/api/session/:id/stream', async (req, res) => {
    let reader;
    try {
      reader = await getReader(req.params.id);
    } catch (err) {
      return sendError(res, err);
    }
    if (streams.size >= MAX_STREAMS) {
      return res.status(429).json({ message: `Already following ${MAX_STREAMS} sessions. Close another LayerCake tab.` });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();

    let lastKey = '';
    let closed = false;
    const tick = async () => {
      if (closed) return;
      try {
        await reader.refresh();
        const live = await liveFor(reader.sessionId);
        const m = reader.model;
        const health = computeHealth(m, live, { mtimeMs: reader.mtimeMs });
        const update = {
          lastAt: m.lastAt,
          turns: m.turns.length,
          health,
          context: m.context,
          backgroundPending: m.backgroundPending,
          live: live ? { status: live.status, pid: live.pid } : null,
        };
        const key = JSON.stringify([update.lastAt, update.turns, health.state, live?.status || null]);
        if (key !== lastKey) {
          lastKey = key;
          if (!res.writableEnded) res.write(`event: update\ndata: ${JSON.stringify(update)}\n\n`);
        }
      } catch (err) {
        if (!res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      }
    };
    const poll = setInterval(tick, STREAM_POLL_MS);
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, STREAM_KEEPALIVE_MS);
    const stream = { close };
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(keepalive);
      streams.delete(stream);
      if (!res.writableEnded) res.end();
    }
    streams.add(stream);
    req.on('close', close);
    await tick();
    return undefined;
  });

  /** The one route that spends Claude usage. One run at a time. */
  app.post('/api/session/:id/summarize', async (req, res) => {
    if (summarizing) return res.status(409).json({ message: 'A summary is already running.' });
    try {
      const reader = await getReader(req.params.id);
      summarizing = reader.sessionId;
      const summary = await summarizeWithClaude(reader.model);
      return res.json(summary);
    } catch (err) {
      return res.status(err.status || 500).json({ message: err.message, ledger: err.ledger || null });
    } finally {
      summarizing = null;
    }
  });

  /** LayerCake's own Claude usage, kept apart from any session's. */
  app.get('/api/usage', async (req, res) => {
    try {
      const entries = await readLedger();
      const sum = (key) => entries.reduce((n, e) => n + (typeof e[key] === 'number' ? e[key] : 0), 0);
      res.json({
        dataRoot: dataRoot(),
        entries: entries.slice(-200).reverse(),
        totals: {
          runs: entries.length,
          failed: entries.filter((e) => !e.ok).length,
          inputTokens: sum('inputTokens') + sum('cacheCreationTokens') + sum('cacheReadTokens'),
          outputTokens: sum('outputTokens'),
          costUSD: sum('costUSD'),
        },
      });
    } catch (err) {
      sendError(res, err);
    }
  });
}

// Exported for the CLI, which reads the same model without HTTP.
export { sessionDetail, turnSummary };
