/**
 * Session health: one state per session for the glow, with the reasons that
 * produced it and the rules themselves shipped in the same payload. The rules
 * are this tool's own judgement, not something Claude Code reports, so they are
 * stated rather than implied (the same invariant as the settings merge rules).
 */

/** Most severe first. The UI reads colour and label from here, never from its own list. */
export const HEALTH_STATES = [
  { state: 'error', label: 'Error', rule: 'An API error (including rate limits) in the last 10 minutes of activity.' },
  {
    state: 'waiting',
    label: 'Waiting for you',
    rule: 'Launched by LayerCake and running, and Claude Code reported a permission request or that it is waiting for input, with nothing since. An open prompt keeps the session counted as running even though Claude Code hides the status line while it is shown. Sessions LayerCake did not launch cannot report this.',
  },
  { state: 'warning', label: 'Context high', rule: 'Context at or above 80% of the model window.' },
  { state: 'working', label: 'Working', rule: 'Running, and Claude Code reports it busy or it wrote to its transcript in the last 15 seconds.' },
  { state: 'idle', label: 'Idle', rule: 'Running, not busy.' },
  { state: 'offline', label: 'Not running', rule: 'No running Claude Code process for this session.' },
];

const RECENT_ERROR_MS = 10 * 60 * 1000;
const RECENT_WRITE_MS = 15 * 1000;
const CONTEXT_WARNING = 0.8;

/**
 * Context window assumed from the model id. Stated because it is an
 * assumption: a "[1m]" id is 1M; the families Anthropic documents as native
 * 1M on every plan (Fable 5.x, Sonnet 5, Opus 4.7 and later) are 1M; anything
 * else is taken as 200K, Claude Code's default.
 */
export const CONTEXT_RULE =
  'Window from the model in use now: "[1m]" or a native-1M family (Fable 5.x, Sonnet 5, Opus 4.7 and later) is 1,000,000 tokens; otherwise 200,000. Opus and Sonnet 4.6 reach 1M in Claude Code only as a "[1m]" variant. If the session already holds more context than that, the window must be larger, so it is taken as 1,000,000: a new model family the list does not know yet shows up this way.';

/**
 * The model in use now decides the window, not every model the session ever
 * used: a switch from a 1M model to Haiku (200K) must shrink it, or 180K reads
 * as 18% and "Context high" never fires. The latest identity record carries
 * the "[1m]" marker; it counts only while it names the model the last API
 * call actually used.
 */
export function contextWindow(identityId, lastModel) {
  const last = String(lastModel || '').toLowerCase();
  const identity = String(identityId || '').toLowerCase();
  const current = identity && (!last || identity.replace('[1m]', '') === last) ? identity : last;
  if (!current) return 200_000;
  if (current.includes('[1m]')) return 1_000_000;
  if (/fable-5|mythos-5|sonnet-5|opus-4-[7-9]|opus-5/.test(current)) return 1_000_000;
  return 200_000;
}

export function computeHealth(model, live, { now = Date.now(), mtimeMs = 0, wrapped = null } = {}) {
  // A launched session's status line reports the exact figure; everything else
  // is estimated from the transcript's last API call. Only this session's own
  // status line counts, and only while it has not ended: after /clear or an
  // exit, the last line heard is another session's, or a stale one (#22).
  // Liveness, not recent reports: a dialog hides the status line, so a live
  // session at a permission prompt keeps its last exact reading (#41).
  const own = live && wrapped && !wrapped.ended && wrapped.statusline?.sessionId === model.sessionId;
  const exact = own ? wrapped.statusline.context : null;
  const tokens = model.context?.tokens ?? null;
  // The model-id table goes stale when a new 1M family ships, and a stale
  // 200K reads a 350K session as 175% (#12). Context the session already
  // holds is proof the window is at least that big, whatever the table says.
  const inferred = contextWindow(model.modelId, model.lastModel);
  const observedLarger = typeof tokens === 'number' && tokens > inferred;
  const window = exact?.windowTokens || (observedLarger ? 1_000_000 : inferred);
  const windowSource = exact?.windowTokens ? 'status line' : observedLarger ? 'observed usage' : 'model id';
  const pct =
    typeof exact?.usedPercentage === 'number' ? exact.usedPercentage / 100 : tokens ? tokens / window : null;
  const source = typeof exact?.usedPercentage === 'number' ? 'status line (exact)' : 'transcript (estimate)';
  const reasons = [];
  const flags = new Set();
  if (live && wrapped && !wrapped.ended && wrapped.waiting) {
    flags.add('waiting');
    reasons.push(wrapped.waiting.message || 'Waiting for you');
  }

  const lastAt = model.lastAt ? Date.parse(model.lastAt) : 0;
  const recentErrors = model.errors.filter((e) => e.at && lastAt - Date.parse(e.at) <= RECENT_ERROR_MS);
  if (recentErrors.length) {
    flags.add('error');
    const last = recentErrors[recentErrors.length - 1];
    reasons.push(`API error${last.code ? ` (${last.code})` : ''} at ${last.at}`);
  }
  if (pct !== null && pct >= CONTEXT_WARNING) {
    flags.add('warning');
    reasons.push(`Context at ${Math.round(pct * 100)}% of ${window.toLocaleString()} tokens`);
  }

  let base = 'offline';
  if (live) {
    const busy = live.status === 'busy';
    const writing = mtimeMs && now - mtimeMs <= RECENT_WRITE_MS;
    base = busy || writing ? 'working' : 'idle';
    // "busy" from hooks is LayerCake's inference from a tool in flight, not
    // something Claude Code said (#23).
    const busyReason = live.source === 'hooks' ? 'A tool is running (from its hooks)' : 'Claude Code reports it busy';
    reasons.push(busy ? busyReason : writing ? 'Transcript written in the last 15 s' : 'Running, not busy');
  } else if (wrapped?.quiet) {
    // A launched session's status line re-runs every refreshS seconds except
    // while a dialog is open, and an open dialog LayerCake knows of keeps it
    // counted as running, so silence past the window is strong evidence, not
    // proof: hence "most likely" (#31, #41).
    const every = `a running launched session reports every ${wrapped.refreshS} s unless a dialog is open`;
    if (wrapped.neverReported) {
      // Both channels silent from the start: something blocks them (#42).
      reasons.push(
        'Launched from LayerCake, but its status line and hooks have never reported: workspace trust not accepted, ' +
          '--safe-mode, disableAllHooks, or a managed hook policy silences both'
      );
    } else if (wrapped.restored && !wrapped.lastSeenAt) {
      const sinceRestart = now - Date.parse(wrapped.registeredAt);
      reasons.push(
        sinceRestart <= wrapped.reportWindowS * 1000
          ? `LayerCake restarted moments ago; waiting for this session's next report (${every})`
          : `No report since LayerCake restarted; ${every}, so it has most likely stopped`
      );
    } else {
      reasons.push(`No report for over ${wrapped.reportWindowS} s and no prompt open; ${every}, so it has most likely stopped (it crashed, or its terminal closed)`);
    }
  } else {
    reasons.push('No running process');
  }

  const order = HEALTH_STATES.map((s) => s.state);
  const candidates = [base, ...flags];
  // An offline session keeps its warnings visible but never glows as live.
  const state = live ? candidates.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] : 'offline';

  return {
    state,
    reasons,
    flags: [...flags],
    context: { tokens, window, windowSource, pct, source, rule: CONTEXT_RULE },
    states: HEALTH_STATES,
  };
}
