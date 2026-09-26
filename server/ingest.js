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
 * names and one-line summaries, never tool input or output bodies.
 */

import crypto from 'node:crypto';

import { readLaunch } from './appdata.js';
import { toolSummary } from './transcript.js';

const MAX_EVENTS = 200;
const PREVIEW_CHARS = 200;

/** launchId -> launch record. Populated by launch.js and, after a restart, from app data. */
const launches = new Map();

function clip(text, max = PREVIEW_CHARS) {
  const s = typeof text === 'string' ? text : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function blank(record) {
  return {
    ...record,
    sessionIds: new Set(record.sessionIds || (record.sessionId ? [record.sessionId] : [])),
    statusline: null,
    statuslineAt: null,
    lastHookAt: null,
    events: [],
    waiting: null,
    running: new Map(),
    toolFailures: 0,
    instructionsLoaded: [],
    hookCounts: {},
    // Session ids whose SessionEnd hook has fired. /clear ends one id and the
    // status line then reports the next, so this is per id, not per launch.
    ended: new Set(),
  };
}

/** Registers a launch so its ingest is accepted. Idempotent for a known id. */
export function registerLaunch(record) {
  if (!launches.has(record.id)) launches.set(record.id, blank(record));
  return launches.get(record.id);
}

export function listLaunches() {
  return [...launches.values()].map((l) => ({
    id: l.id,
    dir: l.dir,
    createdAt: l.createdAt,
    sessionIds: [...l.sessionIds],
    statuslineAt: l.statuslineAt,
    lastHookAt: l.lastHookAt,
  }));
}

function launchFor(sessionId) {
  for (const l of launches.values()) if (l.sessionIds.has(sessionId)) return l;
  return null;
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

const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'agent_needs_input']);
/** Events that mean Claude is moving again, so a pending "waiting" is over. */
const RESUMING = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd']);

function applyHook(l, h, at) {
  const event = String(h.hook_event_name || 'unknown');
  l.lastHookAt = at;
  l.hookCounts[event] = (l.hookCounts[event] || 0) + 1;
  if (RESUMING.has(event)) l.waiting = null;

  const summary = h.tool_name ? toolSummary(String(h.tool_name), h.tool_input) : '';
  if (event === 'PreToolUse' && h.tool_use_id) {
    l.running.set(h.tool_use_id, { name: h.tool_name, summary, at });
  } else if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && h.tool_use_id) {
    l.running.delete(h.tool_use_id);
    if (event === 'PostToolUseFailure') l.toolFailures += 1;
  } else if (event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd') {
    l.running.clear();
  }
  if (event === 'SessionEnd' && typeof h.session_id === 'string') l.ended.add(h.session_id);
  if (event === 'Notification' && WAITING_NOTIFICATIONS.has(h.notification_type)) {
    l.waiting = { kind: h.notification_type, message: clip(h.message || h.title || ''), at };
  }
  if (event === 'PermissionRequest') {
    l.waiting = { kind: 'permission', message: `Permission to use ${h.tool_name || 'a tool'}${summary ? `: ${summary}` : ''}`, at };
  }
  if (event === 'InstructionsLoaded' && h.file_path) {
    l.instructionsLoaded.push({
      path: String(h.file_path),
      memoryType: h.memory_type || null,
      reason: h.load_reason || null,
      trigger: h.trigger_file_path || null,
      parent: h.parent_file_path || null,
      at,
    });
    if (l.instructionsLoaded.length > MAX_EVENTS) l.instructionsLoaded.shift();
  }

  l.events.push({
    at,
    event,
    tool: h.tool_name || null,
    summary: clip(summary),
    detail: clip(h.notification_type || h.load_reason || h.error || h.agent_type || h.trigger || ''),
  });
  if (l.events.length > MAX_EVENTS) l.events.shift();
}

/** What the session routes and health need for a launched session, or null. */
export function wrappedFor(sessionId) {
  const l = launchFor(sessionId);
  if (!l) return null;
  return {
    launchId: l.id,
    launchedAt: l.createdAt,
    ended: l.ended.has(sessionId),
    statusline: l.statusline,
    statuslineAt: l.statuslineAt,
    lastHookAt: l.lastHookAt,
    waiting: l.waiting,
    running: [...l.running.entries()].map(([id, t]) => ({ id, ...t })),
    toolFailures: l.toolFailures,
    instructionsLoaded: l.instructionsLoaded,
    hookCounts: l.hookCounts,
    events: l.events.slice(-40),
  };
}

export function registerIngestRoutes(app) {
  app.post('/ingest/:id/:secret/:kind', async (req, res) => {
    if (req.get('origin')) return res.status(403).end();
    let l = launches.get(req.params.id);
    if (!l) {
      // Launched before a restart: the record on disk still holds its secret.
      const record = await readLaunch(req.params.id).catch(() => null);
      if (record) l = registerLaunch(record);
    }
    if (!l) return res.status(404).end();
    if (!secretMatches(l.secret, req.params.secret)) return res.status(403).end();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const at = new Date().toISOString();
    if (body.session_id && typeof body.session_id === 'string') l.sessionIds.add(body.session_id);

    if (req.params.kind === 'statusline') {
      l.statusline = keepStatusline(body);
      l.statuslineAt = at;
      return res.type('text').send(statusText(body));
    }
    if (req.params.kind === 'hook') {
      applyHook(l, body, at);
      // Empty on purpose: see the zero-token contract at the top of this file.
      return res.status(204).end();
    }
    return res.status(404).end();
  });
}
