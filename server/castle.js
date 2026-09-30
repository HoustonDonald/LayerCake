/**
 * The Castle (#159, #160): a live picture of the Claude Code sessions working
 * in one project, as rooms that light up and units that stand in them. The
 * owner's spec is kept outside the repository; README "Castle" is the spec
 * for what is built. Its first principle is "nothing lies": every room state
 * and every unit here comes from a real event, and when the data is missing
 * the Castle shows less, not more.
 *
 * Two sources, merged (owner decision 2026-09-29):
 *   - hooks, for sessions LayerCake launched: ingest.js keeps a ring of
 *     reduced records per session (castleFeed);
 *   - transcripts, for every other running session in the project, and to
 *     backfill a launched one: transcript.js's readers, main and subagent.
 * Tool events are keyed by tool_use_id, which the hooks and the transcript
 * share (the #23 code already relies on it), so a call seen by both counts
 * once and the hook, which arrives first, wins.
 *
 * State exists only while a stream is open for the project. One poller per
 * project serves all its streams: it refreshes the transcript readers it holds
 * every second, re-picks the sessions every few seconds, and recomputes when a
 * hook arrives. The room states are a pure fold of the merged events under the
 * current map, with `now` injected: the fold IS the specification of what a
 * room shows. It is recomputed from scratch each time, with each file's
 * location cached per map version; that costs milliseconds (measured in the
 * commit), so no incremental path exists to drift from it.
 *
 * Everything served is paths, tool names, one-line summaries and states. No
 * tool input or output body, and no command heads, leave this module.
 */

import { castleFeed, listLaunches, onCastleRecord, wrappedFor } from './ingest.js';
import { isInsideDir, projectSlug, samePathKey } from './paths.js';
import { liveFrom } from './session-routes.js';
import { discoverSessions, getReader, liveSessions, readSubagentMeta, subagentFiles } from './sessions.js';
import { SHELL_TOOLS, SubagentReader } from './transcript.js';
import { ROOM_TYPES, classifyCommand, draftPrompt, loadMap, locate, locateFolder } from './castlemap.js';

/**
 * Every time window, scaled for the smoke test only (LAYERCAKE_CASTLE_TIME_SCALE,
 * like LAYERCAKE_REPORT_WINDOW_MS), clamped so a stray value cannot make them
 * zero or longer than the spec's.
 */
const SCALE = Math.min(1, Math.max(0.01, Number(process.env.LAYERCAKE_CASTLE_TIME_SCALE) || 1));
const scaled = (ms) => Math.round(ms * SCALE);
export const WINDOWS = {
  activeMs: scaled(60_000),
  restMs: scaled(60_000),
  heatHalfLifeMs: scaled(45_000),
  thrashWindowMs: scaled(10 * 60_000),
  thrashEdits: 4,
  // How long a thrash stays up after the last edit of its file (#170, owner
  // decision 2026-09-30: 2 minutes, while edits count over 10).
  thrashLapseMs: scaled(2 * 60_000),
};

const MAX_SESSIONS = 6;
const MAX_LOG = 200;
const MAX_RECENT = 20;
const MAX_RUNS = 20;
/** Files listed for Hollowmere and for the Citadel (their counts stay whole). */
const MAX_LISTED = 200;
const TICK_MS = 1000;
/** Sessions are re-picked every 5 s (every second in smoke, whose windows are scaled down). */
const SELECT_EVERY_TICKS = Math.max(1, Math.round(5 * SCALE));
const FLUSH_MS = 250;
const MAX_CACHE = 20_000;
const MAX_LAGS = 20;
/**
 * Room changes kept per Mason and Knight, for the page to walk (#161). A frame
 * goes out within 250 ms of a hook and each second from transcripts, so a room
 * is left out of a walk only when one unit changes room more times than this
 * inside one of those windows (a burst of parallel calls alternating rooms).
 */
const MAX_TRAIL = 12;
/**
 * Events folded per castle. A refold of 20,000 took a median 18 ms (5,000: 5 ms)
 * on this machine under load (bench-fold, 2026-09-29); past it the oldest are
 * left out and the state frame says how many, so a very long session's first
 * hours can go dark rather than the server slowing down.
 */
const MAX_EVENTS = 20_000;

