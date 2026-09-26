/**
 * Ingest for sessions LayerCake launched: the status line and the hooks that
 * launch.js put into that session's --settings post here.
 *
 *   POST /ingest/<launchId>/<secret>/statusline   status line JSON, answered with the line to print
 *   POST /ingest/<launchId>/<secret>/hook         hook JSON, answered 204 with an EMPTY body
 *
 * The empty body is the zero-token contract. Claude Code treats a 2xx with an
 * empty body as "success, no output", so nothing reaches Claude's context
 * (docs: hooks, "HTTP response handling"). A JSON body could add context or
 * block an action, which is why this module never sends one to a hook.
 *
 * Guards, because these routes are not under /api and so not behind the page
 * token or the origin guard:
 *  - the Host guard, which covers every route;
 *  - a per-launch secret in the path, compared in constant time;
 *  - no Origin header allowed: browsers always send one on a POST, Claude
 *    Code's HTTP client does not, so a web page cannot use these routes even
 *    with the secret.
 * What arrives is held in memory only, reduced to what the UI shows: tool
 * names and one-line summaries, never tool input or output bodies. The one
 * thing written down is which session ids a launch carried and which ended,
 * so a restart does not forget them (#24).
 *
 * State is kept per SESSION within a launch, not per launch (#22). One
 * terminal carries several session ids over its life: /clear starts a new
 * one, /resume switches to another. Launch-wide state showed the new
 * session's numbers, labelled exact, on the old one.
 */

import crypto from 'node:crypto';

import { listLaunchRecords, readLaunch, updateLaunchRecord } from './appdata.js';
import { SESSION_ID_RE } from './sessions.js';
import { toolSummary } from './transcript.js';

const MAX_EVENTS = 200;
const PREVIEW_CHARS = 200;

/** launchId -> launch. Populated by launch.js and, at startup, from app data. */
const launches = new Map();

function clip(text, max = PREVIEW_CHARS) {
  const s = typeof text === 'string' ? text : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function blankSession() {
  return {
    statusline: null,
    statuslineAt: null,
    lastHookAt: null,
    // Last post of any kind for this session: picks the launch that holds a
    // session now, when /resume has carried it into a later launch.
    lastSeenAt: null,
    events: [],
    waiting: null,
    running: new Map(),
    toolFailures: 0,
    instructionsLoaded: [],
    hookCounts: {},
    ended: false,
    endReason: null,
  };
}

function blank(record, restored) {
  const ended = record.ended && typeof record.ended === 'object' ? record.ended : {};
  const ids = Array.isArray(record.sessionIds) ? record.sessionIds : [record.sessionId];
  const sessions = new Map();
  for (const id of ids.filter((x) => SESSION_ID_RE.test(String(x || '')))) {
    const s = blankSession();
    if (Object.hasOwn(ended, id)) {
      s.ended = true;
      s.endReason = typeof ended[id] === 'string' ? ended[id] : null;
    }
    sessions.set(id, s);
  }
  return {
    id: record.id,
    secret: record.secret,
    dir: record.dir,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    sessions,
    // The session a post without a session id belongs to: the latest seen.
    currentId: record.sessionId,
    // Restored from disk after a restart: until a session reports again,
    // nothing in memory says whether it is still running.
    restored,
    persisting: Promise.resolve(),
    persistError: null,
  };
}

/** Registers a launch so its ingest is accepted. Idempotent for a known id. */
export function registerLaunch(record, { restored = false } = {}) {
  if (!launches.has(record.id)) launches.set(record.id, blank(record, restored));
  return launches.get(record.id);
}

/**
 * Loads every launch record from app data. Before this, a launched session
 * read as "not running" after a restart until its next post, which for a
 * session idle at the prompt can be an hour (#24).
 */
export async function restoreLaunches() {
  for (const record of await listLaunchRecords()) registerLaunch(record, { restored: true });
}

function latest(values) {
  return values.filter(Boolean).sort().pop() || null;
}

export function listLaunches() {
  return [...launches.values()].map((l) => {
    const sessions = [...l.sessions.entries()];
    return {
      id: l.id,
      dir: l.dir,
      createdAt: l.createdAt,
      sessionIds: sessions.map(([id]) => id),
      sessions: sessions.map(([id, s]) => ({ id, ended: s.ended, endReason: s.endReason, lastSeenAt: s.lastSeenAt })),
      statuslineAt: latest(sessions.map(([, s]) => s.statuslineAt)),
      lastHookAt: latest(sessions.map(([, s]) => s.lastHookAt)),
      persistError: l.persistError,
    };
  });
}

/**
 * The launch that holds a session now, with that session's state. A session
 * /resume'd into a later launch appears in both; the one that heard from it
 * last wins, and a launch that has not heard from it at all loses to one
 * that has.
 */
function sessionFor(sessionId) {
  let best = null;
  for (const l of launches.values()) {
    const s = l.sessions.get(sessionId);
    if (!s) continue;
    const key = s.lastSeenAt || '';
    if (!best || key > best.key || (key === best.key && String(l.createdAt) > String(best.l.createdAt))) best = { l, s, key };
  }
  return best;
}

function secretMatches(expected, supplied) {
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The line Claude Code prints under its prompt for a launched session. */
function statusText(s) {
  const parts = ['LayerCake'];
  const cw = s.context_window;
  if (cw && typeof cw.used_percentage === 'number') parts.push(`ctx ${Math.round(cw.used_percentage)}%`);
  if (typeof s.cost?.total_cost_usd === 'number') parts.push(`$${s.cost.total_cost_usd.toFixed(2)}`);
  const five = s.rate_limits?.five_hour?.used_percentage;
  if (typeof five === 'number') parts.push(`5h ${Math.round(five)}%`);
  const week = s.rate_limits?.seven_day?.used_percentage;
  if (typeof week === 'number') parts.push(`7d ${Math.round(week)}%`);
  if (s.prompt_cache && typeof s.prompt_cache.warm === 'boolean') parts.push(s.prompt_cache.warm ? 'cache warm' : 'cache cold');
  return parts.join(' · ');
}

/** The subset of the status line JSON kept and shown. */
function keepStatusline(s) {
  return {
    sessionId: s.session_id || null,
    model: s.model ? { id: s.model.id || null, name: s.model.display_name || null } : null,
    version: s.version || null,
    outputStyle: s.output_style?.name || null,
    effort: s.effort?.level || null,
    thinking: typeof s.thinking?.enabled === 'boolean' ? s.thinking.enabled : null,
    cost: s.cost
      ? {
          totalUSD: s.cost.total_cost_usd ?? null,
          durationMs: s.cost.total_duration_ms ?? null,
          apiDurationMs: s.cost.total_api_duration_ms ?? null,
          linesAdded: s.cost.total_lines_added ?? null,
          linesRemoved: s.cost.total_lines_removed ?? null,
        }
      : null,
    context: s.context_window
      ? {
          usedPercentage: s.context_window.used_percentage ?? null,
          windowTokens: s.context_window.context_window_size ?? null,
          current: s.context_window.current_usage || null,
        }
      : null,
    rateLimits: s.rate_limits
      ? Object.fromEntries(
          Object.entries(s.rate_limits).map(([k, v]) => [k, { usedPercentage: v?.used_percentage ?? null, resetsAt: v?.resets_at ?? null }])
        )
      : null,
    promptCache: s.prompt_cache
      ? {
          warm: s.prompt_cache.warm ?? null,
          expiresAt: s.prompt_cache.expires_at ?? null,
          hitRatio: s.prompt_cache.hit_ratio ?? null,
          ttl: s.prompt_cache.ttl ?? null,
        }
      : null,
    worktree: s.worktree?.name || null,
  };
}

/** Notification types that mean Claude is waiting on the user (docs: hooks, Notification). */
const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
  'quota_auto_resume_stale',
]);
const PERMISSION_WAITS = new Set(['permission', 'permission_prompt']);
/** Events that mean Claude is moving again, so a pending "waiting" is over. */
const RESUMING = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd']);

