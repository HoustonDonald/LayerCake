import { duration } from '../sessionFormat.js';

/**
 * What a unit stands for, in words (#162): the hover card and the room
 * drawer's "Here now" both read this, so they never disagree. Everything
 * comes from the state frame the server sent (castle.js): the session's
 * title, a worker's latest call as the one line the event log shows, a
 * subagent's task, a skill's name, an MCP or web call's tool and target.
 */

const ago = (ms) => (typeof ms === 'number' ? `${duration(Math.max(0, Date.now() - ms))} ago` : null);

/** A session by its title, with the start of its id so two alike stay apart. */
export function sessionName(state, sessionId) {
  const s = state?.sessions?.find((x) => x.sessionId === sessionId);
  const short = String(sessionId || '').slice(0, 8);
  return s?.title ? `${s.title} (${short})` : short;
}

const PLACES = { gate: 'at the gate', 'beyond-gate': 'beyond the gate', wilds: 'in the Wilds', outside: 'outside the project', perch: 'on the wall' };

function placeName(map, room) {
  if (!room) return null;
  return map?.rooms?.find((r) => r.id === room)?.name || PLACES[room] || room;
}

/** A path in the project, shown from the project's root (a summary names a file by its full path). */
function fromProject(map, text) {
  const dir = map?.projectDir;
  if (!dir || !text || text.length <= dir.length) return text;
  const head = text.slice(0, dir.length);
  const same = /^[a-z]:/i.test(dir) ? head.toLowerCase() === dir.toLowerCase() : head === dir;
  return same && /[\\/]/.test(text[dir.length]) ? text.slice(dir.length + 1) : text;
}

/** A worker's latest call: "Now" while it runs, else "Last" with when it ended. */
function doing(last, map) {
  if (!last) return null;
  const what = [last.tool, fromProject(map, last.summary)].filter(Boolean).join(' · ');
  const where = last.where ? ` (${last.where})` : '';
  return last.endAt === null ? ['Now', `${what}${where}`] : ['Last', `${what}${where}, ${ago(last.endAt)}`];
}

/** Claude Code's notification types, in words (the kind only reaches the page, never the message). */
const WAITING = { permission_prompt: 'your permission', idle_prompt: 'your next prompt', elicitation_dialog: 'an answer from you' };

/** { title, tags, rows: [label, value][] } for one unit of the state frame. */
export function describeUnit(u, { state, map }) {
  const title = map?.units?.find((k) => k.kind === u.kind)?.label || u.kind;
  const tags = [];
  const rows = [];
  const add = (label, value) => {
    if (value) rows.push([label, value]);
  };
  const caller = (key) => {
    const c = state?.units?.find((x) => x.key === key);
    if (!c) return null;
    return c.kind === 'knight' ? `a Knight${c.agentType ? ` (${c.agentType})` : ''} of ${sessionName(state, c.sessionId)}` : `the Mason of ${sessionName(state, c.sessionId)}`;
  };
  if (u.resting) tags.push('resting');
  switch (u.kind) {
    case 'mason':
    case 'knight': {
      const d = doing(u.last, map);
      if (d && d[0] === 'Now') tags.push('working');
      if (u.kind === 'knight') {
        add('Subagent', u.agentType || 'type not reported');
        add('Task', u.task);
        add('For', sessionName(state, u.sessionId));
      } else {
        add('Session', sessionName(state, u.sessionId));
      }
      add('Where', placeName(map, u.room));
      if (d) add(d[0], d[1]);
      else add('Doing', 'no call seen yet');
      break;
    }
    case 'wizard':
      add('Skill', u.label);
      add('Beside', caller(u.caller));
      add('Since', ago(u.since));
      break;
    case 'raven': {
      // mcp__<server>__<tool>
      const parts = String(u.tool || '').split('__');
      add('MCP server', parts[1] || u.label);
      add('Tool', parts.slice(2).join('__') || null);
      add('For', caller(u.caller));
      add('Since', ago(u.since));
      break;
    }
    case 'scout':
      add(u.tool === 'WebSearch' ? 'Web search' : 'Web fetch', u.label);
      add('For', caller(u.caller));
      add('Since', ago(u.since));
      break;
    case 'herald':
      tags.push('waiting');
      add('Waiting for', WAITING[u.label] || u.label || 'you');
      add('Session', sessionName(state, u.sessionId));
      break;
    default:
      break;
  }
  return { title, tags, rows };
}