const secs = (ms) => {
  const s = ms / 1000;
  return s >= 60 && s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${Number(s.toFixed(1))} seconds`;
};

/**
 * Room states, highest priority first, with the rule that produces each. The
 * page reads label, glyph and rule from here, never from a list of its own
 * (the health.js pattern): the rules are this tool's judgement, so they are
 * stated with the value.
 */
export const ROOM_STATES = [
  {
    state: 'alarm',
    label: 'Alarm',
    glyph: '!',
    rule: `A change to a file here failed; or a test or build run failed while this room had unproven changes; or one file here was edited ${WINDOWS.thrashEdits} or more times within ${secs(WINDOWS.thrashWindowMs)} with no passing test or build between. A failed change clears on a later successful call in the room; a failed run on a passing proof run (a failed build also on a passing build); thrash on any passing test or build, or once ${secs(WINDOWS.thrashLapseMs)} pass with no further edit of that file.`,
  },
  { state: 'construction', label: 'Construction', glyph: '⚒', rule: `A file here was edited or created in the last ${secs(WINDOWS.activeMs)}.` },
  { state: 'survey', label: 'Survey', glyph: '◎', rule: `Read, searched, or worked on by a shell command in the last ${secs(WINDOWS.activeMs)}, with no change.` },
  { state: 'proven', label: 'Proven', glyph: '✓', rule: 'Changed, then a proof run passed (see "Proof" on the map), and not changed since. Ends when the session that ran it ends.' },
  { state: 'embers', label: 'Embers', glyph: '∙', rule: 'Touched by the current sessions, quiet now. Brightness follows recent activity.' },
  { state: 'dark', label: 'Dark', glyph: '', rule: 'Not touched by the current sessions.' },
];

export const UNIT_KINDS = [
  { kind: 'mason', letter: 'M', label: 'Mason', rule: `A session. Walks the corridors to the room of its latest tool call, through each room it worked in on the way, in order; rests once ${secs(WINDOWS.restMs)} pass with no call running; walks out of the gate when the session ends.` },
  { kind: 'knight', letter: 'K', label: 'Knight', rule: 'A subagent, from its start to its stop: enters by the gate, walks to the room of each tool call as a Mason does, and walks out of the gate when it stops.' },
  { kind: 'wizard', letter: 'W', label: 'Wizard', rule: "A skill Claude invoked, beside the unit that called it, following it, until that unit's turn ends or it calls another skill. A skill you type as /name is not seen." },
  { kind: 'raven', letter: 'R', label: 'Raven', rule: 'An MCP tool call: flies up to the wall above the first Integrations room (above the gate when there is none), and back when the call returns.' },
  { kind: 'scout', letter: 'S', label: 'Scout', rule: 'A web fetch or search: walks out of the gate, and back when the call returns.' },
  { kind: 'herald', letter: 'H', label: 'Herald', rule: 'Claude is waiting for you (a permission or input prompt). Only sessions started from LayerCake can report this.' },
  { kind: 'raiders', letter: 'A', label: 'Raiders', rule: "A test run, while it runs: a band out of the Wilds, or at the front, whichever is nearer, shooting over the wall at the rooms the run will judge (those with unproven changes, else the run's own room). Leaves when the run ends or its turn is interrupted." },
  { kind: 'siege', letter: 'E', label: 'Siege engine', rule: "A build run, while it runs: an engine before the gate lobbing stones at the rooms the build will judge (those with unproven changes, else the run's own room). Leaves when the run ends or its turn is interrupted." },
];

export const CASTLE_RULES = [
  'Only real events move anything: hooks from sessions LayerCake started, and the transcripts of the others. When nothing is known, the castle shows less.',
  "A file's room comes from castle.json's patterns, else the built-in ones; a file no room claims is in Hollowmere, the village south of the gate, and a file outside the project (the home folder, Claude's configuration, other projects) goes to the Citadel and is counted apart.",
  'A shell call is a test, build or migration run when a segment of its command starts with a rule\'s words. A run lights the room its rule names, else the first room of its type (Tests, Build, Database); any other shell call works in the first Build room, else the first Config room. A run passes or fails by its exit code, so `npm test | tail` reads as the exit code of tail. A run started in the background, or ending with no exit code (refused before it ran, timed out), has no verdict.',
  'A run judges every room with unproven changes (the scaffolded ones): a pass takes their scaffolding down, a failure raises their Alarm, and a failure with none to judge raises it in the run\'s own room.',
  `No run can prove a ${ROOM_TYPES.filter((t) => t.provable === false).map((t) => t.label).join(' or ')} room: a change there puts up no scaffolding, no run judges it, and it has no thrash. A failed change there is still an Alarm.`,
  'A call that was denied, interrupted, rejected, or refused by Claude Code before it ran has no verdict: it is never an Alarm. From a transcript, an error counts as a failure only with evidence the tool ran (an exit code, or a system error code such as EACCES).',
  'Heat: read 1, search 1, shell 2, edit 3, create 4, halving every ' + secs(WINDOWS.heatHalfLifeMs) + '. It sets brightness within a state, never the state.',
];

const WEIGHT = { read: 1, search: 1, shell: 2, edit: 3, create: 4 };

export function verbOf(tool) {
  const t = typeof tool === 'string' ? tool : '';
  if (t === 'Read' || t === 'NotebookRead') return 'read';
  if (t === 'Grep' || t === 'Glob' || t === 'LS') return 'search';
  if (t === 'Edit' || t === 'MultiEdit' || t === 'NotebookEdit') return 'edit';
  if (t === 'Write') return 'create';
  if (SHELL_TOOLS.has(t)) return 'shell';
  if (t === 'WebFetch' || t === 'WebSearch') return 'web';
  if (t.startsWith('mcp__')) return 'mcp';
  if (t === 'Skill') return 'skill';
  if (t === 'Agent' || t === 'Task') return 'agent';
  return 'other';
}

const iso = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Hook ring records to events. */
function hookEvents(sessionId, records) {
  const out = [];
  records.forEach((r, i) => {
    const at = iso(r.at);
    if (at === null) return;
    const base = { at, sessionId, source: 'hooks', agentId: r.agentId || null, agentType: r.agentType || null };
    const call = { tool: r.tool, toolUseId: r.toolUseId, summary: r.summary || '', targets: r.targets };
    switch (r.event) {
      case 'PreToolUse':
        out.push({ ...base, ...call, kind: 'call-start', key: r.toolUseId ? `s:${r.toolUseId}` : `h:${sessionId}:${i}` });
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        out.push({ ...base, ...call, kind: 'call-end', verdict: r.verdict, writeType: r.writeType, key: r.toolUseId ? `e:${r.toolUseId}` : `h:${sessionId}:${i}` });
        break;
      case 'SubagentStart':
        if (r.agentId) out.push({ ...base, kind: 'agent-start', key: `as:${r.agentId}` });
        break;
      case 'SubagentStop':
        if (r.agentId) out.push({ ...base, kind: 'agent-end', key: `ae:${r.agentId}` });
        break;
      case 'UserPromptSubmit':
        out.push({ ...base, kind: 'turn', key: `h:${sessionId}:${i}` });
        break;
      case 'Stop':
      case 'StopFailure':
        out.push({ ...base, kind: 'stop', key: `h:${sessionId}:${i}` });
        break;
      case 'SessionEnd':
        out.push({ ...base, kind: 'session-end', key: `end:${sessionId}` });
        break;
      case 'PreCompact':
      case 'PostCompact':
        out.push({ ...base, kind: 'compact', key: `h:${sessionId}:${i}`, summary: r.event === 'PreCompact' ? 'Compacting the conversation' : 'Compacted' });
        break;
      default:
        break;
    }
  });
  return out;
}

/** One transcript tool call to its start and end events. */
function toolEvents(sessionId, tool, agentId, agentType, source) {
  const out = [];
  const at = iso(tool.at);
  if (at === null || !tool.id) return out;
  const call = { tool: tool.name, toolUseId: tool.id, summary: tool.summary || '', targets: tool.targets };
  out.push({ at, sessionId, source, agentId, agentType, ...call, kind: 'call-start', key: `s:${tool.id}` });
  const end = iso(tool.endAt);
  if (tool.done && end !== null) {
    out.push({ at: end, sessionId, source, agentId, agentType, ...call, kind: 'call-end', verdict: tool.verdict, writeType: tool.writeType, key: `e:${tool.id}` });
  }
  return out;
}

/**
 * A transcript's events: its prompts (turns), its tool calls, and each
 * subagent's. `hooksSince` is when the session's hook records begin: a prompt
 * from then on is already a UserPromptSubmit, and has no shared id to dedupe on.
 */
function transcriptEvents(entry, hooksSince) {
  const out = [];
  const { sessionId, reader } = entry;
  if (!reader) return out;
  for (const turn of reader.model.turns) {
    const at = iso(turn.at);
    if (at !== null && at < hooksSince && (turn.kind === 'prompt' || turn.kind === 'command' || turn.kind === 'bash')) {
      out.push({ at, sessionId, source: 'transcript', agentId: null, kind: 'turn', key: `t:${sessionId}:${turn.n}` });
    }
    for (const tool of turn.tools) out.push(...toolEvents(sessionId, tool, null, null, 'transcript'));
  }
  for (const sub of entry.subs.values()) {
    const first = iso(sub.reader.firstAt);
    if (first === null) continue;
    const agentType = sub.meta?.agentType || sub.parent?.type || null;
    out.push({ at: first, sessionId, source: 'transcript', agentId: sub.agentId, agentType, kind: 'agent-start', key: `as:${sub.agentId}` });
    for (const tool of sub.reader.tools) out.push(...toolEvents(sessionId, tool, sub.agentId, agentType, 'transcript'));
    if (sub.endedAt !== null) out.push({ at: sub.endedAt, sessionId, source: 'transcript', agentId: sub.agentId, agentType, kind: 'agent-end', key: `ae:${sub.agentId}` });
  }
  return out;
}

const KIND_ORDER = { 'agent-start': 0, turn: 1, 'call-start': 2, 'call-end': 3, stop: 4, 'agent-end': 5, compact: 6, 'session-end': 7 };

/**
 * Hook events first, so where both sources report a call the hook's copy is
 * kept; then the transcript fills in what the hooks did not see. The kept copy
 * takes the earlier of the two times, so the order does not depend on which
 * source was read first: parallel calls the transcript recorded before their
 * hooks arrived otherwise moved behind each other as each hook landed, and a
 * Mason walked their rooms twice (#161).
 */
export function mergeEvents(lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const e of list) {
      const had = byKey.get(e.key);
      if (!had) byKey.set(e.key, e);
      else if (e.at < had.at) byKey.set(e.key, { ...had, at: e.at });
    }
  }
  return [...byKey.values()].sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

function blankRoom() {
  return {
    heat: { v: 0, t: 0 },
    lastRead: null,
    lastChange: null,
    touchedAt: null,
    unproven: false,
    proven: null,
    alarms: { tool: null, run: null, thrash: null },
    recent: [],
    lastChangedFile: null,
  };
}

function addHeat(room, weight, at, halfLife) {
  const decayed = room.heat.v * 0.5 ** Math.max(0, (at - room.heat.t) / halfLife);
  room.heat = { v: decayed + weight, t: at };
}

function pushRecent(list, item, max) {
  const i = list.findIndex((x) => x.path === item.path);
  if (i !== -1) list.splice(i, 1);
  list.unshift(item);
  if (list.length > max) list.length = max;
}

function verdictText(v) {
  if (!v) return null;
  if (v.ok === true) return 'ok';
  if (v.ok === false) return v.exitCode !== null && v.exitCode !== undefined ? `failed (exit ${v.exitCode})` : 'failed';
  return `no verdict (${v.reason})`;
}

/**
 * The fold: every event, in order, applied to a blank castle. `locateCall`
 * resolves an event to rooms (cached by the caller); `now` is not read here,
 * only in view(), so the fold is the same whenever it runs.
 */
export function fold(events, map, locateCall) {
  const rooms = new Map(map.rooms.map((r) => [r.id, blankRoom()]));
  const proof = new Set(map.proof);
  const unprovableTypes = new Set(ROOM_TYPES.filter((t) => t.provable === false).map((t) => t.type));
  const unprovable = new Set(map.rooms.filter((r) => unprovableTypes.has(r.type)).map((r) => r.id));
  const calls = new Map();
  const files = new Map();
  const runs = [];
  const units = new Map();
  // Files no room claims: Hollowmere, the village south of the gate (#172).
  const village = new Map();
  const outside = new Map();
  const log = [];
  const sessions = new Map();
  let changedMapAt = null;

  const session = (e) => {
    let s = sessions.get(e.sessionId);
    if (!s) {
      s = { firstAt: e.at, lastAt: e.at, endedAt: null };
      sessions.set(e.sessionId, s);
    }
    s.lastAt = e.at;
    return s;
  };
  const callerKey = (e) => (e.agentId ? `K:${e.agentId}` : `M:${e.sessionId}`);
  const ensureCaller = (e) => {
    const key = callerKey(e);
    let u = units.get(key);
    if (!u) {
      u = e.agentId
        ? { key, kind: 'knight', sessionId: e.sessionId, agentId: e.agentId, agentType: e.agentType || null, room: 'gate', trail: [], since: e.at, lastCallAt: null, last: null }
        : { key, kind: 'mason', sessionId: e.sessionId, agentId: null, room: 'gate', trail: [], since: e.at, lastCallAt: null, last: null };
      units.set(key, u);
    }
    if (e.agentType && !u.agentType) u.agentType = e.agentType;
    return u;
  };
  const dropWizardsOf = (caller) => {
    for (const [k, u] of units) if (u.kind === 'wizard' && u.caller === caller) units.delete(k);
  };
  const finishRun = (run, verdict, at) => {
    run.endAt = at;
    run.ok = verdict ? verdict.ok : null;
    run.exitCode = verdict?.exitCode ?? null;
    run.noVerdict = verdict && verdict.ok === null ? verdict.reason : run.background ? 'started in the background' : null;
    if (run.background) run.ok = null;
    // A run passes or fails by its exit code: a failure without one (a
    // timeout, a kill) says nothing about the tests (#164).
    if (run.ok === false && run.exitCode === null) {
      run.ok = null;
      run.noVerdict = 'no exit code';
    }
    if (run.ok === null) return;
    const judged = [...rooms.entries()].filter(([, r]) => r.unproven).map(([id]) => id);
    run.judged = judged;
    const cause = { kind: 'run', runId: run.id, runKind: run.kind, summary: run.summary, exitCode: run.exitCode, at, sessionId: run.sessionId };
    if (run.ok) {
      // Thrash is "edited again and again with no passing test OR build in
      // between" (spec), so any passing run ends it, whatever counts as proof.
      for (const r of rooms.values()) {
        r.alarms.thrash = null;
        if (r.alarms.run && r.alarms.run.runKind === run.kind) r.alarms.run = null;
      }
      files.clear();
      if (proof.has(run.kind)) {
        for (const id of judged) {
          const r = rooms.get(id);
          r.proven = { runId: run.id, at, sessionId: run.sessionId, summary: run.summary };
          r.unproven = false;
        }
        for (const r of rooms.values()) r.alarms.run = null;
      }
    } else {
      const targets = judged.length ? judged : rooms.has(run.room) ? [run.room] : [];
      for (const id of targets) rooms.get(id).alarms.run = cause;
    }
  };

  // One log line per call: its start adds it, its end fills in the verdict.
  const logByCall = new Map();

  for (const e of events) {
    const s = session(e);
    const entry = { id: e.toolUseId || null, at: e.at, sessionId: e.sessionId, agentId: e.agentId || null, source: e.source, kind: e.kind, tool: e.tool || null, summary: e.summary || '', where: null, verdict: null, endAt: null };
    if (e.kind === 'call-start') {
      const verb = verbOf(e.tool);
      const loc = locateCall(e, verb);
      calls.set(e.toolUseId, { e, verb, loc });
      entry.where = loc.label;
      entry.kind = 'call';
      logByCall.set(e.toolUseId, entry);
      const caller = ensureCaller(e);
      caller.lastCallAt = e.at;
      // What it is doing, for the page's hover card: its latest call, in the one line the log shows.
      caller.last = { id: e.toolUseId || e.key, tool: e.tool || null, summary: e.summary || '', where: loc.label || null, at: e.at, endAt: null };
      const to = loc.rooms.length ? loc.rooms[0] : loc.village.length ? 'village' : loc.outside.length ? 'outside' : null;
      // The trail (#161): each room change, keyed by the call that caused it
      // (the same key from either source, so a refold gives the same ids).
      // Consecutive calls in one room are one visit.
      if (to && to !== caller.room) {
        caller.room = to;
        caller.trail.push({ room: to, key: e.key });
        if (caller.trail.length > MAX_TRAIL) caller.trail.shift();
      }
      for (const id of loc.rooms) {
        const r = rooms.get(id);
        if (!r) continue;
        if (WEIGHT[verb]) addHeat(r, WEIGHT[verb], e.at, WINDOWS.heatHalfLifeMs);
        r.touchedAt = e.at;
        if (verb === 'read' || verb === 'search' || verb === 'shell') r.lastRead = e.at;
        for (const p of loc.rels) pushRecent(r.recent, { path: p, at: e.at, verb, sessionId: e.sessionId, agentId: e.agentId || null }, MAX_RECENT);
      }
      for (const p of loc.village) village.set(p, { path: p, at: e.at, verb });
      for (const p of loc.outside) outside.set(p, { path: p, at: e.at, verb });
      if (verb === 'skill') {
        dropWizardsOf(caller.key);
        units.set(`W:${e.toolUseId}`, { key: `W:${e.toolUseId}`, kind: 'wizard', sessionId: e.sessionId, caller: caller.key, label: e.summary || 'skill', since: e.at });
      } else if (verb === 'mcp') {
        units.set(`R:${e.toolUseId}`, { key: `R:${e.toolUseId}`, kind: 'raven', sessionId: e.sessionId, caller: caller.key, room: 'perch', label: e.summary || e.tool, tool: e.tool || null, since: e.at });
      } else if (verb === 'web') {
        units.set(`S:${e.toolUseId}`, { key: `S:${e.toolUseId}`, kind: 'scout', sessionId: e.sessionId, caller: caller.key, room: 'beyond-gate', label: e.summary || e.tool, tool: e.tool || null, since: e.at });
      }
      if (loc.command?.kind === 'test' || loc.command?.kind === 'build') {
        // #172: Raiders for a test run, a siege engine for a build, while it
        // runs. Their targets are set once the fold is done (below).
        const kind = loc.command.kind === 'test' ? 'raiders' : 'siege';
        units.set(`X:${e.toolUseId}`, { key: `X:${e.toolUseId}`, kind, sessionId: e.sessionId, caller: caller.key, room: kind === 'raiders' ? 'wilds' : 'gate', label: e.summary || loc.command.rule, tool: e.tool || null, runRoom: loc.command.room, since: e.at });
        runs.push({ id: e.toolUseId, kind: loc.command.kind, rule: loc.command.rule, room: loc.command.room, summary: e.summary, at: e.at, endAt: null, ok: null, exitCode: null, sessionId: e.sessionId, background: Boolean(e.targets?.background), judged: [] });
        if (runs.length > MAX_RUNS) runs.shift();
      }
    } else if (e.kind === 'call-end') {
      const open = calls.get(e.toolUseId);
      const verb = open ? open.verb : verbOf(e.tool);
      const loc = open ? open.loc : locateCall(e, verb);
      calls.delete(e.toolUseId);
      units.delete(`R:${e.toolUseId}`);
      units.delete(`S:${e.toolUseId}`);
      units.delete(`X:${e.toolUseId}`);
      const doer = units.get(callerKey(e));
      if (doer?.last && doer.last.id === e.toolUseId && doer.last.endAt === null) doer.last = { ...doer.last, endAt: e.at };
      entry.where = loc.label;
      entry.verdict = verdictText(e.verdict);
      const v = e.verdict;
      if (v?.ok === true) {
        for (const id of loc.rooms) {
          const r = rooms.get(id);
          if (r) r.alarms.tool = null;
        }
        if (verb === 'edit' || verb === 'create') {
          for (const id of loc.rooms) {
            const r = rooms.get(id);
            if (!r) continue;
            r.lastChange = e.at;
            // Documentation is never on trial (#170): no scaffolding, so no
            // run judges it. Hand-offs left Docs in Alarm after every session.
            if (!unprovable.has(id)) {
              r.unproven = true;
              r.proven = null;
            }
            r.touchedAt = e.at;
            r.lastChangedFile = loc.rels[0] || null;
          }
          for (const p of [...loc.rels, ...loc.village]) {
            if (p === 'castle.json') changedMapAt = e.at;
          }
          for (const rel of loc.rels) {
            const f = files.get(rel) || { edits: [] };
            f.edits = f.edits.filter((t) => e.at - t < WINDOWS.thrashWindowMs);
            f.edits.push(e.at);
            files.set(rel, f);
            for (const id of loc.roomsByRel[rel] || []) {
              const r = rooms.get(id);
              if (!r || unprovable.has(id)) continue;
              if (f.edits.length >= WINDOWS.thrashEdits) r.alarms.thrash = { kind: 'thrash', path: rel, edits: f.edits.length, at: e.at, sessionId: e.sessionId };
              // A further edit of the file while its thrash is up keeps it up,
              // however few now fall in the window: it lapses only after a
              // window with none (roomState; #170). A lapsed one stays lapsed.
              else if (r.alarms.thrash?.path === rel && e.at - r.alarms.thrash.at < WINDOWS.thrashLapseMs) r.alarms.thrash = { ...r.alarms.thrash, at: e.at };
            }
          }
        }
      } else if (v?.ok === false && (verb === 'edit' || verb === 'create')) {
        for (const id of loc.rooms) {
          const r = rooms.get(id);
          if (r) r.alarms.tool = { kind: 'tool', tool: e.tool, path: loc.rels[0] || null, at: e.at, sessionId: e.sessionId };
        }
      }
      const run = runs.find((x) => x.id === e.toolUseId && x.endAt === null);
      if (run) finishRun(run, v, e.at);
      const started = logByCall.get(e.toolUseId);
      if (started) {
        started.verdict = entry.verdict;
        started.endAt = e.at;
        logByCall.delete(e.toolUseId);
        continue;
      }
      entry.kind = 'call';
    } else if (e.kind === 'agent-start') {
      ensureCaller(e);
      entry.summary = e.agentType ? `Subagent started: ${e.agentType}` : 'Subagent started';
    } else if (e.kind === 'agent-end') {
      const key = `K:${e.agentId}`;
      if (units.has(key)) {
        units.delete(key);
        dropWizardsOf(key);
        // A run the subagent left open ends with it: its Raiders or engine go too.
        for (const [k, u] of units) if ((u.kind === 'raiders' || u.kind === 'siege') && u.caller === key) units.delete(k);
        entry.summary = 'Subagent finished';
      } else {
        // An internal agent (a prompt suggestion, /btw) stops without having
        // started as far as anything here saw: no Knight, no log line.
        continue;
      }
    } else if (e.kind === 'turn' || e.kind === 'stop') {
      dropWizardsOf(`M:${e.sessionId}`);
      const mason = units.get(`M:${e.sessionId}`);
      if (mason?.last && mason.last.endAt === null) mason.last = { ...mason.last, endAt: e.at };
      // Esc on a running tool fires no end (docs: hooks): a new turn or a stop
      // means every open call of this session is over, with no verdict.
      for (const [id, c] of calls) {
        if (c.e.sessionId !== e.sessionId || c.e.agentId) continue;
        calls.delete(id);
        units.delete(`R:${id}`);
        units.delete(`S:${id}`);
        units.delete(`X:${id}`);
      }
      if (e.kind === 'turn') entry.summary = 'Prompt';
      else entry.summary = 'Claude stopped and is waiting for the next prompt';
    } else if (e.kind === 'session-end') {
      s.endedAt = e.at;
      for (const [k, u] of units) if (u.sessionId === e.sessionId) units.delete(k);
      entry.summary = 'Session ended';
    }
    log.push(entry);
    if (log.length > MAX_LOG) log.shift();
  }

  // What a running test or build would judge if it ended now, which is what
  // finishRun will judge: every room with unproven changes, else the run's
  // own room (#172). Raiders and siege engines aim there.
  const unprovenNow = [...rooms.entries()].filter(([, r]) => r.unproven).map(([id]) => id);
  for (const u of units.values()) {
    if (u.kind === 'raiders' || u.kind === 'siege') u.targets = unprovenNow.length ? unprovenNow : u.runRoom && rooms.has(u.runRoom) ? [u.runRoom] : [];
  }

  // Trim Hollowmere to the most recent, keeping the count honest.
  const villageList = [...village.values()].sort((a, b) => b.at - a.at);
  const outsideList = [...outside.values()].sort((a, b) => b.at - a.at);
  return {
    rooms,
    units,
    runs,
    log,
    sessions,
    changedMapAt,
    village: { count: villageList.length, recent: villageList.slice(0, MAX_LISTED) },
    outside: { count: outsideList.length, recent: outsideList.slice(0, MAX_LISTED) },
  };
}

/**
 * A folded room's alarms at `now`. Thrash lapses once `thrashLapseMs` passes
 * with no further edit of its file (#170, owner decisions 2026-09-30): it says
 * a file is being edited again and again, which a quiet spell makes untrue. A
 * failed change or a failed run stays until something clears it.
 */
function liveAlarms(r, now) {
  const { tool, run, thrash } = r.alarms;
  return { tool, run, thrash: thrash && now - thrash.at < WINDOWS.thrashLapseMs ? thrash : null };
}

/** Which room state a folded room shows at `now`, and why. */
export function roomState(r, now, provenLive) {
  const a = liveAlarms(r, now);
  const alarm = [a.tool, a.run, a.thrash].filter(Boolean).sort((x, y) => y.at - x.at)[0];
  if (alarm) return { state: 'alarm', cause: alarm };
  if (r.lastChange !== null && now - r.lastChange < WINDOWS.activeMs) return { state: 'construction', cause: { kind: 'change', path: r.lastChangedFile, at: r.lastChange } };
  if (r.lastRead !== null && now - r.lastRead < WINDOWS.activeMs) return { state: 'survey', cause: { kind: 'activity', at: r.lastRead } };
  if (r.proven && !r.unproven && provenLive(r.proven.sessionId)) return { state: 'proven', cause: { kind: 'proven', ...r.proven } };
  return null;
}

/**
 * The castle for one project, while at least one stream is open. Holds the
 * transcript readers it follows, so a tick costs one stat per file when
 * nothing changed (jsonl.js returns early).
 */
class Castle {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.key = samePathKey(projectDir);
    this.subscribers = new Set();
    this.entries = new Map(); // sessionId -> { sessionId, reader, subs, seen, lags, included, index }
    this.pidLive = new Map();
    this.map = null;
    this.mapVersion = 0;
    this.mapLoadedAt = 0;
    this.cache = new Map();
    this.ticks = 0;
    this.timer = null;
    this.flushTimer = null;
    this.ready = null;
    this.busy = null;
    this.lastState = '';
    this.lastLog = '';
    this.nextIndex = 0;
    this.unsubscribe = null;
    this.folded = null;
    this.subUnknown = {};
  }

  /** Loads the map and picks and backfills the sessions, once (single flight). */
  start() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.reloadMap();
        await this.select();
        await this.refreshReaders(true);
        this.recompute();
        this.unsubscribe = onCastleRecord((sessionId) => this.onHook(sessionId));
        this.timer = setInterval(() => this.tick(), TICK_MS);
      })();
    }
    return this.ready;
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.flushTimer);
    if (this.unsubscribe) this.unsubscribe();
    this.timer = null;
  }

  async reloadMap() {
    this.map = await loadMap(this.projectDir);
    this.mapVersion += 1;
    this.mapLoadedAt = Date.now();
    this.cache.clear();
    this.lastState = '';
    for (const sub of this.subscribers) sub.send('map', this.mapFrame());
  }

  onHook(sessionId) {
    if (!this.entries.has(sessionId)) {
      // A launched session in this project that the castle does not hold yet:
      // re-pick on the next tick rather than the regular one. Any other
      // project's hooks are none of this castle's business.
      const feed = castleFeed(sessionId);
      if (!feed?.launchDir || !isInsideDir(feed.launchDir, this.projectDir)) return;
      this.ticks = SELECT_EVERY_TICKS - 1;
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        this.recompute();
      } catch {
        /* the next tick recomputes; a timer that throws would end the server (#33) */
      }
    }, FLUSH_MS);
  }

  tick() {
    if (this.busy) return;
    this.busy = (async () => {
      try {
        this.ticks += 1;
        if (this.ticks % SELECT_EVERY_TICKS === 0) await this.select();
        await this.refreshReaders(false);
        this.recompute();
      } catch {
        /* a failed tick is retried by the next one */
      } finally {
        this.busy = null;
      }
    })();
  }

  /**
   * The sessions in this castle: every one running now whose start folder is
   * the project or inside it (a pid file, or a launch that is reporting),
   * every one already included while this castle has been open, and, if none
   * of those, the most recent one here, so the castle shows how it was left.
   */
  async select() {
    const now = Date.now();
    const live = await liveSessions().catch(() => []);
    this.pidLive = new Map(live.map((s) => [s.sessionId, s]));
    const want = [];
    for (const s of live) if (s.cwd && isInsideDir(s.cwd, this.projectDir)) want.push(s.sessionId);
    for (const l of listLaunches()) {
      if (!l.dir || !isInsideDir(l.dir, this.projectDir)) continue;
      for (const s of l.sessions) {
        if (s.ended) continue;
        if (wrappedFor(s.id, { now })?.reporting) want.push(s.id);
      }
    }
    for (const id of this.entries.keys()) want.push(id);
    if (!want.length) {
      const recent = await this.mostRecent();
      if (recent) want.push(recent);
    }
    for (const id of [...new Set(want)]) {
      if (this.entries.has(id)) continue;
      if (this.entries.size >= MAX_SESSIONS) this.dropOldestEnded(now);
      if (this.entries.size >= MAX_SESSIONS) break;
      this.entries.set(id, { sessionId: id, reader: null, subs: new Map(), seen: null, lags: [], index: this.nextIndex++ });
    }
    for (const entry of this.entries.values()) {
      if (!entry.reader) entry.reader = await getReader(entry.sessionId).catch(() => null);
    }
  }

  dropOldestEnded(now) {
    const ended = [...this.entries.values()].filter((e) => !this.isLive(e.sessionId, now));
    if (!ended.length) return;
    ended.sort((a, b) => a.index - b.index);
    this.entries.delete(ended[0].sessionId);
  }

  async mostRecent() {
    const slug = projectSlug(this.projectDir).toLowerCase();
    const found = [...(await discoverSessions().catch(() => new Map())).values()]
      .filter((f) => f.projectFolder.toLowerCase().startsWith(slug))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of found.slice(0, 5)) {
      const reader = await getReader(f.sessionId).catch(() => null);
      if (reader?.model.cwd && isInsideDir(reader.model.cwd, this.projectDir)) return f.sessionId;
    }
    return null;
  }

  /**
   * Brings every transcript up to date: the main one, and each subagent's.
   * Subagent files are listed once when a session joins the castle, and
   * afterwards only while a subagent of that session is starting or running,
   * or a hook reported one the castle has no file for yet.
   */
  async refreshReaders(first) {
    for (const entry of this.entries.values()) {
      if (!entry.reader) continue;
      await entry.reader.refresh().catch(() => false);
      const model = entry.reader.model;
      const working = model.subagents.some((s) => s.status === 'starting' || s.status === 'running');
      const hooked = (castleFeed(entry.sessionId)?.records || []).some((r) => r.event === 'SubagentStart' && r.agentId && !entry.subs.has(r.agentId));
      // Listed once when the session joins, whenever that is (a castle that
      // started before it must see what a fresh one would), and afterwards
      // while one may be working.
      if (first || !entry.subsListed || working || hooked) {
        entry.subsListed = true;
        for (const f of await subagentFiles(entry.reader).catch(() => [])) {
          if (entry.subs.has(f.agentId)) continue;
          const meta = await readSubagentMeta(f.metaFile).catch(() => null);
          entry.subs.set(f.agentId, { agentId: f.agentId, reader: new SubagentReader(f.agentId, f.file), meta, parent: null, endedAt: null, done: false });
        }
      }
      for (const sub of entry.subs.values()) {
        if (!sub.done) await sub.reader.refresh().catch(() => false);
        const parent = model.subagents.find((x) => x.agentId === sub.agentId) || (sub.meta?.toolUseId && model.subagents.find((x) => x.toolUseId === sub.meta.toolUseId)) || null;
        sub.parent = parent;
        if (parent && parent.status !== 'starting' && parent.status !== 'running') {
          sub.endedAt = iso(parent.endAt) ?? iso(sub.reader.lastAt);
          // One more read after the end, then the file is left alone.
          sub.done = sub.done || sub.endedAt !== null;
        }
      }
      this.measureLag(entry, first);
    }
  }

  /**
   * How far behind a transcript-only session's picture runs: for each tool
   * call first seen after the backfill, the time between its record's
   * timestamp and this poll seeing it. The median is shown beside the session.
   */
  measureLag(entry, first) {
    const now = Date.now();
    const ids = [];
    for (const turn of entry.reader.model.turns) for (const t of turn.tools) ids.push(t);
    if (!entry.seen || first) {
      entry.seen = new Set(ids.map((t) => t.id));
      return;
    }
    for (const t of ids) {
      if (entry.seen.has(t.id)) continue;
      entry.seen.add(t.id);
      const at = iso(t.at);
      if (at !== null && now - at < 5 * 60_000) {
        entry.lags.push(Math.max(0, now - at));
        if (entry.lags.length > MAX_LAGS) entry.lags.shift();
      }
    }
  }

  /** Running, by the same rule as the session view (liveFrom): a pid file, else the launch's reports. */
  isLive(sessionId, now) {
    const entry = this.entries.get(sessionId);
    const w = entry ? this.wrapped(entry, now) : wrappedFor(sessionId, { now });
    return Boolean(liveFrom(this.pidLive.get(sessionId), w, sessionId));
  }

  /** Where one call is, cached by verb and path for the current map. */
  locateCall(e, verb) {
    const map = this.map;
    const out = { rooms: [], rels: [], village: [], outside: [], roomsByRel: {}, command: null, label: null };
    if (verb === 'shell') {
      const cmd = classifyCommand(map, e.targets?.heads || []);
      const room = map.rooms.find((r) => r.id === cmd.room);
      out.command = cmd;
      if (room) out.rooms.push(room.id);
      out.label = cmd.kind ? `${cmd.kind} run (${cmd.rule})` : 'shell';
      if (out.rooms.length) out.label += ` in ${room.name}`;
      return out;
    }
    if (!['read', 'search', 'edit', 'create'].includes(verb)) return out;
    for (const p of e.targets?.paths || []) {
      const cacheKey = `${verb === 'search' ? 's' : 'f'}|${samePathKey(p)}`;
      let loc = this.cache.get(cacheKey);
      if (!loc) {
        loc = locate(map, this.projectDir, p);
        if (verb === 'search' && loc.where === 'village') {
          const folder = locateFolder(map, this.projectDir, p);
          if (folder.where === 'room' || folder.where === 'project') loc = folder;
        }
        if (this.cache.size > MAX_CACHE) this.cache.clear();
        this.cache.set(cacheKey, loc);
      }
      if (loc.where === 'room') {
        for (const id of loc.rooms) if (!out.rooms.includes(id)) out.rooms.push(id);
        out.rels.push(loc.rel);
        out.roomsByRel[loc.rel] = loc.rooms;
      } else if (loc.where === 'village') out.village.push(loc.rel);
      else if (loc.where === 'outside') out.outside.push(p);
    }
    const names = out.rooms.map((id) => map.rooms.find((r) => r.id === id)?.name || id);
    out.label = names.length ? names.join(', ') : out.village.length ? 'Hollowmere' : out.outside.length ? 'the Citadel' : null;
    return out;
  }

  events() {
    const lists = [];
    const since = new Map();
    for (const entry of this.entries.values()) {
      const feed = castleFeed(entry.sessionId);
      if (!feed || !feed.records.length) continue;
      lists.push(hookEvents(entry.sessionId, feed.records));
      since.set(entry.sessionId, iso(feed.records[0].at) ?? Infinity);
    }
    for (const entry of this.entries.values()) lists.push(transcriptEvents(entry, since.get(entry.sessionId) ?? Infinity));
    const merged = mergeEvents(lists);
    this.leftOut = Math.max(0, merged.length - MAX_EVENTS);
    return this.leftOut ? merged.slice(-MAX_EVENTS) : merged;
  }

  /** A launched session's reported state, the transcript ending any tool it never reported finishing (#23). */
  wrapped(entry, now) {
    return wrappedFor(entry.sessionId, { now, toolDone: (id) => Boolean(entry.reader?.toolDone(id)) });
  }

  recompute() {
    if (!this.map) return;
    const now = Date.now();
    const folded = fold(this.events(), this.map, (e, verb) => this.locateCall(e, verb));
    this.folded = folded;
    if (folded.changedMapAt !== null && folded.changedMapAt > this.mapLoadedAt) {
      this.mapLoadedAt = Date.now();
      this.reloadMap()
        .then(() => this.recompute())
        .catch(() => {});
    }
    const state = this.stateFrame(folded, now);
    const stateKey = JSON.stringify(state);
    if (stateKey !== this.lastState) {
      this.lastState = stateKey;
      for (const sub of this.subscribers) sub.send('state', { ...state, at: new Date(now).toISOString() });
    }
    // A call's line gets its verdict when it ends, which may not be the last line.
    const logKey = JSON.stringify(folded.log.map((e) => [e.at, e.verdict]));
    if (logKey !== this.lastLog) {
      this.lastLog = logKey;
      for (const sub of this.subscribers) sub.send('log', this.logFrame());
    }
  }

  mapFrame() {
    const m = this.map;
    return {
      projectDir: this.projectDir,
      floor: m.floor,
      rooms: m.rooms.map((r) => ({ id: r.id, name: r.name, type: r.type, col: r.col, row: r.row, patterns: r.patterns, custom: r.custom })),
      types: ROOM_TYPES,
      // Where the Raven waits: above this room, or above the gate when null.
      perch: m.roles.perch,
      source: m.source,
      file: m.file,
      error: m.error,
      proof: m.proof,
      commands: m.commands.map((c) => ({ words: c.words.join(' '), kind: c.kind, room: c.room, source: c.source })),
      prompt: draftPrompt(this.projectDir),
      states: ROOM_STATES,
      units: UNIT_KINDS,
      rules: CASTLE_RULES,
      windows: WINDOWS,
      version: this.mapVersion,
    };
  }

  stateFrame(folded, now) {
    const provenLive = (sid) => this.isLive(sid, now);
    const liveIds = [...this.entries.keys()].filter((id) => this.isLive(id, now));
    // "This session" for Embers: since the earliest live session arrived, or,
    // with none live, since the latest one here arrived.
    const starts = (ids) => ids.map((id) => folded.sessions.get(id)?.firstAt).filter((t) => typeof t === 'number');
    let sittingStart = Math.min(...starts(liveIds));
    if (!Number.isFinite(sittingStart)) sittingStart = Math.max(...starts([...this.entries.keys()]));
    if (!Number.isFinite(sittingStart)) sittingStart = Infinity;

    const rooms = {};
    for (const [id, r] of folded.rooms) {
      const lit = roomState(r, now, provenLive);
      const state = lit ? lit.state : r.touchedAt !== null && r.touchedAt >= sittingStart ? 'embers' : 'dark';
      rooms[id] = {
        state,
        cause: lit ? lit.cause : null,
        heat: r.heat,
        scaffolding: r.unproven,
        lastRead: r.lastRead,
        lastChange: r.lastChange,
        touchedAt: r.touchedAt,
      };
    }

    const sessions = [...this.entries.values()].map((entry) => {
      const w = this.wrapped(entry, now);
      const live = this.isLive(entry.sessionId, now);
      const lags = [...entry.lags].sort((a, b) => a - b);
      return {
        sessionId: entry.sessionId,
        index: entry.index,
        title: entry.reader ? entry.reader.model.customTitle || entry.reader.model.aiTitle || null : null,
        // Launched: its hooks drive it (the transcript only backfills).
        source: w ? 'hooks' : 'transcript',
        live,
        // Ended by its own report, or a transcript-only session whose process is gone.
        ended: w ? w.ended : !live,
        // Launched, not ended, silent: never reported, not since a restart, or stopped reporting.
        quiet: w && !w.ended && !w.reporting ? (w.neverReported ? 'blocked' : w.restored && !w.lastSeenAt ? 'restart' : 'silent') : null,
        // Kind only: the wait's message can quote a tool call.
        waiting: live && w?.waiting ? w.waiting.kind : null,
        lagS: lags.length ? Math.round(lags[Math.floor(lags.length / 2)] / 100) / 10 : null,
        lagSamples: lags.length,
      };
    });
    const liveSet = new Set(sessions.filter((s) => s.live).map((s) => s.sessionId));

    const units = [];
    for (const u of folded.units.values()) {
      if (!liveSet.has(u.sessionId)) continue;
      const out = { key: u.key, kind: u.kind, sessionId: u.sessionId, agentId: u.agentId || null, agentType: u.agentType || null, label: u.label || null, since: u.since };
      if (u.kind === 'wizard') {
        const caller = folded.units.get(u.caller);
        out.room = caller ? caller.room : 'gate';
        out.caller = u.caller;
      } else out.room = u.room;
      if (u.trail) out.trail = u.trail;
      // For the hover card: a worker's latest call, an MCP or web call's tool, a subagent's task.
      if (u.last !== undefined) out.last = u.last;
      if (u.tool) out.tool = u.tool;
      // Raiders and siege engines: the rooms the run would judge now (#172).
      if (u.targets) out.targets = u.targets;
      if (u.kind === 'knight') {
        const sub = this.entries.get(u.sessionId)?.subs.get(u.agentId);
        out.task = sub?.meta?.description || sub?.parent?.description || null;
      }
      // Resting: no call running, and none for a while, counted from when the
      // last one ended (or, with none yet, from its arrival). A worker whose
      // call is still running (a long build) is working, not resting.
      const quietSince = u.last ? u.last.endAt : u.since;
      out.resting = (u.kind === 'mason' || u.kind === 'knight') && quietSince !== null && now - quietSince > WINDOWS.restMs;
      if (u.caller) out.caller = u.caller;
      units.push(out);
    }
    for (const s of sessions) {
      if (s.live && !folded.units.has(`M:${s.sessionId}`)) {
        // Running, and nothing it did is known yet: it stands inside the gate.
        units.push({ key: `M:${s.sessionId}`, kind: 'mason', sessionId: s.sessionId, agentId: null, room: 'gate', trail: [], last: null, resting: false, since: null });
      }
      if (s.live && s.waiting) units.push({ key: `H:${s.sessionId}`, kind: 'herald', sessionId: s.sessionId, room: 'gate', label: s.waiting });
    }
    units.sort((a, b) => a.key.localeCompare(b.key));

    const alarms = Object.values(rooms).filter((r) => r.state === 'alarm').length;
    const busy = Object.entries(rooms)
      .filter(([, r]) => r.state === 'construction' || r.state === 'survey')
      .map(([id]) => id);
    const unknown = { ...this.subUnknown };
    for (const entry of this.entries.values()) {
      for (const sub of entry.subs.values()) {
        for (const [k, n] of Object.entries(sub.reader.unknown)) unknown[k] = (unknown[k] || 0) + n;
      }
    }
    return {
      mapVersion: this.mapVersion,
      rooms,
      units,
      sessions,
      village: { count: folded.village.count, recent: folded.village.recent.slice(0, 5) },
      outside: { count: folded.outside.count },
      runs: folded.runs.slice(-5).map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, at: r.at, endAt: r.endAt, ok: r.ok, exitCode: r.exitCode, noVerdict: r.noVerdict || null, judged: r.judged, sessionId: r.sessionId })),
      summary: { sessions: liveSet.size, workers: units.filter((u) => u.kind === 'mason' || u.kind === 'knight').length, alarms, busy },
      // Oldest events past MAX_EVENTS, not folded (said on the page).
      leftOut: this.leftOut || 0,
      unknown,
    };
  }

  logFrame() {
    return { entries: this.folded ? this.folded.log : [] };
  }

  /** A room's recent files (paths), or Hollowmere's or the Citadel's. Null when there is no such room. */
  roomDetail(id) {
    if (!this.folded) return null;
    if (id === 'village') return { id, recent: this.folded.village.recent };
    if (id === 'outside') return { id, recent: this.folded.outside.recent };
    const r = this.folded.rooms.get(id);
    if (!r) return null;
    return { id, recent: r.recent, alarms: liveAlarms(r, Date.now()), proven: r.proven, heat: r.heat };
  }
}

const castles = new Map();

/**
 * Opens (or joins) the castle for a project and subscribes `send(event,
 * payload)`. Resolves once the castle is ready, having sent the map, state and
 * log to this subscriber. The returned function unsubscribes; the last one out
 * stops the castle and forgets its state.
 */
export async function subscribeCastle(projectDir, send) {
  const key = samePathKey(projectDir);
  let castle = castles.get(key);
  if (!castle) {
    castle = new Castle(projectDir);
    castles.set(key, castle);
  }
  // Counted while it waits, so a stream that opens during another's start
  // does not see an empty castle stopped under it.
  castle.pending = (castle.pending || 0) + 1;
  const release = () => {
    if (!castle.subscribers.size && !castle.pending && castles.get(key) === castle) {
      castle.stop();
      castles.delete(key);
    }
  };
  try {
    await castle.start();
  } catch (err) {
    castle.pending -= 1;
    // A failed start is not kept: the next stream starts afresh.
    if (castles.get(key) === castle) castles.delete(key);
    castle.stop();
    throw err;
  }
  castle.pending -= 1;
  const sub = { send };
  castle.subscribers.add(sub);
  send('map', castle.mapFrame());
  send('state', { ...JSON.parse(castle.lastState || '{}'), at: new Date().toISOString() });
  send('log', castle.logFrame());
  return () => {
    castle.subscribers.delete(sub);
    release();
  };
}

/** The open castle for a project, or null (state exists only while a stream is open). */
export function openCastle(projectDir) {
  return castles.get(samePathKey(projectDir)) || null;
}

/** Re-reads castle.json for an open castle. */
export async function reloadCastleMap(projectDir) {
  const castle = openCastle(projectDir);
  if (!castle) return null;
  await castle.reloadMap();
  castle.recompute();
  return { source: castle.map.source, error: castle.map.error, version: castle.mapVersion };
}

