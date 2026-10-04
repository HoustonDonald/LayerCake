/**
 * The Castle's map (#160, #167): the project's rooms, which room a file
 * belongs to, and what a shell command is.
 *
 * The rooms are the project's own sections (owner decision 2026-09-30, #167),
 * each tagged with a function type from a fixed list. A project describes
 * them in castle.json (version 2), which Claude drafts from the project's
 * layout with the page's "Copy prompt for Claude" and the owner reviews once.
 * Each room has an explicit place on the grid; the prompt asks Claude to keep
 * every existing room where it is and to add new ones at the edges (spec: "The
 * map never moves"). Without a castle.json the built-in map applies: twelve
 * common areas, typed, with patterns from folder and file names that usually
 * mean the job.
 *
 * castle.json is READ, never written, by LayerCake. It sits in the project, so
 * it can arrive in a cloned repository written by anyone: everything in it is
 * data, bounded, and checked. That is also why the glob matcher below is
 * hand-written instead of picomatch: picomatch compiles a glob to a
 * backtracking regular expression, and one pattern ('*a' twelve times, then
 * 'b', against forty a's) ran for over a minute in review, which on the event
 * loop is a hung server. path.matchesGlob is no better (super-linear too,
 * case-sensitive on Windows, and its ** skips dot folders). The matcher here
 * supports `*`, `?` and `**` only and refuses the rest, in time proportional to
 * pattern length times path length. Command rules are word prefixes, never a
 * regular expression, for the same reason.
 */

import path from 'node:path';

import { readForDisplay } from './readfile.js';
import { isInsideDir } from './paths.js';

export const CASTLE_FILE = 'castle.json';
/** A castle.json larger than this is refused rather than read in part. */
export const MAX_MAP_BYTES = 64 * 1024;
export const MAX_PATTERNS_PER_ROOM = 50;
export const MAX_PATTERN_CHARS = 200;
export const MAX_COMMAND_RULES = 100;
export const MAX_ROOMS = 24;
export const MAX_COLS = 4;
export const MAX_ROWS = 6;
export const MAX_NAME_CHARS = 40;
/** A room id: a short slug, so it is safe as a key and in a URL. */
export const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/**
 * Names the castle already uses for places that are not rooms: the fold and
 * the page share one namespace. The village is Hollowmere, where files no room
 * claims are kept (#172); the Wilds, beyond the Frostwall, are where Raiders
 * stand; outside is the Citadel.
 */
const RESERVED_IDS = new Set(['gate', 'beyond-gate', 'village', 'wilds', 'outside', 'perch', 'project', 'sept']);
const FOLD = process.platform === 'win32';

/**
 * Room types (#167): what a room does. The type gives a room its icon (#162)
 * and the roles fixed room ids used to carry: where test, build and migration
 * runs go when no rule names a room, and where the Raven waits. (A plain shell
 * call has no room of its own: it works in the rooms of the files it names,
 * #176.) Shipped with the map so the page never keeps its own list.
 * `provable: false` marks a type no test run can prove (#170, owner decision
 * 2026-09-30): an edit there puts up no scaffolding, a run never judges it, and
 * it has no thrash. Only a failed change raises its Alarm.
 */
export const ROOM_TYPES = [
  { type: 'api', label: 'API', job: 'API endpoints and request entry points' },
  { type: 'routing', label: 'Routing', job: 'routes and navigation' },
  { type: 'database', label: 'Database', job: 'database, schema and migrations' },
  { type: 'storage', label: 'Storage', job: 'files, caches and saved state' },
  { type: 'ui', label: 'UI', job: 'user interface: views, components and styles' },
  { type: 'agent', label: 'Agent', job: 'agents and processes that act for the user' },
  { type: 'auth', label: 'Auth', job: 'authentication, authorization and security' },
  { type: 'services', label: 'Services', job: 'services, business logic and request handling' },
  { type: 'core', label: 'Core', job: 'core logic and shared libraries' },
  { type: 'jobs', label: 'Jobs', job: 'background jobs, workers and queues' },
  { type: 'integrations', label: 'Integrations', job: 'MCP servers, outside services and webhooks' },
  { type: 'cli', label: 'CLI', job: 'command-line tools' },
  { type: 'build', label: 'Build', job: 'build, packaging, CI and scripts' },
  { type: 'config', label: 'Config', job: 'configuration' },
  { type: 'tests', label: 'Tests', job: 'tests' },
  { type: 'docs', label: 'Docs', job: 'documentation', provable: false },
  { type: 'logs', label: 'Logs', job: 'logs and logging' },
];
const TYPE_IDS = new Set(ROOM_TYPES.map((t) => t.type));
/** The room type a kind of run lights up when no rule names a room. */
const KIND_TYPE = { test: 'tests', build: 'build', migration: 'database' };
export const COMMAND_KINDS = Object.keys(KIND_TYPE);
/** The Raven waits on the wall above the first room of this type, else above the gate. */
const PERCH_TYPE = 'integrations';

