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
import { wrappedFor } from './ingest.js';
import { readHistory } from './history.js';
import { rootState, samePathKey } from './paths.js';
import {
  discoverSessions,
  getReader,
  liveSessions,
  retentionDays,
  SESSION_ID_RE,
  subagentActivity,
} from './sessions.js';
import { RUN_TIMEOUT_MS, estimateSummary, sessionCard, summarizeWithClaude } from './summaries.js';
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
    queued: t.queued,
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
    // From each subagent's own status, not the last turn_duration record, which
    // is only written when a turn ends and so lags behind a completion.
    runningSubagents: model.subagents.filter((s) => s.status === 'running' || s.status === 'starting').length,
    costState: model.costState,
    continuedIn: model.continuedIn,
    parse: { lines: model.lines, badLines: model.badLines, unknown: model.unknown },
    turns: model.turns.map(turnSummary),
  };
}

/**
 * Whether a session is running. Claude Code's own pid file is the first
 * source, but it is written lazily: a session LayerCake launched had none
 * 30 s after start (measured 2026-09-26, before any prompt). For those the
 * launch's own reports answer instead: running while it has reported within
 * the report window (its status line re-runs on a timer), busy while a tool
 * is in flight. Silence past the window, whether from a crash, a closed tab or
 * a LayerCake restart, reads as not running, never as running forever (#4, #31).
 */
function liveFrom(pidLive, wrapped, sessionId) {
  if (pidLive) return pidLive;
  if (!wrapped || !wrapped.reporting) return null;
  return { pid: null, sessionId, status: wrapped.running.length ? 'busy' : null, source: 'hooks' };
}

async function liveFor(sessionId, wrapped) {
  return liveFrom((await liveSessions()).find((s) => s.sessionId === sessionId), wrapped, sessionId);
}

