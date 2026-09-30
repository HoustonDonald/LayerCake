/**
 * The Castle's map (#160): which room a file belongs to, and what a shell
 * command is. The floor plan is fixed (owner decision 2026-09-29, the 3x4
 * layout); a project's own castle.json can rename or drop rooms and set their
 * patterns, never move or add one (spec: "The map never moves").
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
const FOLD = process.platform === 'win32';

/**
 * The floor plan, back row first; the gate is under the Gatehouse. Keep, Great
 * Hall and Barracks are the assistant's additions to the nine rooms the spec
 * names (owner decision 2026-09-29). Built-in patterns come from folder and
 * file names that usually mean the job; a project whose layout says otherwise
 * writes castle.json.
 */
export const ROOMS = [
  {
    id: 'vault',
    name: 'Vault',
    job: 'database, schema, migrations',
    col: 0,
    row: 0,
    patterns: ['**/db/**', '**/database/**', '**/migrations/**', '**/models/**', '**/schema/**', '**/prisma/**', '**/*.sql', '**/schema.*'],
  },
  {
    id: 'keep',
    name: 'Keep',
    job: 'core logic, shared libraries',
    col: 1,
    row: 0,
    patterns: ['**/lib/**', '**/core/**', '**/shared/**', '**/common/**', '**/utils/**', '**/domain/**'],
  },
  {
    id: 'rookery',
    name: 'Rookery',
    job: 'MCP servers, integrations, outside services',
    col: 2,
    row: 0,
    patterns: ['**/integrations/**', '**/clients/**', '**/mcp/**', '**/webhooks/**', '**/.mcp.json'],
  },
  {
    id: 'scriptorium',
    name: 'Scriptorium',
    job: 'logs and logging',
    col: 0,
    row: 1,
    patterns: ['**/logs/**', '**/logging/**', '**/*.log', '**/logger.*'],
  },
  {
    id: 'library',
    name: 'Library',
    job: 'documentation',
    col: 1,
    row: 1,
    patterns: ['**/docs/**', '**/*.md', '**/*.mdx', '**/*.rst'],
  },
  {
    id: 'barracks',
    name: 'Barracks',
    job: 'background jobs, workers, queues',
    col: 2,
    row: 1,
    patterns: ['**/jobs/**', '**/workers/**', '**/queues/**', '**/cron/**', '**/tasks/**'],
  },
  {
    id: 'workshop',
    name: 'Workshop',
    job: 'configuration, scripts, build and CI',
    col: 0,
    row: 2,
    patterns: [
      '**/scripts/**',
      '**/.github/**',
      '**/.claude/**',
      '**/package.json',
      '**/package-lock.json',
      '**/*.config.*',
      '**/tsconfig*.json',
      '**/Dockerfile',
      '**/*.yml',
      '**/*.yaml',
      '**/*.toml',
      '**/Makefile',
      '**/*.csproj',
      '**/*.sln',
    ],
  },
  {
    id: 'great-hall',
    name: 'Great Hall',
    job: 'user interface: views, components, styles',
    col: 1,
    row: 2,
    patterns: [
      '**/client/**',
      '**/components/**',
      '**/pages/**',
      '**/views/**',
      '**/ui/**',
      '**/public/**',
      '**/*.css',
      '**/*.scss',
      '**/*.html',
      '**/*.jsx',
      '**/*.tsx',
      '**/*.vue',
      '**/*.svelte',
    ],
  },
  {
    id: 'proving-grounds',
    name: 'Proving Grounds',
    job: 'tests',
    col: 2,
    row: 2,
    patterns: ['**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/e2e/**', '**/*.test.*', '**/*.spec.*', '**/*smoke*'],
  },
  {
    id: 'watchtower',
    name: 'Watchtower',
    job: 'authentication and security',
    col: 0,
    row: 3,
    patterns: ['**/auth/**', '**/security/**', '**/permissions/**', '**/*auth*', '**/*security*'],
  },
  {
    id: 'gatehouse',
    name: 'Gatehouse',
    job: 'routes, API, entry points',
    col: 1,
    row: 3,
    patterns: ['**/routes/**', '**/api/**', '**/controllers/**', '**/endpoints/**', '**/handlers/**', '**/*routes*', '**/server.*', '**/app.*', '**/main.*'],
  },
  {
    id: 'stewards-hall',
    name: "Steward's Hall",
    job: 'services and request handling',
    col: 2,
    row: 3,
    patterns: ['**/services/**', '**/middleware/**', '**/validators/**', '**/*service*'],
  },
];