/**
 * The built-in map, back row first; the gate is under API. The twelve areas
 * and places of the plain castle (owner decision 2026-09-29), renamed for what
 * they do (#167). A project whose layout says otherwise writes castle.json.
 */
export const DEFAULT_ROOMS = [
  { id: 'database', name: 'Database', type: 'database', col: 0, row: 0, patterns: ['**/db/**', '**/database/**', '**/migrations/**', '**/models/**', '**/schema/**', '**/prisma/**', '**/*.sql', '**/schema.*'] },
  { id: 'core', name: 'Core', type: 'core', col: 1, row: 0, patterns: ['**/lib/**', '**/core/**', '**/shared/**', '**/common/**', '**/utils/**', '**/domain/**'] },
  { id: 'integrations', name: 'Integrations', type: 'integrations', col: 2, row: 0, patterns: ['**/integrations/**', '**/clients/**', '**/mcp/**', '**/webhooks/**', '**/.mcp.json'] },
  { id: 'logs', name: 'Logs', type: 'logs', col: 0, row: 1, patterns: ['**/logs/**', '**/logging/**', '**/*.log', '**/logger.*'] },
  { id: 'docs', name: 'Docs', type: 'docs', col: 1, row: 1, patterns: ['**/docs/**', '**/*.md', '**/*.mdx', '**/*.rst'] },
  { id: 'jobs', name: 'Jobs', type: 'jobs', col: 2, row: 1, patterns: ['**/jobs/**', '**/workers/**', '**/queues/**', '**/cron/**', '**/tasks/**'] },
  {
    id: 'build',
    name: 'Build and config',
    type: 'build',
    col: 0,
    row: 2,
    patterns: ['**/scripts/**', '**/.github/**', '**/.claude/**', '**/package.json', '**/package-lock.json', '**/*.config.*', '**/tsconfig*.json', '**/Dockerfile', '**/*.yml', '**/*.yaml', '**/*.toml', '**/Makefile', '**/*.csproj', '**/*.sln'],
  },
  {
    id: 'ui',
    name: 'UI',
    type: 'ui',
    col: 1,
    row: 2,
    patterns: ['**/client/**', '**/components/**', '**/pages/**', '**/views/**', '**/ui/**', '**/public/**', '**/*.css', '**/*.scss', '**/*.html', '**/*.jsx', '**/*.tsx', '**/*.vue', '**/*.svelte'],
  },
  { id: 'tests', name: 'Tests', type: 'tests', col: 2, row: 2, patterns: ['**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/e2e/**', '**/*.test.*', '**/*.spec.*', '**/*smoke*'] },
  { id: 'auth', name: 'Auth', type: 'auth', col: 0, row: 3, patterns: ['**/auth/**', '**/security/**', '**/permissions/**', '**/*auth*', '**/*security*'] },
  { id: 'api', name: 'API', type: 'api', col: 1, row: 3, patterns: ['**/routes/**', '**/api/**', '**/controllers/**', '**/endpoints/**', '**/handlers/**', '**/*routes*', '**/server.*', '**/app.*', '**/main.*'] },
  { id: 'services', name: 'Services', type: 'services', col: 2, row: 3, patterns: ['**/services/**', '**/middleware/**', '**/validators/**', '**/*service*'] },
];
const DEFAULT_GATE = 1;

/**
 * Commands recognised without a castle.json, as word prefixes of a command
 * segment (lowercase). Projects add their own ahead of these. Their room is
 * the map's room for their kind.
 */
