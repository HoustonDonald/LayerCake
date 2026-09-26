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
 * block an action, which is why this module never sends one to a hook, on
 * any path, a failure included.
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
 * thing written down is which session ids a launch carried, since when, and
 * which ended, so a restart does not forget them (#24).
 *
 * State is kept per SESSION within a launch, not per launch (#22). One
 * terminal carries several session ids over its life: /clear starts a new
 * one, /resume switches to another. Launch-wide state showed the new
 * session's numbers, labelled exact, on the old one.
 *
 * Liveness is evidence, not memory (#31, #4). Claude Code's own pid file is
 * the first source (session-routes.js); this is the one used when there is
 * none. The launch's status line re-runs every STATUS_REFRESH_S seconds
 * (statusLine.refreshInterval, docs: status line), EXCEPT while a dialog such
 * as a permission prompt is open: the status line hides then, and its timer
 * stops with it (docs; #41). So a session reports "running" while it has
 * reported within REPORT_WINDOW_MS, or while a wait (a prompt it is showing)
 * or a tool is open. Past that, silence reads as "no report since ...",
 * never as running forever.
 */

import crypto from 'node:crypto';

import { listLaunchRecords, readLaunch, updateLaunchRecord } from './appdata.js';
import { SESSION_ID_RE } from './sessions.js';
import { toolSummary } from './transcript.js';

/** How often a launched session's status line re-runs, in seconds; launch.js puts it in the settings. */
export const STATUS_REFRESH_S = 15;
/**
 * Silence longer than this means the session is not running: three missed
 * refreshes. LAYERCAKE_REPORT_WINDOW_MS shortens it for smoke only.
 */
const REPORT_WINDOW_MS = Number(process.env.LAYERCAKE_REPORT_WINDOW_MS) || STATUS_REFRESH_S * 3 * 1000;

const MAX_EVENTS = 200;
const PREVIEW_CHARS = 200;
/** Sessions remembered per launch; past this the oldest ended ones go (#39). */
const MAX_SESSIONS = 200;
/**
 * A status line landing this soon after its own session's SessionEnd was
 * already in flight (a spawned shell plus curl, against a direct post), so it
 * does not revive the session (#44).
 */
const REVIVE_GRACE_MS = 3000;

/** launchId -> launch. Populated by launch.js and, at startup, from app data. */
const launches = new Map();

/** Hook and status line bodies are untrusted: only strings are read as text (#33). */
const str = (v) => (typeof v === 'string' ? v : '');

function clip(text, max = PREVIEW_CHARS) {
  const s = str(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function blankSession(since = null) {
  return {
    // When this launch first carried the session: persisted, and the tie key
    // for a session found in two launches after a restart (#35).
    since,
    statusline: null,
    statuslineAt: null,
    lastHookAt: null,
    // Last post of any kind: liveness, and the launch that holds the session now.
    lastSeenAt: null,
    events: [],
    waiting: null,
    running: new Map(),
    toolFailures: 0,
    instructionsLoaded: [],
    // No prototype: an event named "constructor" is a count, not Object (#48).
    hookCounts: Object.create(null),
    ended: false,
    endReason: null,
    endedAt: null,
  };
}

function blank(record, restored) {
  const ended = record.ended && typeof record.ended === 'object' ? record.ended : {};
  const since = record.since && typeof record.since === 'object' ? record.since : {};
  const ids = Array.isArray(record.sessionIds) ? record.sessionIds : [record.sessionId];
  const sessions = new Map();
  for (const id of ids.filter((x) => SESSION_ID_RE.test(str(x)))) {
    // A record from before `since` existed: the launch's own time is the best known.
    const s = blankSession(str(since[id]) || str(record.createdAt) || null);
    if (Object.hasOwn(ended, id)) {
      s.ended = true;
      s.endReason = str(ended[id]) || null;
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
    // Restored from disk after a restart: what the hooks said before is gone.
    restored,
    registeredAt: new Date().toISOString(),
    persisting: Promise.resolve(),
    persistError: null,
  };
}

/** Registers a launch so its ingest is accepted. Idempotent for a known id. */
export function registerLaunch(record, { restored = false } = {}) {
  if (!launches.has(record.id)) launches.set(record.id, blank(record, restored));
  return launches.get(record.id);
}

/** Loads every launch record from app data, so a restart does not forget its launches (#24). */
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
 * /resume'd into another launch appears in both: the one that heard from it
 * last wins, and after a restart, when nothing has been heard yet, the one
 * that started carrying it last (#35).
 */
function sessionFor(sessionId) {
  let best = null;
  for (const l of launches.values()) {
    const s = l.sessions.get(sessionId);
    if (!s) continue;
    // Compared as a pair, not one joined string: a missing lastSeenAt must
    // lose to any real one, and '|' sorts after every digit.
    const seen = s.lastSeenAt || '';
    const since = s.since || '';
    if (!best || seen > best.seen || (seen === best.seen && since > best.since)) best = { l, s, seen, since };
  }
  return best;
}

function secretMatches(expected, supplied) {
  const a = Buffer.from(str(supplied));
  const b = Buffer.from(str(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The line Claude Code prints under its prompt for a launched session. */
function statusText(s) {
  const parts = ['LayerCake'];
  const used = num(s.context_window?.used_percentage);
  if (used !== null) parts.push(`ctx ${Math.round(used)}%`);
  const cost = num(s.cost?.total_cost_usd);
  if (cost !== null) parts.push(`$${cost.toFixed(2)}`);
  const five = num(s.rate_limits?.five_hour?.used_percentage);
  if (five !== null) parts.push(`5h ${Math.round(five)}%`);
  const week = num(s.rate_limits?.seven_day?.used_percentage);
  if (week !== null) parts.push(`7d ${Math.round(week)}%`);
  if (s.prompt_cache && typeof s.prompt_cache.warm === 'boolean') parts.push(s.prompt_cache.warm ? 'cache warm' : 'cache cold');
  return parts.join(' · ');
}

/** The subset of the status line JSON kept and shown: numbers and short strings only. */
function keepStatusline(s) {
  const obj = (v) => (v && typeof v === 'object' ? v : null);
  const cost = obj(s.cost);
  const cw = obj(s.context_window);
  const pc = obj(s.prompt_cache);
  const rl = obj(s.rate_limits);
  return {
    sessionId: str(s.session_id) || null,
    model: obj(s.model) ? { id: str(s.model.id) || null, name: str(s.model.display_name) || null } : null,
    version: str(s.version) || null,
    outputStyle: str(s.output_style?.name) || null,
    effort: str(s.effort?.level) || null,
    thinking: typeof s.thinking?.enabled === 'boolean' ? s.thinking.enabled : null,
    cost: cost
      ? {
          totalUSD: num(cost.total_cost_usd),
          durationMs: num(cost.total_duration_ms),
          apiDurationMs: num(cost.total_api_duration_ms),
          linesAdded: num(cost.total_lines_added),
          linesRemoved: num(cost.total_lines_removed),
        }
      : null,
    context: cw ? { usedPercentage: num(cw.used_percentage), windowTokens: num(cw.context_window_size), current: obj(cw.current_usage) } : null,
    rateLimits: rl
      ? Object.fromEntries(
          ['five_hour', 'seven_day']
            .filter((k) => obj(rl[k]))
            .map((k) => [k, { usedPercentage: num(rl[k].used_percentage), resetsAt: num(rl[k].resets_at) ?? (str(rl[k].resets_at) || null) }])
        )
      : null,
    promptCache: pc
      ? { warm: typeof pc.warm === 'boolean' ? pc.warm : null, expiresAt: num(pc.expires_at) ?? (str(pc.expires_at) || null), hitRatio: num(pc.hit_ratio), ttl: num(pc.ttl) ?? (str(pc.ttl) || null) }
      : null,
    worktree: str(s.worktree?.name) || null,
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
 * Posts that prove an ended session is active again (/resume back into it).
 * Not Notification or InstructionsLoaded: those are async and can land after
 * the SessionEnd they belong before (#36).
 */
const REVIVING = new Set(['UserPromptSubmit', 'PreToolUse']);

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
  const event = str(h.hook_event_name) || 'unknown';
  const tool = str(h.tool_name);
  const toolUseId = str(h.tool_use_id);
  s.lastHookAt = at;
  s.hookCounts[event] = (s.hookCounts[event] || 0) + 1;
  if (RESUMING.has(event)) s.waiting = null;

  const summary = tool ? toolSummary(tool, h.tool_input) : '';
  if (event === 'PreToolUse' && toolUseId) {
    s.running.set(toolUseId, { name: tool, summary, at });
  } else if ((event === 'PostToolUse' || event === 'PostToolUseFailure' || event === 'PermissionDenied') && toolUseId) {
    s.running.delete(toolUseId);
    if (event === 'PostToolUseFailure') s.toolFailures += 1;
  } else if (event === 'UserPromptSubmit' || event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd') {
    // A new prompt means every earlier tool finished or was interrupted: Esc
    // on a running tool fires neither PostToolUse nor PostToolUseFailure, and
    // Stop does not run on an interrupt (docs: hooks) (#23).
    s.running.clear();
  }
  const notification = str(h.notification_type);
  if (event === 'Notification' && WAITING_NOTIFICATIONS.has(notification)) {
    s.waiting = {
      kind: notification,
      message: clip(h.message) || clip(h.title),
      at,
      toolUseId: notification === 'permission_prompt' ? pendingToolId(s, null) : null,
    };
  }
  if (event === 'PermissionRequest') {
    s.waiting = {
      kind: 'permission',
      message: `Permission to use ${tool || 'a tool'}${summary ? `: ${summary}` : ''}`,
      at,
      toolUseId: pendingToolId(s, tool || null),
    };
  }
  if (event === 'InstructionsLoaded' && str(h.file_path)) {
    s.instructionsLoaded.push({
      path: str(h.file_path),
      memoryType: str(h.memory_type) || null,
      reason: str(h.load_reason) || null,
      trigger: str(h.trigger_file_path) || null,
      parent: str(h.parent_file_path) || null,
      at,
    });
    if (s.instructionsLoaded.length > MAX_EVENTS) s.instructionsLoaded.shift();
  }

  s.events.push({
    at,
    event: clip(event, 60),
    tool: clip(tool, 120) || null,
    summary: clip(summary),
    detail: clip(notification || str(h.load_reason) || str(h.reason) || str(h.error) || str(h.agent_type) || str(h.trigger)),
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
export function wrappedFor(sessionId, { toolDone = () => false, now = Date.now() } = {}) {
  const found = sessionFor(sessionId);
  if (!found) return null;
  const { l, s } = found;
  const running = [...s.running.entries()].filter(([id]) => !toolDone(id)).map(([id, t]) => ({ id, ...t }));
  const waiting = s.waiting && !(s.waiting.toolUseId && toolDone(s.waiting.toolUseId)) ? s.waiting : null;
  const recent = Boolean(s.lastSeenAt) && now - Date.parse(s.lastSeenAt) <= REPORT_WINDOW_MS;
  // A dialog silences the status line (#41): an open wait or a tool in flight
  // is itself evidence the session was alive when it went quiet.
  const reporting = !s.ended && Boolean(s.lastSeenAt) && (recent || Boolean(waiting) || running.length > 0);
  return {
    launchId: l.id,
    launchedAt: l.createdAt,
    ended: s.ended,
    endReason: s.endReason,
    // Reporting: running, as far as the reports go. Not ended and not
    // reporting is `quiet`, for one of three reasons the UI names:
    //   never reported, fresh launch -> the channels are blocked (#42)
    //   restored, not heard from     -> LayerCake restarted
    //   heard from, silent since     -> it most likely stopped
    reporting,
    quiet: !s.ended && !reporting,
    neverReported: !s.lastSeenAt && !l.restored,
    restored: l.restored,
    registeredAt: l.registeredAt,
    lastSeenAt: s.lastSeenAt,
    reportWindowS: Math.round(REPORT_WINDOW_MS / 1000),
    refreshS: STATUS_REFRESH_S,
    statusline: s.statusline,
    statuslineAt: s.statuslineAt,
    lastHookAt: s.lastHookAt,
    waiting: waiting && { ...waiting, permission: PERMISSION_WAITS.has(waiting.kind) },
    running,
    toolFailures: s.toolFailures,
    instructionsLoaded: s.instructionsLoaded,
    hookCounts: s.hookCounts,
    events: s.events.slice(-40),
    persistError: l.persistError,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Writes which session ids the launch carried, since when, and which ended.
 * Chained, so two posts close together cannot land their writes out of order.
 * A failure is retried with a short backoff (Windows can refuse a rename
 * while another process has the file open, measured about 1 in 300 back to
 * back), then kept, shown in the session view, and retried on the next post
 * (#34). It never reaches the answer: the hook was answered already.
 */
function persist(l) {
  const ended = {};
  const since = {};
  for (const [id, s] of l.sessions) {
    if (s.ended) ended[id] = s.endReason || 'unknown';
    if (s.since) since[id] = s.since;
  }
  const record = {
    id: l.id,
    secret: l.secret,
    dir: l.dir,
    sessionId: l.sessionId,
    createdAt: l.createdAt,
    sessionIds: [...l.sessions.keys()],
    ended,
    since,
  };
  const attempt = async () => {
    for (let i = 0; ; i += 1) {
      try {
        return await updateLaunchRecord(record);
      } catch (err) {
        if (i >= 2) throw err;
        await sleep(100 * (i + 1));
      }
    }
  };
  l.persisting = l.persisting
    .then(attempt)
    .then(() => {
      l.persistError = null;
    })
    .catch((err) => {
      l.persistError = str(err?.message) || 'write failed';
    });
  return l.persisting;
}

/** Keeps a launch's session list bounded: oldest ended sessions go first (#39). */
function trimSessions(l) {
  if (l.sessions.size <= MAX_SESSIONS) return;
  const ended = [...l.sessions.entries()].filter(([, s]) => s.ended).sort((a, b) => str(a[1].since).localeCompare(str(b[1].since)));
  for (const [id] of ended) {
    if (l.sessions.size <= MAX_SESSIONS) break;
    l.sessions.delete(id);
  }
}

/**
 * Applies one post. Returns the status line text for a status line post.
 * A post without a valid session id is answered but changes nothing: after a
 * restart there is no "current" session it could safely belong to (#37).
 */
function applyPost(l, kind, body, at) {
  const id = SESSION_ID_RE.test(str(body.session_id)) ? body.session_id : null;
  if (!id) return;
  let changed = false;
  let s = l.sessions.get(id);
  if (!s) {
    s = blankSession(at);
    l.sessions.set(id, s);
    trimSessions(l);
    changed = true;
  }
  s.lastSeenAt = at;
  const event = kind === 'hook' ? str(body.hook_event_name) : '';
  const lateStatusline = kind === 'statusline' && s.endedAt && Date.parse(at) - Date.parse(s.endedAt) < REVIVE_GRACE_MS;
  if (s.ended && (REVIVING.has(event) || (kind === 'statusline' && !lateStatusline))) {
    // Active again after an end: /resume back into this session. It is taken
    // on again now, which is what the restart tie-break needs to know (#47).
    s.ended = false;
    s.endReason = null;
    s.endedAt = null;
    s.since = at;
    changed = true;
  }
  if (kind === 'statusline') {
    s.statusline = keepStatusline(body);
    s.statuslineAt = at;
  } else {
    applyHook(s, body, at);
    if (event === 'SessionEnd') {
      s.ended = true;
      s.endReason = clip(body.reason, 40) || null;
      s.endedAt = at;
      changed = true;
    }
  }
  if (changed || l.persistError) persist(l);
}

export function registerIngestRoutes(app) {
  restoreLaunches().catch(() => {
    /* unreadable app data: launches load one by one as they post, below */
  });

  app.post('/ingest/:id/:secret/:kind', async (req, res) => {
    const kind = req.params.kind;
    try {
      if (req.get('origin')) return res.status(403).end();
      let l = launches.get(req.params.id);
      if (!l) {
        // Not restored at startup (written since, or the restore failed): the record on disk still holds its secret.
        const record = await readLaunch(req.params.id).catch(() => null);
        if (record) l = registerLaunch(record, { restored: true });
      }
      if (!l) return res.status(404).end();
      if (!secretMatches(l.secret, req.params.secret)) return res.status(403).end();
      if (kind !== 'statusline' && kind !== 'hook') return res.status(404).end();

      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      applyPost(l, kind, body, new Date().toISOString());
      if (kind === 'statusline') return res.type('text').send(statusText(body));
      // Empty on purpose: see the zero-token contract at the top of this file.
      return res.status(204).end();
    } catch {
      // Errors are values: a malformed body must not take the server down
      // (Express 4 does not catch a rejected async handler, and Node exits on
      // it), and a hook still gets an empty answer (#33).
      if (!res.headersSent) res.status(kind === 'statusline' ? 200 : 204).end();
      return undefined;
    }
  });
}