/** A launched session's reported state, with the transcript as evidence for tools that ended unreported (#23). */
function wrappedView(reader) {
  return wrappedFor(reader.sessionId, { toolDone: (id) => reader.toolDone(id) });
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
        const w = wrappedView(reader);
        const l = liveFrom(liveById.get(card.sessionId), w, card.sessionId);
        sessions.push({
          ...card,
          transcript: 'on-disk',
          live: Boolean(l),
          status: l?.status || null,
          pid: l?.pid || null,
          launched: Boolean(w),
          // Launched, not ended, not running by its reports: never reported
          // (blocked channels), not since a restart, or stopped reporting.
          quiet: !l && w?.quiet ? (w.neverReported ? 'blocked' : w.restored && !w.lastSeenAt ? 'restart' : 'silent') : null,
        });
      }

      const expired = [];
      for (const card of stored.values()) {
        if (found.has(card.sessionId) || !inScope(card.cwd)) continue;
        // An AI summary was paid for once; it must outlive the transcript it
        // summarized, which is the whole point of keeping the card.
        const aiSummary = await readAiSummary(card.sessionId).catch(() => null);
        expired.push({ ...card, transcript: 'expired', live: false, aiSummary });
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
      // A refused data folder is reported here, not a 500 for the whole list (#88).
      const data = rootState(dataRoot);
      res.json({
        dir: dir || null,
        retentionDays: retention,
        dataRoot: data.root,
        dataRootError: data.error,
        live,
        sessions: sessions.sort(byRecent),
        expired: expired.sort(byRecent),
        promptOnly: promptOnly.sort(byRecent),
        persist: { saved, error: persistError || data.error },
        states: HEALTH_STATES,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/session/:id', async (req, res) => {
    try {
      const reader = await getReader(req.params.id);
      const wrapped = wrappedView(reader);
      const live = await liveFor(req.params.id, wrapped);
      const retention = await retentionDays();
      res.json({
        ...sessionDetail(reader.model),
        card: sessionCard(reader.model, { size: reader.size, mtimeMs: reader.mtimeMs }, retention),
        live,
        health: computeHealth(reader.model, live, { mtimeMs: reader.mtimeMs, wrapped }),
        wrapped,
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
      if (!t) return res.status(404).json({ message: 'No such turn.', code: 'ENOTURN' });
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
    if (!SESSION_ID_RE.test(id)) return res.status(400).json({ message: 'Not a session id.', code: 'EBADREQUEST' });
    const prompts = (await readHistory()).filter((h) => h.sessionId === id).map((h) => ({ at: h.at, text: h.text }));
    if (!prompts.length) return res.status(404).json({ message: 'No history for that session.', code: 'ENOHISTORY' });
    return res.json({ sessionId: id, prompts });
  });

  /**
   * Live updates for one session, as Server-Sent Events over a fetch stream
   * (the token cannot ride in a query string; see /api/watch). Each update is
   * small state, not content: the client refetches the detail when lastAt moves.
   */
  app.get('/api/session/:id/stream', async (req, res) => {
    // The slot is checked and the disconnect noticed BEFORE the first await. A
    // client that gave up while the reader loaded otherwise left a slot taken
    // forever, with its poller running (shown in review: four early aborts,
    // then "Already following 4 sessions" with none open).
    if (streams.size >= MAX_STREAMS) {
      return res.status(429).json({ message: `Already following ${MAX_STREAMS} sessions. Close another LayerCake tab.`, code: 'ETOOMANY' });
    }
    // The slot is TAKEN here too, not only checked: opens arriving together
    // all passed a check whose slot was taken after the await (#30). Every
    // early exit below gives it back.
    const stream = { close: () => streams.delete(stream) };
    streams.add(stream);
    let gone = false;
    req.on('close', () => {
      gone = true;
    });
    let reader;
    try {
      reader = await getReader(req.params.id);
    } catch (err) {
      streams.delete(stream);
      return sendError(res, err);
    }
    if (gone) {
      streams.delete(stream);
      return undefined;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();

    let lastKey = '';
    let closed = false;
    const tick = async () => {
      if (closed) return;
      try {
        await reader.refresh();
        const m = reader.model;
        const wrapped = wrappedView(reader);
        const live = await liveFor(reader.sessionId, wrapped);
        const health = computeHealth(m, live, { mtimeMs: reader.mtimeMs, wrapped });
        const update = {
          lastAt: m.lastAt,
          turns: m.turns.length,
          health,
          context: m.context,
          live: live ? { status: live.status, pid: live.pid } : null,
        };
        // A launched session changes without writing its transcript (a tool starts, a
        // permission prompt appears), so the hook activity is part of the key.
        // The reasons too: some change with time alone, the state unchanged
        // ("restarted moments ago" becoming "most likely stopped", #45).
        const key = JSON.stringify([update.lastAt, update.turns, health.state, health.reasons, live?.status || null, wrapped?.lastHookAt || null, wrapped?.statuslineAt || null]);
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
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(keepalive);
      streams.delete(stream);
      if (!res.writableEnded) res.end();
    }
    stream.close = close;
    req.on('close', close);
    await tick();
    return undefined;
  });

  /** The one route that spends Claude usage. One run at a time. */
  app.post('/api/session/:id/summarize', async (req, res) => {
    if (summarizing) return res.status(409).json({ message: 'A summary is already running.', code: 'EBUSY' });
    // Taken before the first await: two requests arriving together would
    // otherwise both pass the check above and both run.
    summarizing = String(req.params.id);
    try {
      const reader = await getReader(req.params.id);
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
      // A "running" entry older than any run can last is a run LayerCake did
      // not see finish: it was stopped mid-run, and the usage is unknown (#3).
      const now = Date.now();
      const data = rootState(dataRoot);
      const entries = (data.error ? [] : await readLedger()).map((e) =>
        e?.status === 'running' && now - Date.parse(e.at) > RUN_TIMEOUT_MS + 60_000
          ? { ...e, status: 'interrupted', error: 'LayerCake stopped during this run, so its usage was never reported (it may have spent some).' }
          : e
      );
      const sum = (key) => entries.reduce((n, e) => n + (typeof e[key] === 'number' ? e[key] : 0), 0);
      res.json({
        dataRoot: data.root,
        dataRootError: data.error,
        entries: entries.slice(-200).reverse(),
        totals: {
          runs: entries.length,
          failed: entries.filter((e) => !e.ok).length,
          interrupted: entries.filter((e) => e.status === 'interrupted').length,
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