const DEFAULT_COMMAND_WORDS = [
  ['npm test', 'test'],
  ['npm run test', 'test'],
  ['npm run smoke', 'test'],
  ['npx vitest', 'test'],
  ['npx jest', 'test'],
  ['npx playwright test', 'test'],
  ['vitest', 'test'],
  ['jest', 'test'],
  ['pytest', 'test'],
  ['python -m pytest', 'test'],
  ['go test', 'test'],
  ['cargo test', 'test'],
  ['dotnet test', 'test'],
  ['mvn test', 'test'],
  ['npm run build', 'build'],
  ['tsc', 'build'],
  ['npx tsc', 'build'],
  ['vite build', 'build'],
  ['npx vite build', 'build'],
  ['dotnet build', 'build'],
  ['cargo build', 'build'],
  ['go build', 'build'],
  ['npx prisma migrate', 'migration'],
  ['npm run migrate', 'migration'],
  ['dotnet ef database', 'migration'],
  ['alembic upgrade', 'migration'],
].map(([words, kind]) => ({ words: words.split(' '), kind }));

/**
 * Checks a glob's syntax. Returns null when it is usable, else why not. Only
 * `*`, `?` and whole-segment `**` are wildcards; brace, class, extglob and
 * negation syntax and backslash escapes are refused rather than half-supported.
 */
export function globProblem(pattern) {
  if (typeof pattern !== 'string' || !pattern) return 'a pattern must be a non-empty string';
  if (pattern.length > MAX_PATTERN_CHARS) return `a pattern is at most ${MAX_PATTERN_CHARS} characters`;
  if (/[{}[\]()!+@\\]/.test(pattern)) return `"${pattern}": only *, ? and ** are supported (no braces, classes, !, +, @ or backslashes)`;
  for (const seg of splitPattern(pattern)) {
    if (seg.includes('**') && seg !== '**') return `"${pattern}": ** must be a whole path segment`;
  }
  return null;
}