/**
 * The tool a permission prompt is for. PermissionRequest carries no
 * tool_use_id (docs), but PreToolUse runs before the permission check, so it
 * is the latest running tool of that name. An inference, used only to let the
 * transcript end the wait once that tool has a result.
 */
function pendingToolId(s, toolName) {
  let found = null;
  for (const [id, t] of s.running) if (!toolName || t.name === toolName) found = id;
  return found;
}

function applyHook(s, h, at) {
  const event = String(h.hook_event_name || 'unknown');
  s.lastHookAt = at;
  s.hookCounts[event] = (s.hookCounts[event] || 0) + 1;
  if (RESUMING.has(event)) s.waiting = null;

  const summary = h.tool_name ? toolSummary(String(h.tool_name), h.tool_input) : '';
  if (event === 'PreToolUse' && h.tool_use_id) {
    s.running.set(String(h.tool_use_id), { name: h.tool_name, summary, at });
  } else if ((event === 'PostToolUse' || event === 'PostToolUseFailure' || event === 'PermissionDenied') && h.tool_use_id) {
    s.running.delete(String(h.tool_use_id));
    if (event === 'PostToolUseFailure') s.toolFailures += 1;
  } else if (event === 'UserPromptSubmit' || event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd') {
    // A new prompt means every earlier tool finished or was interrupted: Esc
    // on a running tool fires neither PostToolUse nor PostToolUseFailure, and
    // Stop does not run on an interrupt (docs: hooks) (#23).
    s.running.clear();
  }
  if (event === 'Notification' && WAITING_NOTIFICATIONS.has(h.notification_type)) {
    s.waiting = {
      kind: h.notification_type,
      message: clip(h.message || h.title || ''),
      at,
      toolUseId: h.notification_type === 'permission_prompt' ? pendingToolId(s, null) : null,
    };
  }
  if (event === 'PermissionRequest') {
    s.waiting = {
      kind: 'permission',
      message: `Permission to use ${h.tool_name || 'a tool'}${summary ? `: ${summary}` : ''}`,
      at,
      toolUseId: pendingToolId(s, h.tool_name || null),
    };
  }
  if (event === 'InstructionsLoaded' && h.file_path) {
    s.instructionsLoaded.push({
      path: String(h.file_path),
      memoryType: h.memory_type || null,
      reason: h.load_reason || null,
      trigger: h.trigger_file_path || null,
      parent: h.parent_file_path || null,
      at,
    });
    if (s.instructionsLoaded.length > MAX_EVENTS) s.instructionsLoaded.shift();
  }

  s.events.push({
    at,
    event,
    tool: h.tool_name || null,
    summary: clip(summary),
    detail: clip(h.notification_type || h.load_reason || h.reason || h.error || h.agent_type || h.trigger || ''),
  });
  if (s.events.length > MAX_EVENTS) s.events.shift();
}