export const FLOOR = { cols: 3, rows: 4, gate: { col: 1 } };
const ROOM_IDS = new Set(ROOMS.map((r) => r.id));

/** Where a kind of command lights up when no rule names a room. */
const KIND_ROOM = { test: 'proving-grounds', build: 'workshop', migration: 'vault' };
export const COMMAND_KINDS = Object.keys(KIND_ROOM);
/** Any other shell call works in the Workshop (spec: "it works a crank or bellows"). */
export const SHELL_ROOM = 'workshop';

/**
 * Commands recognised without a castle.json, as word prefixes of a command
 * segment (lowercase). Projects add their own ahead of these.
 */
export const DEFAULT_COMMANDS = [
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
].map(([words, kind]) => ({ words: words.split(' '), kind, room: KIND_ROOM[kind], source: 'built-in' }));

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

/**
 * The built-in map, or a castle.json laid over it. Errors are values: a file
 * that cannot be used leaves the built-in map in force AND says why, so a
 * broken castle.json is never silently ignored.
 */
export function buildMap(parsed, source) {
  const rooms = ROOMS.map((r) => ({ ...r, patterns: [...r.patterns], dropped: false, custom: false }));
  const commands = [];
  let proof = ['test'];
  const problems = [];
  if (parsed !== undefined) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.push('the file must hold a JSON object');
    } else {
      if (parsed.rooms !== undefined && (typeof parsed.rooms !== 'object' || parsed.rooms === null || Array.isArray(parsed.rooms))) {
        problems.push('"rooms" must be an object keyed by room id');
      } else if (parsed.rooms) {
        for (const key of Object.keys(parsed.rooms)) {
          if (!ROOM_IDS.has(key)) problems.push(`"${key}" is not a room (rooms: ${[...ROOM_IDS].join(', ')})`);
        }
        for (const room of rooms) {
          // Own properties of the fixed ids only: a key named "constructor" or
          // "__proto__" is not a room (#48).
          if (!Object.hasOwn(parsed.rooms, room.id)) continue;
          const spec = parsed.rooms[room.id];
          if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
            problems.push(`rooms.${room.id} must be an object`);
            continue;
          }
          if (spec.name !== undefined) {
            if (typeof spec.name === 'string' && spec.name.trim() && spec.name.length <= 40) room.name = spec.name.trim();
            else problems.push(`rooms.${room.id}.name must be a string of 1 to 40 characters`);
          }
          if (spec.drop === true) room.dropped = true;
          if (spec.patterns !== undefined) {
            if (!Array.isArray(spec.patterns) || spec.patterns.length > MAX_PATTERNS_PER_ROOM) {
              problems.push(`rooms.${room.id}.patterns must be a list of at most ${MAX_PATTERNS_PER_ROOM}`);
            } else {
              const bad = spec.patterns.map(globProblem).filter(Boolean);
              if (bad.length) problems.push(...bad.map((b) => `rooms.${room.id}: ${b}`));
              else {
                room.patterns = spec.patterns.map((p) => p.replace(/^\.\//, ''));
                room.custom = true;
              }
            }
          }
        }
      }
      if (parsed.commands !== undefined) {
        if (!Array.isArray(parsed.commands) || parsed.commands.length > MAX_COMMAND_RULES) {
          problems.push(`"commands" must be a list of at most ${MAX_COMMAND_RULES}`);
        } else {
          parsed.commands.forEach((c, i) => {
            const words = c && typeof c === 'object' ? ruleWords(c.words) : null;
            const kind = c && typeof c === 'object' ? c.kind : null;
            const room = c && typeof c === 'object' && c.room !== undefined ? c.room : KIND_ROOM[kind];
            if (!words) problems.push(`commands[${i}].words must be the command's first words, like "npm run smoke"`);
            else if (!Object.hasOwn(KIND_ROOM, kind)) problems.push(`commands[${i}].kind must be one of ${COMMAND_KINDS.join(', ')}`);
            else if (typeof room !== 'string' || !ROOM_IDS.has(room)) problems.push(`commands[${i}].room is not a room`);
            else commands.push({ words, kind, room, source: 'castle.json' });
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
  const usable = problems.length === 0;
  const finalRooms = usable ? rooms : ROOMS.map((r) => ({ ...r, patterns: [...r.patterns], dropped: false, custom: false }));
  return {
    source: parsed === undefined ? 'built-in' : usable ? 'castle.json' : 'built-in',
    error: usable ? null : `castle.json not used: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''}`,
    file: source || null,
    rooms: finalRooms,
    commands: [...(usable ? commands : []), ...DEFAULT_COMMANDS],
    proof: usable ? proof : ['test'],
    matchers: finalRooms.map((r) => ({ id: r.id, dropped: r.dropped, globs: r.patterns.map(compileGlob) })),
  };
}

/**
 * Reads <projectDir>/castle.json through readForDisplay (size cap, share
 * gate, errors as values) and lays it over the built-in map. A missing file is
 * not an error: the built-in map is the default.
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
 * Where a file is: `{ where: 'room', rooms, rel }`, `{ where: 'wilds', rel }`
 * (in the project, claimed by no room) or `{ where: 'outside' }` (not in the
 * project, which no pattern could ever claim).
 */
export function locate(map, projectDir, absPath) {
  if (!isInsideDir(absPath, projectDir)) return { where: 'outside', rooms: [], rel: null };
  const rel = path.relative(projectDir, absPath).split(path.sep).join('/');
  if (!rel) return { where: 'wilds', rooms: [], rel: '.' };
  const rooms = [];
  for (const m of map.matchers) {
    if (m.dropped) continue;
    if (m.globs.some((g) => g(rel))) rooms.push(m.id);
  }
  return rooms.length ? { where: 'room', rooms, rel } : { where: 'wilds', rooms: [], rel };
}

/**
 * A search scoped to a folder (Grep or Glob `path`) lights the rooms that
 * claim the whole folder: the ones whose patterns match any file directly
 * inside it, tested with a placeholder name no extension pattern can match.
 * So a search in `db/` lights the Vault through `**\/db/**`, and one in
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
    if (m.dropped) continue;
    if (m.globs.some((g) => g(probe))) rooms.push(m.id);
  }
  return rooms.length ? { where: 'room', rooms, rel } : { where: 'wilds', rooms: [], rel };
}

/**
 * What a shell call is, from its command heads: the strongest kind any
 * segment matches (test, then build, then migration), and its room; else a
 * plain shell call in the Workshop.
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
  return best || { kind: null, room: SHELL_ROOM, rule: null };
}

/**
 * The prompt the page copies for "Copy prompt for Claude". Built here, from
 * the same room table and limits the loader checks, so the page never keeps a
 * copy of the schema that could drift from the validator.
 */
export function draftPrompt(projectDir) {
  const rooms = ROOMS.map((r) => `- ${r.id} (${r.name}): ${r.job}`).join('\n');
  return [
    `Write a file named ${CASTLE_FILE} at the root of this project (${projectDir}). It maps the project's files to the rooms of LayerCake's Castle view, which shows where Claude is working. Read the project's layout first, then assign folders and files to rooms by what they do. Change no other file.`,
    '',
    'Rooms (the ids are fixed; you may rename a room or drop one this project has nothing like):',
    rooms,
    '',
    'Format:',
    '{',
    '  "version": 1,',
    '  "rooms": { "<room id>": { "name": "optional new name", "drop": true, "patterns": ["src/db/**", "**/*.sql"] } },',
    '  "commands": [ { "words": "npm run smoke", "kind": "test" } ],',
    '  "proof": ["test"]',
    '}',
    '',
    'Rules:',
    `- Patterns are relative to the project root with forward slashes. Only *, ? and ** are wildcards (no braces, [classes], ! or backslashes). ** must be a whole segment. A pattern with no slash matches at the root only, so write **/x.md for anywhere. At most ${MAX_PATTERNS_PER_ROOM} patterns per room, ${MAX_PATTERN_CHARS} characters each.`,
    '- A room you leave out keeps its built-in patterns. Giving a room "patterns" replaces its built-in ones. A file may belong to several rooms.',
    `- "commands" lists this project's own test, build and migration commands by their first words; "kind" is ${COMMAND_KINDS.join(', ')}; "room" is optional.`,
    '- "proof" says which passing runs take the scaffolding down: ["test"] (default) or ["test", "build"] for a project with no tests.',
  ].join('\n');
}