function splitPattern(pattern) {
  return pattern.replace(/^\.\//, '').split('/').filter(Boolean);
}

/** `*` and `?` inside one segment: the greedy two-pointer wildcard match, no backtracking beyond the last star. */
function segmentMatch(p, s) {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) {
      pi += 1;
      si += 1;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi;
      mark = si;
      pi += 1;
    } else if (star !== -1) {
      pi = star + 1;
      mark += 1;
      si = mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi += 1;
  return pi === p.length;
}

/**
 * A compiled glob: segments, with `**` matching zero or more whole segments
 * (dot folders included) by the same greedy scheme one level up. Case-folded
 * on Windows. Match against a relative path with forward slashes.
 */
export function compileGlob(pattern) {
  const segs = splitPattern(FOLD ? pattern.toLowerCase() : pattern);
  return (relPath) => {
    const parts = (FOLD ? relPath.toLowerCase() : relPath).split('/');
    let pi = 0;
    let si = 0;
    let star = -1;
    let mark = 0;
    while (si < parts.length) {
      if (pi < segs.length && segs[pi] !== '**' && segmentMatch(segs[pi], parts[si])) {
        pi += 1;
        si += 1;
      } else if (pi < segs.length && segs[pi] === '**') {
        star = pi;
        mark = si;
        pi += 1;
      } else if (star !== -1) {
        pi = star + 1;
        mark += 1;
        si = mark;
      } else {
        return false;
      }
    }
    while (pi < segs.length && segs[pi] === '**') pi += 1;
    return pi === segs.length;
  };
}

/** Command rule words: a string of words or an array of strings, lowercased. Null when unusable. */
function ruleWords(value) {
  const words = typeof value === 'string' ? value.trim().split(/\s+/) : Array.isArray(value) ? value : null;
  if (!words || !words.length || words.length > 6 || !words.every((w) => typeof w === 'string' && w && w.length <= 60)) return null;
  return words.map((w) => w.toLowerCase());
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isCell = (v, max) => Number.isInteger(v) && v >= 0 && v < max;

/** castle.json's rooms, checked. Problems are pushed; returns the rooms or null. */
function readRooms(list, problems) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_ROOMS) {
    problems.push(`"rooms" must be a list of 1 to ${MAX_ROOMS} rooms`);
    return null;
  }
  const rooms = [];
  const ids = new Set();
  const cells = new Map();
  list.forEach((spec, i) => {
    const at = `rooms[${i}]`;
    if (!isObject(spec)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const { id, name, type, col, row } = spec;
    const where = typeof id === 'string' && ROOM_ID_RE.test(id) ? `room "${id}"` : at;
    if (typeof id !== 'string' || !ROOM_ID_RE.test(id)) problems.push(`${at}.id must be 1 to 32 lowercase letters, digits and dashes, starting with a letter or digit`);
    else if (RESERVED_IDS.has(id)) problems.push(`${at}.id "${id}" is a place the castle already uses (${[...RESERVED_IDS].join(', ')})`);
    else if (ids.has(id)) problems.push(`${at}.id "${id}" is used twice`);
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_CHARS) problems.push(`${where}: "name" must be 1 to ${MAX_NAME_CHARS} characters`);
    if (typeof type !== 'string' || !TYPE_IDS.has(type)) problems.push(`${where}: "type" must be one of ${[...TYPE_IDS].join(', ')}`);
    if (!isCell(col, MAX_COLS) || !isCell(row, MAX_ROWS)) problems.push(`${where}: "col" must be 0 to ${MAX_COLS - 1} and "row" 0 to ${MAX_ROWS - 1}`);
    else if (cells.has(`${col},${row}`)) problems.push(`${where} and room "${cells.get(`${col},${row}`)}" both take col ${col}, row ${row}`);
    let patterns = [];
    if (spec.patterns !== undefined) {
      if (!Array.isArray(spec.patterns) || spec.patterns.length > MAX_PATTERNS_PER_ROOM) {
        problems.push(`${where}: "patterns" must be a list of at most ${MAX_PATTERNS_PER_ROOM}`);
      } else {
        const bad = spec.patterns.map(globProblem).filter(Boolean);
        if (bad.length) problems.push(...bad.map((b) => `${where}: ${b}`));
        else patterns = spec.patterns.map((p) => p.replace(/^\.\//, ''));
      }
    }
    if (typeof id === 'string') ids.add(id);
    if (isCell(col, MAX_COLS) && isCell(row, MAX_ROWS) && !cells.has(`${col},${row}`)) cells.set(`${col},${row}`, id);
    rooms.push({ id, name: typeof name === 'string' ? name.trim() : name, type, col, row, patterns, custom: true });
  });
  return rooms;
}

/** Which room each role goes to, from the rooms' types: the first room of the type, in list order. */
function rolesOf(rooms) {
  const first = (types) => {
    for (const t of types) {
      const r = rooms.find((x) => x.type === t);
      if (r) return r.id;
    }
    return null;
  };
  return {
    test: first([KIND_TYPE.test]),
    build: first([KIND_TYPE.build]),
    migration: first([KIND_TYPE.migration]),
    perch: first([PERCH_TYPE]),
  };
}

/**
 * The built-in map, or castle.json's. Errors are values: a file that cannot
 * be used leaves the built-in map in force AND says why, so a broken
 * castle.json is never silently ignored.
 */
export function buildMap(parsed, source) {
  const problems = [];
  let rooms = null;
  let gate = null;
  const rules = [];
  let proof = ['test'];
  if (parsed !== undefined) {
    if (!isObject(parsed)) {
      problems.push('the file must hold a JSON object');
    } else if (parsed.version === 1 || (parsed.version === undefined && isObject(parsed.rooms))) {
      problems.push('this is a version 1 file (the old fixed castle rooms), which is no longer read. "Copy prompt for Claude" drafts a version 2 with the project\'s own rooms');
    } else if (parsed.version !== 2) {
      problems.push('"version" must be 2');
    } else {
      rooms = readRooms(parsed.rooms, problems);
      const ids = new Set((rooms || []).map((r) => r.id));
      if (parsed.gate !== undefined) {
        const cols = rooms ? Math.max(...rooms.map((r) => (isCell(r.col, MAX_COLS) ? r.col : 0))) + 1 : 0;
        if (isCell(parsed.gate, cols)) gate = parsed.gate;
        else problems.push(`"gate" must be a column the rooms use (0 to ${Math.max(0, cols - 1)})`);
      }
      if (parsed.commands !== undefined) {
        if (!Array.isArray(parsed.commands) || parsed.commands.length > MAX_COMMAND_RULES) {
          problems.push(`"commands" must be a list of at most ${MAX_COMMAND_RULES}`);
        } else {
          parsed.commands.forEach((c, i) => {
            const words = isObject(c) ? ruleWords(c.words) : null;
            const kind = isObject(c) ? c.kind : null;
            if (!words) problems.push(`commands[${i}].words must be the command's first words, like "npm run smoke"`);
            else if (!Object.hasOwn(KIND_TYPE, kind)) problems.push(`commands[${i}].kind must be one of ${COMMAND_KINDS.join(', ')}`);
            else if (c.room !== undefined && (typeof c.room !== 'string' || !ids.has(c.room))) problems.push(`commands[${i}].room is not one of the rooms`);
            else rules.push({ words, kind, room: c.room ?? null, source: 'castle.json' });
          });
        }
      }
      if (parsed.proof !== undefined) {
        const ok = Array.isArray(parsed.proof) && parsed.proof.length > 0 && parsed.proof.every((k) => k === 'test' || k === 'build');
        if (ok) proof = [...new Set(parsed.proof)];
        else problems.push('"proof" must be ["test"] or ["test", "build"]');
      }
    }
  }
  const usable = parsed !== undefined && problems.length === 0 && rooms;
  const finalRooms = usable ? rooms : DEFAULT_ROOMS.map((r) => ({ ...r, patterns: [...r.patterns], custom: false }));
  const cols = Math.max(...finalRooms.map((r) => r.col)) + 1;
  const rows = Math.max(...finalRooms.map((r) => r.row)) + 1;
  const roles = rolesOf(finalRooms);
  const roomFor = (rule) => rule.room ?? roles[rule.kind];
  return {
    source: usable ? 'castle.json' : 'built-in',
    error: parsed === undefined || usable ? null : `castle.json not used: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''}`,
    file: source || null,
    rooms: finalRooms,
    floor: { cols, rows, gate: { col: usable ? (gate ?? Math.floor((cols - 1) / 2)) : DEFAULT_GATE } },
    roles,
    commands: [...(usable ? rules : []), ...DEFAULT_COMMAND_WORDS.map((r) => ({ ...r, source: 'built-in' }))].map((r) => ({ ...r, room: roomFor(r) })),
    proof: usable ? proof : ['test'],
    matchers: finalRooms.map((r) => ({ id: r.id, globs: r.patterns.map(compileGlob) })),
  };
}

/**
 * Reads <projectDir>/castle.json through readForDisplay (size cap, share
 * gate, errors as values). A missing file is not an error: the built-in map is
 * the default.
 */
export async function loadMap(projectDir) {
  const file = path.join(projectDir, CASTLE_FILE);
  const result = await readForDisplay(file);
  if (result.error) {
    if (result.error.code === 'ENOENT') return buildMap(undefined, null);
    const map = buildMap(undefined, file);
    return { ...map, error: `castle.json not used: ${result.error.message || result.error.code}` };
  }
  if (result.size > MAX_MAP_BYTES || result.truncated) {
    return { ...buildMap(undefined, file), error: `castle.json not used: it is over ${MAX_MAP_BYTES / 1024} KB` };
  }
  if (result.jsonError || result.parsed === undefined) {
    return { ...buildMap(undefined, file), error: `castle.json not used: not valid JSON (${result.jsonError || 'unreadable'})` };
  }
  return buildMap(result.parsed, file);
}

/**
 * Where a file is: `{ where: 'room', rooms, rel }`, `{ where: 'village', rel }`
 * (in the project, claimed by no room: Hollowmere's, #172) or `{ where: 'outside' }` (not in the
 * project, which no pattern could ever claim).
 */
export function locate(map, projectDir, absPath) {
  if (!isInsideDir(absPath, projectDir)) return { where: 'outside', rooms: [], rel: null };
  const rel = path.relative(projectDir, absPath).split(path.sep).join('/');
  if (!rel) return { where: 'village', rooms: [], rel: '.' };
  const rooms = [];
  for (const m of map.matchers) {
    if (m.globs.some((g) => g(rel))) rooms.push(m.id);
  }
  return rooms.length ? { where: 'room', rooms, rel } : { where: 'village', rooms: [], rel };
}

/**
 * A search scoped to a folder (Grep or Glob `path`) lights the rooms that
 * claim the whole folder: the ones whose patterns match any file directly
 * inside it, tested with a placeholder name no extension pattern can match.
 * So a search in `db/` lights Database through `**\/db/**`, and one in
 * `server/` lights nothing a mere `**\/*.sql` would. A search of the whole
 * project lights no room: it is everywhere at once, which is nowhere useful.
 */
export function locateFolder(map, projectDir, absDir) {
  if (!isInsideDir(absDir, projectDir)) return { where: 'outside', rooms: [], rel: null };
  const rel = path.relative(projectDir, absDir).split(path.sep).join('/');
  if (!rel) return { where: 'project', rooms: [], rel: '.' };
  const probe = `${rel}/\u0000`;
  const rooms = [];
  for (const m of map.matchers) {
    if (m.globs.some((g) => g(probe))) rooms.push(m.id);
  }
  return rooms.length ? { where: 'room', rooms, rel } : { where: 'village', rooms: [], rel };
}

/**
 * What a shell call is, from its command heads: the strongest kind any
 * segment matches (test, then build, then migration), and its room; else a
 * plain shell call (kind null), which castle.js places by the files it names
 * (#176).
 */
export function classifyCommand(map, heads) {
  let best = null;
  const rank = { test: 3, build: 2, migration: 1 };
  for (const head of heads || []) {
    for (const rule of map.commands) {
      if (rule.words.length > head.length) continue;
      if (!rule.words.every((w, i) => head[i] === w)) continue;
      if (!best || rank[rule.kind] > rank[best.kind]) best = { kind: rule.kind, room: rule.room, rule: rule.words.join(' ') };
      break;
    }
  }
  return best || { kind: null, room: null, rule: null };
}

/**
 * Whether a shell call is git or GitHub CLI work, for the Sept (#186, owner
 * decisions 2026-10-02: git and gh), and what its Mason acts out there: the
 * strongest of its segments, push, then commit, then anything else (the
 * crank), then a read. Recognised by the command's first words (lowercased,
 * four at most), which castle.js keeps and never serves; nothing here runs
 * git. Null for a call with no git or gh segment.
 */
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'blame', 'shortlog', 'reflog', 'grep', 'ls-files']);
const GH_READS = new Set(['view', 'list', 'status', 'diff', 'checks']);
const ACT_RANK = { read: 1, shell: 2, commit: 3, push: 4 };
export function gitAct(heads) {
  let best = null;
  for (const head of heads || []) {
    const tool = String(head[0] || '').replace(/\.exe$/, '');
    let act = null;
    if (tool === 'git') {
      // The subcommand: the first word after git's own options; -C <dir> and
      // -c <key=value> (one word once lowercased) take the next word with them.
      let i = 1;
      while (i < head.length && head[i].startsWith('-')) i += head[i] === '-c' ? 2 : 1;
      const sub = head[i];
      act = sub === 'push' ? 'push' : sub === 'commit' ? 'commit' : GIT_READS.has(sub) ? 'read' : 'shell';
    } else if (tool === 'gh') {
      // `gh status` stands alone; every other read is a noun then a verb (pr view, run list).
      act = head[1] === 'status' || GH_READS.has(head[2]) ? 'read' : 'shell';
    }
    if (act && (!best || ACT_RANK[act] > ACT_RANK[best])) best = act;
  }
  return best;
}

