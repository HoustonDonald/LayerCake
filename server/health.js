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
    rule: 'Launched by LayerCake, and Claude Code reported a permission request or that it is waiting for input, with nothing since. Sessions LayerCake did not launch cannot report this.',
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
  'Window from the model id: "[1m]" or a native-1M family (Fable 5.x, Sonnet 5, Opus 4.7 and later) is 1,000,000 tokens; otherwise 200,000.';

export function contextWindow(modelId, models) {
  const ids = [modelId, ...Object.keys(models || {})].filter(Boolean).map((s) => s.toLowerCase());
  if (ids.some((id) => id.includes('[1m]'))) return 1_000_000;
  const native = /fable-5|mythos-5|sonnet-5|opus-4-[7-9]|opus-5/;
  if (ids.some((id) => native.test(id))) return 1_000_000;
  return 200_000;
}

export function computeHealth(model, live, { now = Date.now(), mtimeMs = 0, wrapped = null } = {}) {
  // A launched session's status line reports the exact figure; everything else
  // is estimated from the transcript's last API call.
  const exact = wrapped?.statusline?.context;
  const window = exact?.windowTokens || contextWindow(model.modelId, model.models);
  const tokens = model.context?.tokens ?? null;
  const pct =
    typeof exact?.usedPercentage === 'number' ? exact.usedPercentage / 100 : tokens ? tokens / window : null;
  const source = typeof exact?.usedPercentage === 'number' ? 'status line (exact)' : 'transcript (estimate)';
  const reasons = [];
  const flags = new Set();
  if (live && wrapped?.waiting) {
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
    reasons.push(busy ? 'Claude Code reports it busy' : writing ? 'Transcript written in the last 15 s' : 'Running, not busy');
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
    context: { tokens, window, pct, source, rule: CONTEXT_RULE },
    states: HEALTH_STATES,
  };
}