/**
 * What the session routes and health need for a launched session, or null.
 * `toolDone(id)`, when given, says whether the transcript already holds that
 * tool's result: the evidence that ends a tool Claude Code never reported
 * finishing (Esc, a denied permission), and a permission wait whose tool has
 * since run (#23).
 */
export function wrappedFor(sessionId, { toolDone = () => false } = {}) {
  const found = sessionFor(sessionId);
  if (!found) return null;
  const { l, s } = found;
  const running = [...s.running.entries()].filter(([id]) => !toolDone(id)).map(([id, t]) => ({ id, ...t }));
  const waiting = s.waiting && !(s.waiting.toolUseId && toolDone(s.waiting.toolUseId)) ? s.waiting : null;
  return {
    launchId: l.id,
    launchedAt: l.createdAt,
    ended: s.ended,
    endReason: s.endReason,
    // Restored after a LayerCake restart and not heard from since.
    unconfirmed: l.restored && !s.lastSeenAt && !s.ended,
    statusline: s.statusline,
    statuslineAt: s.statuslineAt,
    lastHookAt: s.lastHookAt,
    waiting: waiting && { ...waiting, permission: PERMISSION_WAITS.has(waiting.kind) },
    running,
    toolFailures: s.toolFailures,
    instructionsLoaded: s.instructionsLoaded,
    hookCounts: s.hookCounts,
    events: s.events.slice(-40),
  };
}

/**
 * Writes which session ids the launch has carried and which ended. Chained,
 * so two posts close together cannot land their writes out of order and
 * leave the older state on disk. A failure is kept for /api/launches rather
 * than thrown: the hook was already answered, and memory is still right.
 */
function persist(l) {
  const ended = {};
  for (const [id, s] of l.sessions) if (s.ended) ended[id] = s.endReason || 'unknown';
  const record = {
    id: l.id,
    secret: l.secret,
    dir: l.dir,
    sessionId: l.sessionId,
    createdAt: l.createdAt,
    sessionIds: [...l.sessions.keys()],
    ended,
  };
  l.persisting = l.persisting
    .then(() => updateLaunchRecord(record))
    .then(() => {
      l.persistError = null;
    })
    .catch((err) => {
      l.persistError = err.message;
    });
  return l.persisting;
}

export function registerIngestRoutes(app) {
  restoreLaunches().catch(() => {
    /* unreadable app data: launches load one by one as they post, as before */
  });

  app.post('/ingest/:id/:secret/:kind', async (req, res) => {
    if (req.get('origin')) return res.status(403).end();
    let l = launches.get(req.params.id);
    if (!l) {
      // Launched before a restart and not restored yet: the record on disk still holds its secret.
      const record = await readLaunch(req.params.id).catch(() => null);
      if (record) l = registerLaunch(record, { restored: true });
    }
    if (!l) return res.status(404).end();
    if (!secretMatches(l.secret, req.params.secret)) return res.status(403).end();
    if (req.params.kind !== 'statusline' && req.params.kind !== 'hook') return res.status(404).end();

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const at = new Date().toISOString();
    const id = SESSION_ID_RE.test(String(body.session_id || '')) ? body.session_id : l.currentId;
    let changed = false;
    let s = l.sessions.get(id);
    if (!s) {
      s = blankSession();
      l.sessions.set(id, s);
      changed = true;
    }
    l.currentId = id;
    s.lastSeenAt = at;
    const isEnd = req.params.kind === 'hook' && body.hook_event_name === 'SessionEnd';
    if (s.ended && !isEnd) {
      // Back after an end: /resume into this launch, or claude -c in the same terminal.
      s.ended = false;
      s.endReason = null;
      changed = true;
    }

    if (req.params.kind === 'statusline') {
      s.statusline = keepStatusline(body);
      s.statuslineAt = at;
      if (changed) persist(l);
      return res.type('text').send(statusText(body));
    }

    applyHook(s, body, at);
    if (isEnd) {
      s.ended = true;
      s.endReason = typeof body.reason === 'string' ? clip(body.reason, 40) : null;
      changed = true;
    }
    if (changed) persist(l);
    // Empty on purpose: see the zero-token contract at the top of this file.
    return res.status(204).end();
  });
}