/**
 * A test file's name, to the code it is named after (#177): x.test.js and
 * x.spec.ts name x.js and x.ts, test_x.py and x_test.py name x.py, x_test.go
 * names x.go, XTests.cs names X.cs. Null for a name that marks no test. The
 * name is at most 260 characters (commandPaths), so no pattern here costs
 * more than a pass or two over it.
 */
const TEST_NAMES = [
  [/^(.+)\.(?:test|spec)\.([A-Za-z0-9]+)$/i, (m) => `${m[1]}.${m[2]}`],
  [/^test_(.+\.py)$/i, (m) => m[1]],
  [/^(.+)_test\.(py|go)$/i, (m) => `${m[1]}.${m[2]}`],
  [/^(.+?)(?:Tests?|Spec)\.(cs|java|kt|swift|scala)$/, (m) => `${m[1]}.${m[2]}`],
];
export function codeNameOf(base) {
  for (const [re, to] of TEST_NAMES) {
    const m = re.exec(base);
    if (m && m[1]) return to(m);
  }
  return null;
}

/** Folders a project keeps tests in, left out of a test's path to mirror it onto the code's. */
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);

/**
 * What a test run's named test files are for (#177, owner decision: name
 * matching, a heuristic and said so). For each path inside the project whose
 * name marks a test: the code name it is named after (lowercased, for
 * castle.js to look up among files it has seen), and the rooms that claim that
 * code beside the test or where the path mirrors out of a test folder
 * (tests/a/x.test.js: a/x.js). Rooms of a test type or of a type no run can
 * prove are left out: the aim is the code under test.
 */
export function testedBy(map, projectDir, paths) {
  const names = [];
  const rooms = [];
  const typeOf = new Map(map.rooms.map((r) => [r.id, r.type]));
  const unprovable = new Set(ROOM_TYPES.filter((t) => t.provable === false).map((t) => t.type));
  const isCode = (id) => typeOf.get(id) !== 'tests' && !unprovable.has(typeOf.get(id));
  for (const p of paths || []) {
    if (!isInsideDir(p, projectDir)) continue;
    const rel = path.relative(projectDir, p).split(path.sep).join('/');
    const parts = rel.split('/');
    const code = codeNameOf(parts.pop());
    if (!code) continue;
    if (!names.includes(code.toLowerCase())) names.push(code.toLowerCase());
    const candidates = [[...parts, code].join('/')];
    const mirrored = parts.filter((s) => !TEST_DIRS.has(s.toLowerCase()));
    if (mirrored.length !== parts.length) candidates.push([...mirrored, code].join('/'));
    for (const c of candidates) {
      const loc = locate(map, projectDir, path.join(projectDir, c));
      if (loc.where === 'room') for (const id of loc.rooms) if (isCode(id) && !rooms.includes(id)) rooms.push(id);
    }
  }
  return { names, rooms };
}

/**
 * The prompt the page copies for "Copy prompt for Claude". Built here, from
 * the same type list and limits the loader checks, so the page never keeps a
 * copy of the schema that could drift from the validator.
 */
export function draftPrompt(projectDir) {
  const types = ROOM_TYPES.map((t) => `- ${t.type}: ${t.job}`).join('\n');
  return [
    `Write a file named ${CASTLE_FILE} at the root of this project (${projectDir}). It describes the project's sections as the rooms of LayerCake's Castle view, which shows where Claude is working. Read the project's layout first: its folders, entry points, and what each part does. Then give each real section of this project a room. Change no other file.`,
    '',
    `If ${CASTLE_FILE} already exists, keep every room's id and its col and row exactly as they are, and change its patterns only where the project changed. Put new rooms in empty cells at the edges of the grid. Never move a room: people learn the map by where rooms are.`,
    '',
    'Each room has a type, which gives it its icon and a job. Use these types only:',
    types,
    '',
    'Format:',
    '{',
    '  "version": 2,',
    '  "rooms": [',
    '    { "id": "scan", "name": "Scan and lineage", "type": "core", "col": 0, "row": 0, "patterns": ["server/scan.js", "server/paths.js"] }',
    '  ],',
    '  "gate": 1,',
    '  "commands": [ { "words": "npm run smoke", "kind": "test" } ],',
    '  "proof": ["test"]',
    '}',
    '',
    'Rules:',
    `- Name rooms for what they are in THIS project, in its own words, like "Snapshots and writes" or "Session history", not by their type. At most ${MAX_NAME_CHARS} characters. The id is 1 to 32 lowercase letters, digits and dashes, unique; not ${[...RESERVED_IDS].join(', ')}.`,
    `- At most ${MAX_ROOMS} rooms, on a grid of at most ${MAX_COLS} columns (col 0 to ${MAX_COLS - 1}) and ${MAX_ROWS} rows (row 0 to ${MAX_ROWS - 1}), one room per cell. Row 0 is the back of the castle; the gate is in the front wall, below the last row, under the column "gate" names. Put entry points (API, routes, the app's front door) in the last row beside the gate, storage and core logic toward the back, and related rooms next to each other.`,
    `- Patterns are relative to the project root with forward slashes. Only *, ? and ** are wildcards (no braces, [classes], ! or backslashes). ** must be a whole segment. A pattern with no slash matches at the root only, so write **/x.md for anywhere. At most ${MAX_PATTERNS_PER_ROOM} patterns per room, ${MAX_PATTERN_CHARS} characters each. A file may belong to several rooms; a file no room claims shows up in Hollowmere, the village by the road, which says the map needs a pattern.`,
    `- Runs go to rooms by type: test runs to the first "tests" room, build runs to the first "build" room, migrations to the first "database" room, and any other shell command to the first "build" room (else "config"). MCP calls wait above the first "integrations" room.`,
    `- "commands" lists this project's own test, build and migration commands by their first words; "kind" is ${COMMAND_KINDS.join(', ')}; "room" (a room id) is optional.`,
    '- "proof" says which passing runs take the scaffolding down: ["test"] (default) or ["test", "build"] for a project with no tests.',
  ].join('\n');
}
