/**
 * Castle part of the smoke test (#159, #160): the live stream over the real
 * HTTP API, fed through the real ingest route (a dry-run launch) and through
 * synthetic transcripts, and read back the way the page reads it.
 *
 * Each check is the outcome a user would see: a room's state, a unit's place,
 * a count. The server runs with LAYERCAKE_CASTLE_TIME_SCALE (1/20), so the
 * 60 s windows are 3 s here and their lapses can be waited for.
 *
 * Sentinels mark tool input and output bodies a hook or transcript carries
 * (a Write's content, an Edit's strings, a shell's output, a Grep result, the
 * text after "Exit code N", a command's own words): none may appear in any
 * castle frame or route.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { compileGlob } from '../server/castlemap.js';
import { projectSlug } from '../server/paths.js';
import { get, idleProcess, postRaw } from './smoke-sessions.mjs';

const S = {
  writeContent: 'SMOKE-CASTLE-WRITE-CONTENT',
  oldString: 'SMOKE-CASTLE-OLD-STRING',
  newString: 'SMOKE-CASTLE-NEW-STRING',
  stdout: 'SMOKE-CASTLE-STDOUT',
  readBody: 'SMOKE-CASTLE-READ-BODY',
  grepBody: 'SMOKE-CASTLE-GREP-BODY',
  errorTail: 'SMOKE-CASTLE-ERROR-TAIL',
  transcriptOutput: 'SMOKE-CASTLE-TRANSCRIPT-OUTPUT',
  // A command's own first word: command heads are matched, never served.
  commandHead: 'smokecastleheadword',
  // A file a plain shell command names (#176): it chooses the room, and is never served.
  // No "smoke" in it: the built-in Tests room claims **/*smoke*.
  shellPath: 'castlegitpathsentinel',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An SSE reader for /api/castle/stream that keeps every frame, raw and parsed. */
function openCastle(base, scanId, headers) {
  const frames = [];
  const raw = [];
  let ended = false;
  let status = null;
  const req = http.get(`${base}/api/castle/stream?scanId=${encodeURIComponent(scanId)}`, { headers }, (res) => {
    status = res.statusCode;
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      raw.push(chunk);
      buf += chunk;
      for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event && data) frames.push({ event, data: JSON.parse(data), at: Date.now() });
      }
    });
    res.on('end', () => {
      ended = true;
    });
  });
  req.on('error', () => {
    ended = true;
  });
  const last = (event) => {
    for (let i = frames.length - 1; i >= 0; i -= 1) if (frames[i].event === event) return frames[i].data;
    return null;
  };
  const until = async (fn, ms = 3000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      try {
        if (fn()) return true;
      } catch {
        /* a frame not there yet */
      }
      if (Date.now() > deadline) return false;
      await sleep(40);
    }
  };
  return {
    frames,
    raw,
    get status() {
      return status;
    },
    get ended() {
      return ended;
    },
    last,
    until,
    untilState: (fn, ms) => until(() => fn(last('state')), ms),
    untilLog: (fn, ms) => until(() => fn(last('log')?.entries || []), ms),
    untilMap: (fn, ms) => until(() => fn(last('map')), ms),
    close: () => req.destroy(),
  };
}

/** A transcript line in the shape Claude Code 2.1.28x writes (surveyed 2026-09-29). */
function rec(sessionId, proj, at, fields) {
  return JSON.stringify({ uuid: `c0000000-0000-4000-8000-${String(rec.seq++).padStart(12, '0')}`, sessionId, cwd: proj, timestamp: new Date(at).toISOString(), version: '2.1.284', ...fields });
}
rec.seq = 1;

function toolUse(id, name, input) {
  return { type: 'assistant', message: { id: `m_${id}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } } };
}

function toolResult(id, content, result, isError = false) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, toolUseResult: result };
}

export async function runCastleChecks({ base, token, check, smokeDir, claudeData }) {
  const H = { 'X-LayerCake-Token': token };
  const proj = path.join(smokeDir, 'castle-proj');
  const P = (...parts) => path.join(proj, ...parts);
  for (const d of ['db', 'docs', 'src', 'tests', 'weird']) await fs.mkdir(P(d), { recursive: true });
  const scan = JSON.parse((await postRaw(base, '/api/scan', { dir: proj }, H)).body);
  const scanId = scan.scanId;

  check('the castle stream refuses a request with no token', (await get(base, `/api/castle/stream?scanId=${scanId}`, {})).status === 403);
  check('the castle stream refuses an unknown scan', (await get(base, '/api/castle/stream?scanId=scan-nope', H)).status === 404);

  // A dry-run launch gives this project a hook channel of its own.
  const launched = JSON.parse((await postRaw(base, '/api/launch', { scanId }, H)).body);
  const settings = JSON.parse(await fs.readFile(launched.settingsPath, 'utf8'));
  const m = /\/ingest\/([0-9a-f]{16})\/([0-9a-f]{48})\/hook$/.exec(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.url || '');
  const [launchId, secret] = m ? [m[1], m[2]] : ['0', '0'];
  const sid = launched.sessionId;
  let allEmpty = true;
  const hook = async (h) => {
    const r = await postRaw(base, `/ingest/${launchId}/${secret}/hook`, { session_id: sid, cwd: proj, ...h });
    allEmpty = allEmpty && r.status === 204 && r.body.length === 0;
    return r;
  };
  const call = async (id, tool, input, { response = {}, fail = null, agent = null } = {}) => {
    const who = agent ? { agent_id: agent, agent_type: 'Explore' } : {};
    await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input: input, ...who });
    if (fail !== null) await hook({ hook_event_name: 'PostToolUseFailure', tool_name: tool, tool_use_id: id, tool_input: input, error: fail, ...who });
    else await hook({ hook_event_name: 'PostToolUse', tool_name: tool, tool_use_id: id, tool_input: input, tool_response: response, ...who });
  };
  const statusline = () => postRaw(base, `/ingest/${launchId}/${secret}/statusline`, { session_id: sid });
  // The launched session keeps reporting, as a real one's status line does
  // every 15 s (smoke's report window is 4 s).
  await statusline();
  let keepAlive = setInterval(() => statusline().catch(() => {}), 1000);

  const bodies = [];
  const s1 = openCastle(base, scanId, H);
  try {
    check('the castle stream opens with the map first, then the state', await s1.until(() => s1.last('map') && s1.last('state'), 8000) && s1.frames[0]?.event === 'map', `status ${s1.status}`);
    const map = s1.last('map') || { rooms: [], states: [] };
    const cells = new Map(map.rooms.map((r) => [r.id, `${r.col},${r.row}`]));
    check('with no castle.json the map is the 12 built-in areas, each typed, with the type list and roles shipped',
      map.rooms.length === 12 && new Set(cells.values()).size === 12 && map.source === 'built-in' && map.error === null &&
        map.rooms.every((r) => map.types.some((t) => t.type === r.type)) && map.perch === 'integrations' &&
        JSON.stringify(map.floor) === JSON.stringify({ cols: 3, rows: 4, gate: { col: 1 } }),
      JSON.stringify({ n: map.rooms.length, source: map.source, error: map.error, perch: map.perch, floor: map.floor }));
    check('the map ships each room state with its rule, and the prompt for Claude built from the validator\'s limits',
      map.states.map((s) => s.state).join() === 'alarm,construction,survey,proven,embers,dark' && map.states.every((s) => s.rule && s.label) &&
        /castle\.json/.test(map.prompt) && /"version": 2/.test(map.prompt) && /- integrations: /.test(map.prompt) && /At most 24 rooms/.test(map.prompt) && /At most 50 patterns per room, 200 characters/.test(map.prompt));

    check('a launched session that is reporting stands at the gate before its first call',
      await s1.untilState((st) => st.sessions.some((x) => x.sessionId === sid && x.live && x.source === 'hooks') && st.units.some((u) => u.key === `M:${sid}` && u.room === 'gate'), 8000),
      JSON.stringify(s1.last('state')?.sessions));

    // --- one call: timing, room, unit -------------------------------------------
    const t0 = Date.now();
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_c_read', tool_input: { file_path: P('docs', 'guide.md') } });
    const seen = await s1.untilLog((es) => es.some((e) => e.id === 'toolu_c_read'), 3000);
    const latency = Date.now() - t0;
    check('a tool call of a launched session reaches the castle stream within 1 s (#159)', seen && latency < 1000, `${latency} ms`);
    check('a read lights its room as Survey and moves the session\'s Mason there',
      await s1.untilState((st) => st.rooms.docs.state === 'survey' && st.units.find((u) => u.key === `M:${sid}`)?.room === 'docs'),
      JSON.stringify(s1.last('state')?.rooms?.docs));
    // What the hover card says it is doing (#162): the call, as the log's one line, where, still running.
    const lastOf = (st, key) => st?.units?.find((u) => u.key === key)?.last;
    check("the Mason carries the call it is on now: its tool, its one-line summary, where, and no end yet",
      await s1.untilState((st) => {
        const l = lastOf(st, `M:${sid}`);
        return l && l.id === 'toolu_c_read' && l.tool === 'Read' && l.summary === P('docs', 'guide.md') && l.where === 'Docs' && l.endAt === null;
      }), JSON.stringify(lastOf(s1.last('state'), `M:${sid}`)));
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_c_read', tool_input: { file_path: P('docs', 'guide.md') }, tool_response: { type: 'text', file: { content: S.readBody } } });
    check('and when the call ends it says when', await s1.untilState((st) => typeof lastOf(st, `M:${sid}`)?.endAt === 'number'), JSON.stringify(lastOf(s1.last('state'), `M:${sid}`)));

    // --- change, scaffolding, a failing and a passing run -------------------------
    await call('toolu_c_edit', 'Edit', { file_path: P('db', 'schema.sql'), old_string: S.oldString, new_string: S.newString }, { response: { filePath: P('db', 'schema.sql'), oldString: S.oldString, newString: S.newString } });
    check('an edit lights its room as Construction and puts up scaffolding',
      await s1.untilState((st) => st.rooms.database.state === 'construction' && st.rooms.database.scaffolding === true), JSON.stringify(s1.last('state')?.rooms?.database));

    const testCmd = { command: `${S.commandHead} --flag && npm test`, description: 'Run the tests' };
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_c_t1', tool_input: testCmd });
    check('a running test run lights the Tests room', await s1.untilState((st) => st.rooms.tests.state === 'survey'));
    const unitOf = (st, key) => st?.units?.find((u) => u.key === key);
    check('a running test run brings Raiders out of the Wilds, aimed at the room with unproven changes, the one it will judge (#172)',
      await s1.untilState((st) => {
        const u = unitOf(st, 'X:toolu_c_t1');
        return u?.kind === 'raiders' && u.room === 'wilds' && JSON.stringify(u.targets) === JSON.stringify(['database']);
      }),
      JSON.stringify(unitOf(s1.last('state'), 'X:toolu_c_t1')));
    await hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_c_t1', tool_input: testCmd, error: `Exit code 1\n${S.errorTail}` });
    check('the Raiders leave when the run ends', await s1.untilState((st) => !unitOf(st, 'X:toolu_c_t1')), JSON.stringify(unitOf(s1.last('state'), 'X:toolu_c_t1')));
    check('a failing test run raises Alarm in the room with unproven changes, naming the run and its exit code',
      await s1.untilState((st) => st.rooms.database.state === 'alarm' && st.rooms.database.cause?.kind === 'run' && st.rooms.database.cause.exitCode === 1 && st.rooms.database.cause.summary === 'Run the tests'),
      JSON.stringify(s1.last('state')?.rooms?.database));
    check('the run is listed as failed, with the rooms it judged', s1.last('state')?.runs?.some((r) => r.id === 'toolu_c_t1' && r.ok === false && r.exitCode === 1 && r.judged.includes('database')));

    await call('toolu_c_t2', 'Bash', testCmd, { response: { stdout: S.stdout, stderr: '', interrupted: false } });
    check('a passing test run clears that Alarm and takes the scaffolding down',
      await s1.untilState((st) => st.rooms.database.state !== 'alarm' && st.rooms.database.scaffolding === false), JSON.stringify(s1.last('state')?.rooms?.database));
    check('once Construction lapses, the room shows Proven, naming the run',
      await s1.untilState((st) => st.rooms.database.state === 'proven' && st.rooms.database.cause?.runId === 'toolu_c_t2', 6000), JSON.stringify(s1.last('state')?.rooms?.database));

    // --- thrash, and a passing build ending it ------------------------------------
    for (let i = 1; i <= 4; i += 1) await call(`toolu_c_th${i}`, 'Edit', { file_path: P('src', 'app.js'), old_string: 'a', new_string: 'b' }, { response: { filePath: P('src', 'app.js') } });
    check('four edits of one file with no passing run between raise a thrash Alarm naming the file',
      await s1.untilState((st) => st.rooms.api.state === 'alarm' && st.rooms.api.cause?.kind === 'thrash' && st.rooms.api.cause.path === 'src/app.js'),
      JSON.stringify(s1.last('state')?.rooms?.api));
    const buildCmd = { command: 'npm run build', description: 'Build' };
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_c_build', tool_input: buildCmd });
    check('a running build brings a crane to the gate, building onto the room with unproven changes (#173)',
      await s1.untilState((st) => {
        const u = unitOf(st, 'X:toolu_c_build');
        return u?.kind === 'crane' && u.room === 'gate' && JSON.stringify(u.targets) === JSON.stringify(['api']);
      }),
      JSON.stringify(unitOf(s1.last('state'), 'X:toolu_c_build')));
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_c_build', tool_input: buildCmd, tool_response: { stdout: '', stderr: '' } });
    check('and it leaves when the build ends', await s1.untilState((st) => !unitOf(st, 'X:toolu_c_build')));
    check('a passing build ends the thrash Alarm (spec: "no passing test or build in between")', await s1.untilState((st) => st.rooms.api.state !== 'alarm'));
    check('a passing build is not proof by default: the scaffolding stays up', s1.last('state')?.rooms?.api?.scaffolding === true);
    // A thrash nothing will clear, in the room the Mason already stands in (so
    // no trail below moves). No passing run follows under the built-in map, so
    // it must lapse by time alone; checked before the fold oracle (#170).
    for (let i = 1; i <= 4; i += 1) await call(`toolu_c_lapse${i}`, 'Edit', { file_path: P('scripts', 'deploy.sh'), old_string: 'a', new_string: 'b' }, { response: { filePath: P('scripts', 'deploy.sh') } });
    const lapseFrom = Date.now();
    check('four edits of a script raise a thrash Alarm in its room too',
      await s1.untilState((st) => st.rooms.build.state === 'alarm' && st.rooms.build.cause?.kind === 'thrash' && st.rooms.build.cause.path === 'scripts/deploy.sh'),
      JSON.stringify(s1.last('state')?.rooms?.build));

    // --- no verdict: a denial, a rejection, an interrupt ---------------------------
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_c_deny', tool_input: { file_path: P('docs', 'x.md') } });
    await hook({ hook_event_name: 'PermissionDenied', tool_name: 'Edit', tool_use_id: 'toolu_c_deny', tool_input: { file_path: P('docs', 'x.md') } });
    await call('toolu_c_reject', 'Edit', { file_path: P('docs', 'y.md') }, { fail: '<tool_use_error>String to replace not found in file.</tool_use_error>' });
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_c_int', tool_input: { file_path: P('docs', 'z.md') } });
    await hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_use_id: 'toolu_c_int', tool_input: { file_path: P('docs', 'z.md') }, error: 'aborted', is_interrupt: true });
    await sleep(400);
    const noVerdict = s1.last('log')?.entries || [];
    check('a denied, rejected or interrupted change raises no Alarm, and says it had no verdict',
      s1.last('state')?.rooms?.docs?.state !== 'alarm' &&
        noVerdict.find((e) => e.id === 'toolu_c_deny')?.verdict === 'no verdict (denied)' &&
        noVerdict.find((e) => e.id === 'toolu_c_reject')?.verdict === 'no verdict (rejected)' &&
        noVerdict.find((e) => e.id === 'toolu_c_int')?.verdict === 'no verdict (interrupted)',
      JSON.stringify(noVerdict.filter((e) => /toolu_c_(deny|reject|int)/.test(e.id || ''))));

    // --- a change that fails, cleared by a later success ---------------------------
    await call('toolu_c_wfail', 'Write', { file_path: P('tests', 'a.test.js'), content: S.writeContent }, { fail: 'EACCES: permission denied' });
    check('a change that fails raises Alarm in its room', await s1.untilState((st) => st.rooms.tests.state === 'alarm' && st.rooms.tests.cause?.kind === 'tool'));
    await call('toolu_c_rok', 'Read', { file_path: P('tests', 'a.test.js') }, { response: { file: { content: S.readBody } } });
    check('a later successful call in that room clears it', await s1.untilState((st) => st.rooms.tests.state !== 'alarm'));

    await call('toolu_c_create', 'Write', { file_path: P('src', 'services', 'new.js'), content: S.writeContent }, { response: { type: 'create', filePath: P('src', 'services', 'new.js'), content: S.writeContent } });
    check('a created file lights its room as Construction', await s1.untilState((st) => st.rooms.services.state === 'construction'));

    // --- Hollowmere, the Citadel, and a search scoped to a folder -----------------
    await call('toolu_c_wild', 'Read', { file_path: P('weird', 'thing.xyz') });
    await call('toolu_c_out', 'Read', { file_path: path.join(smokeDir, 'elsewhere.txt') });
    check('a file no room claims counts in Hollowmere, the village (#172); a file outside the project is counted apart',
      await s1.untilState((st) => st.village?.count === 1 && st.village.recent[0]?.path === 'weird/thing.xyz' && st.outside.count === 1 && !('wilds' in st)),
      JSON.stringify({ village: s1.last('state')?.village, outside: s1.last('state')?.outside }));
    await call('toolu_c_grep', 'Grep', { pattern: 'x', path: 'db' }, { response: { mode: 'content', content: S.grepBody, filenames: [P('db', 'schema.sql')] } });
    check('a search in a folder given relative to the session\'s cwd lights that folder\'s room',
      await s1.untilState((st) => st.rooms.database.state === 'survey'), JSON.stringify(s1.last('state')?.rooms?.database));

    // --- the trail the page walks (#161) ------------------------------------------
    // Every call above, as the room changes it made: in order, a run of calls
    // in one room as one visit (t2, th2 to th4, reject, int, rok), each keyed
    // by the call that caused it.
    const walked = [
      ['docs', 'read'], ['database', 'edit'], ['tests', 't1'], ['api', 'th1'], ['build', 'build'], ['docs', 'deny'],
      ['tests', 'wfail'], ['services', 'create'], ['village', 'wild'], ['outside', 'out'], ['database', 'grep'],
    ].map(([room, id]) => ({ room, key: `s:toolu_c_${id}` }));
    const trailOf = (st, key) => st?.units?.find((u) => u.key === key)?.trail;
    check("a Mason's trail lists every room its calls took it to, in order, one entry per visit, keyed by the call",
      JSON.stringify(trailOf(s1.last('state'), `M:${sid}`)) === JSON.stringify(walked), JSON.stringify(trailOf(s1.last('state'), `M:${sid}`)));

    // --- units: Knight, Wizard, Raven, Scout, Herald ---------------------------------
    const agent = 'ac0ffee0c0ffee00c';
    await hook({ hook_event_name: 'SubagentStart', agent_id: agent, agent_type: 'Explore' });
    check('a subagent arrives as a Knight', await s1.untilState((st) => st.units.some((u) => u.key === `K:${agent}` && u.agentType === 'Explore')));
    const masonBefore = s1.last('state')?.units?.find((u) => u.key === `M:${sid}`)?.room;
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_c_sub', tool_input: { file_path: P('docs', 'sub.md') }, agent_id: agent, agent_type: 'Explore' });
    check("a subagent's call moves its Knight, not the Mason",
      await s1.untilState((st) => st.units.find((u) => u.key === `K:${agent}`)?.room === 'docs' && st.units.find((u) => u.key === `M:${sid}`)?.room === masonBefore),
      JSON.stringify(s1.last('state')?.units));
    check("the Knight has a trail of its own, and the Mason's is unchanged by the Knight's call",
      JSON.stringify(trailOf(s1.last('state'), `K:${agent}`)) === JSON.stringify([{ room: 'docs', key: 's:toolu_c_sub' }]) &&
        JSON.stringify(trailOf(s1.last('state'), `M:${sid}`)) === JSON.stringify(walked),
      JSON.stringify(trailOf(s1.last('state'), `K:${agent}`)));
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_c_sub', tool_input: { file_path: P('docs', 'sub.md') }, tool_response: {}, agent_id: agent });
    await hook({ hook_event_name: 'SubagentStop', agent_id: agent, agent_type: 'Explore' });
    check('a subagent that stops leaves', await s1.untilState((st) => !st.units.some((u) => u.key === `K:${agent}`)));
    const logBefore = (s1.last('log')?.entries || []).length;
    await hook({ hook_event_name: 'SubagentStop', agent_id: 'aeeeeeeeeeeeeeeee', agent_type: '' });
    await sleep(400);
    check('an internal agent that stops without starting adds no Knight and no log line',
      !s1.last('state')?.units?.some((u) => u.key === 'K:aeeeeeeeeeeeeeeee') && (s1.last('log')?.entries || []).length === logBefore);

    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_use_id: 'toolu_c_skill', tool_input: { skill: 'pdf' } });
    check('a skill Claude invokes stands beside its caller as a Wizard',
      await s1.untilState((st) => {
        const w = st.units.find((u) => u.kind === 'wizard');
        return w && w.label === 'pdf' && w.room === st.units.find((u) => u.key === `M:${sid}`)?.room;
      }));
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_use_id: 'toolu_c_skill', tool_input: { skill: 'pdf' }, tool_response: {} });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' });
    check("the Wizard leaves when its caller's turn ends", await s1.untilState((st) => !st.units.some((u) => u.kind === 'wizard')));

    await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__smoke__lookup', tool_use_id: 'toolu_c_mcp', tool_input: {} });
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_use_id: 'toolu_c_web', tool_input: { url: 'https://example.invalid/' } });
    check('an MCP call is a Raven on its perch, and a web fetch a Scout beyond the gate, while they run',
      await s1.untilState((st) => st.units.some((u) => u.key === 'R:toolu_c_mcp' && u.room === 'perch') && st.units.some((u) => u.key === 'S:toolu_c_web' && u.room === 'beyond-gate')));
    check('each says what it calls: the Raven its MCP tool, the Scout its tool and URL',
      s1.last('state')?.units?.some((u) => u.key === 'R:toolu_c_mcp' && u.tool === 'mcp__smoke__lookup' && u.label === 'smoke') &&
        s1.last('state')?.units?.some((u) => u.key === 'S:toolu_c_web' && u.tool === 'WebFetch' && u.label === 'https://example.invalid/'),
      JSON.stringify(s1.last('state')?.units?.filter((u) => u.kind === 'raven' || u.kind === 'scout')));
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__smoke__lookup', tool_use_id: 'toolu_c_mcp', tool_input: {}, tool_response: {} });
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'WebFetch', tool_use_id: 'toolu_c_web', tool_input: { url: 'https://example.invalid/' }, tool_response: {} });
    check('they return when the call does', await s1.untilState((st) => !st.units.some((u) => u.kind === 'raven' || u.kind === 'scout')));

    await hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    check('Claude waiting for the user brings the Herald to the gate', await s1.untilState((st) => st.units.some((u) => u.key === `H:${sid}` && u.room === 'gate') && st.sessions.find((x) => x.sessionId === sid)?.waiting === 'permission_prompt'));
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_c_after', tool_input: { file_path: P('docs', 'guide.md') } });
    check('and it leaves once Claude moves again', await s1.untilState((st) => !st.units.some((u) => u.kind === 'herald')));
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_c_after', tool_input: { file_path: P('docs', 'guide.md') }, tool_response: {} });

    await call('toolu_c_bg', 'Bash', { command: 'npm test', run_in_background: true, description: 'Tests in the background' }, { response: { stdout: '', backgroundTaskId: 'bg1' } });
    check('a test run started in the background has no verdict',
      await s1.untilState((st) => st.runs.some((r) => r.id === 'toolu_c_bg' && r.ok === null && r.noVerdict === 'started in the background')));
    // Two more visits (the Library, the Proving Grounds) make 13: the trail
    // keeps the latest 12, the oldest going first.
    const kept = [...walked.slice(1), { room: 'docs', key: 's:toolu_c_after' }, { room: 'tests', key: 's:toolu_c_bg' }];
    check("a Mason's trail is bounded: the latest 12 visits, still in order",
      JSON.stringify(trailOf(s1.last('state'), `M:${sid}`)) === JSON.stringify(kept), JSON.stringify(trailOf(s1.last('state'), `M:${sid}`)));

    // #176: a plain shell call works in the rooms of the files it names; one that names none moves no one.
    const masonRoom = () => s1.last('state')?.units?.find((u) => u.key === `M:${sid}`)?.room;
    const roomBefore = masonRoom();
    await call('toolu_c_gitstatus', 'Bash', { command: 'git status', description: 'Status' }, { response: { stdout: '' } });
    await s1.untilLog((es) => es.some((e) => e.id === 'toolu_c_gitstatus' && e.endAt), 3000);
    await sleep(400);
    check('a plain shell call that names no file lights no room and moves no one (#176)',
      (s1.last('log')?.entries || []).find((e) => e.id === 'toolu_c_gitstatus')?.where === 'shell' && masonRoom() === roomBefore,
      JSON.stringify({ where: (s1.last('log')?.entries || []).find((e) => e.id === 'toolu_c_gitstatus')?.where, roomBefore, now: masonRoom() }));
    await call('toolu_c_gitadd', 'Bash', { command: `git add db/${S.shellPath}.sql origin/main`, description: 'Stage the schema' }, { response: { stdout: '' } });
    check("a plain shell call that names a project file works in that file's room, and the Mason walks there (#176)",
      (await s1.untilState((st) => st.units.find((u) => u.key === `M:${sid}`)?.room === 'database')) &&
        (await s1.untilLog((es) => es.find((e) => e.id === 'toolu_c_gitadd')?.where === 'shell in Database', 3000)),
      JSON.stringify({ where: (s1.last('log')?.entries || []).find((e) => e.id === 'toolu_c_gitadd')?.where, room: masonRoom() }));
    check('a word no room claims (origin/main) sends nothing to Hollowmere (#176)', s1.last('state')?.village?.count === 1, JSON.stringify(s1.last('state')?.village));

    // Resting (#162's hover card showed "resting" beside "working"): a call
    // still running past the rest window (3 s here) is work; once it ends, the
    // window counts from its end.
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_c_long', tool_input: { file_path: P('docs', 'long.md') } });
    await sleep(3800);
    const masonNow = () => s1.last('state')?.units?.find((u) => u.key === `M:${sid}`);
    check('a worker whose call is still running past the rest window is not resting', masonNow()?.resting === false && masonNow()?.last?.id === 'toolu_c_long', JSON.stringify(masonNow()));
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_c_long', tool_input: { file_path: P('docs', 'long.md') }, tool_response: {} });
    check('and rests once the window passes after that call ends', await s1.untilState((st) => st.units.find((u) => u.key === `M:${sid}`)?.resting === true, 6000), JSON.stringify(masonNow()));

    // A run interrupted mid-way fires no end: the stop ends it, and its Raiders go with it (#172).
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_c_tstop', tool_input: { command: 'npm test', description: 'Tests, then Esc' } });
    check('Raiders stand while a test run runs', await s1.untilState((st) => unitOf(st, 'X:toolu_c_tstop')?.kind === 'raiders'), JSON.stringify(s1.last('state')?.units));
    await hook({ hook_event_name: 'Stop' });
    check('and leave when the turn stops with the run still open (#172)', await s1.untilState((st) => !unitOf(st, 'X:toolu_c_tstop')), JSON.stringify(unitOf(s1.last('state'), 'X:toolu_c_tstop')));

    // --- the transcript source --------------------------------------------------------
    const slugDir = path.join(claudeData, 'projects', projectSlug(proj));
    const sid2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const agent2 = 'a7777777777777777';
    // Stamped after every hook run above: the fold orders by time, and a
    // passing test run AFTER the subagent's edit would (rightly) prove it.
    const now = Date.now();
    await fs.mkdir(path.join(slugDir, sid2, 'subagents'), { recursive: true });
    await fs.writeFile(
      path.join(slugDir, `${sid2}.jsonl`),
      [
        rec(sid2, proj, now - 3000, { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Look at the keep' } }),
        rec(sid2, proj, now - 2800, toolUse('toolu_t_read', 'Read', { file_path: P('src', 'lib', 'core.js') })),
        rec(sid2, proj, now - 2700, toolResult('toolu_t_read', S.transcriptOutput, { type: 'text', file: { content: S.transcriptOutput } })),
      ].join('\n') + '\n'
    );
    await fs.writeFile(
      path.join(slugDir, sid2, 'subagents', `agent-${agent2}.jsonl`),
      [
        rec(sid2, proj, now - 2000, { isSidechain: true, agentId: agent2, ...toolUse('toolu_t_sub', 'Edit', { file_path: 'src/jobs/nightly.js', old_string: S.oldString, new_string: S.newString }) }),
        rec(sid2, proj, now - 1900, { isSidechain: true, agentId: agent2, ...toolResult('toolu_t_sub', 'ok', { filePath: P('src', 'jobs', 'nightly.js') }) }),
      ].join('\n') + '\n'
    );
    await fs.writeFile(path.join(slugDir, sid2, 'subagents', `agent-${agent2}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'nightly', toolUseId: 'toolu_t_agent', spawnDepth: 1 }));
    const child = idleProcess();
    const pidFile = path.join(claudeData, 'sessions', `${child.pid}.json`);
    await fs.writeFile(pidFile, JSON.stringify({ pid: child.pid, sessionId: sid2, cwd: proj, status: 'busy', kind: 'interactive', version: '2.1.284' }));

    check('a session started outside LayerCake is drawn from its transcript, and says so',
      await s1.untilState((st) => st.sessions.some((x) => x.sessionId === sid2 && x.source === 'transcript' && x.live), 8000), JSON.stringify(s1.last('state')?.sessions));
    check("its transcript's call lights its room and moves its Mason there",
      await s1.untilState((st) => st.rooms.core.state !== 'dark' && st.units.find((u) => u.key === `M:${sid2}`)?.room === 'core'), JSON.stringify(s1.last('state')?.units));
    check("its subagent's own transcript puts a Knight in the room of its call (a relative path resolved against the record's cwd), with scaffolding",
      await s1.untilState((st) => st.units.some((u) => u.key === `K:${agent2}` && u.room === 'jobs' && u.agentType === 'general-purpose') && st.rooms.jobs.scaffolding === true),
      JSON.stringify({ units: s1.last('state')?.units, jobs: s1.last('state')?.rooms?.jobs }));
    check("the Knight carries its task, from the subagent's own meta file", s1.last('state')?.units?.find((u) => u.key === `K:${agent2}`)?.task === 'nightly', JSON.stringify(s1.last('state')?.units?.find((u) => u.key === `K:${agent2}`)));
    await fs.appendFile(
      path.join(slugDir, `${sid2}.jsonl`),
      `${rec(sid2, proj, Date.now(), toolUse('toolu_t_late', 'Read', { file_path: P('docs', 'late.md') }))}\n`
    );
    check('a call appended to a transcript reaches the stream, and its lag is measured',
      (await s1.untilLog((es) => es.some((e) => e.id === 'toolu_t_late' && e.source === 'transcript'), 4000)) &&
        (await s1.untilState((st) => st.sessions.find((x) => x.sessionId === sid2)?.lagSamples >= 1, 3000)),
      JSON.stringify(s1.last('state')?.sessions?.find((x) => x.sessionId === sid2)));

    // #164: a command Claude Code refused before it ran is recorded in the
    // transcript as an error, with no hook failure behind it. It is not a
    // failed test run, and raises no Alarm on the scaffolded Barracks.
    await fs.appendFile(
      path.join(slugDir, `${sid2}.jsonl`),
      [
        rec(sid2, proj, Date.now(), toolUse('toolu_t_refused', 'PowerShell', { command: `cd "${proj}"; npm test` })),
        rec(sid2, proj, Date.now() + 5, toolResult('toolu_t_refused', 'Compound command changes working directory (Set-Location/Push-Location/Pop-Location/New-PSDrive) - relative paths cannot be validated against the original cwd and require manual approval', 'Error: Compound command changes working directory', true)),
        rec(sid2, proj, Date.now() + 10, toolUse('toolu_t_refused_edit', 'Edit', { file_path: P('src', 'jobs', 'other.js'), old_string: 'a', new_string: 'b' })),
        rec(sid2, proj, Date.now() + 15, toolResult('toolu_t_refused_edit', 'This edit outside the working directory requires manual approval', 'Error: requires manual approval', true)),
      ].join('\n') + '\n'
    );
    check('a command refused before it ran (only the transcript records it) is no failed test run, and a refused edit raises no Alarm (#164)',
      (await s1.untilState((st) => st.runs.some((r) => r.id === 'toolu_t_refused' && r.ok === null && r.noVerdict === 'not run'), 4000)) &&
        (await s1.untilLog((es) => es.find((e) => e.id === 'toolu_t_refused_edit')?.verdict === 'no verdict (not run)', 3000)) &&
        s1.last('state')?.rooms?.jobs?.state !== 'alarm',
      JSON.stringify({ runs: s1.last('state')?.runs, jobs: s1.last('state')?.rooms?.jobs?.state }));
    await call('toolu_c_timeout', 'Bash', { command: 'npm test', description: 'Tests that time out' }, { fail: 'Command timed out after 2m 0s' });
    check('a test run that fails with no exit code (a timeout) has no verdict (#164)',
      await s1.untilState((st) => st.runs.some((r) => r.id === 'toolu_c_timeout' && r.ok === null && r.noVerdict === 'no exit code')),
      JSON.stringify(s1.last('state')?.runs));

    // --- the launched session's own transcript: dedupe and backfill ---------------------
    await fs.writeFile(
      path.join(slugDir, `${sid}.jsonl`),
      [
        rec(sid, proj, t0 - 60_000, { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Before the hooks' } }),
        rec(sid, proj, t0 - 59_000, toolUse('toolu_c_before', 'Read', { file_path: P('docs', 'before.md') })),
        rec(sid, proj, t0 - 58_000, toolResult('toolu_c_before', 'ok', { type: 'text' })),
        rec(sid, proj, t0 + 10, toolUse('toolu_c_read', 'Read', { file_path: P('docs', 'guide.md') })),
        rec(sid, proj, t0 + 20, toolResult('toolu_c_read', S.transcriptOutput, { type: 'text' })),
      ].join('\n') + '\n'
    );
    check('the transcript backfills a launched session\'s calls from before its hooks began',
      await s1.untilLog((es) => es.some((e) => e.id === 'toolu_c_before' && e.source === 'transcript'), 5000));
    const logNow = s1.last('log')?.entries || [];
    check('a call both the hooks and the transcript report is shown once, from the hooks (keyed by tool_use_id)',
      logNow.filter((e) => e.id === 'toolu_c_read').length === 1 && logNow.find((e) => e.id === 'toolu_c_read')?.source === 'hooks',
      JSON.stringify(logNow.filter((e) => e.id === 'toolu_c_read')));
    const detail = await get(base, `/api/session/${sid}`, H);
    bodies.push(detail.body);
    check('the session view never serves the castle ring or command heads', detail.status === 200 && !/"castle"|"heads"|"targets"/.test(detail.body), `status ${detail.status}`);

    // Parallel calls the transcript records before their hooks arrive: as each
    // hook lands, the trail must keep the order it had (#161), or the page
    // walks those rooms again.
    // Stamped after every call above, and before the hooks below.
    await sleep(400);
    const tp = Date.now() - 200;
    const par = [['toolu_c_par1', P('docs', 'p1.md'), 'docs'], ['toolu_c_par2', P('db', 'p2.sql'), 'database'], ['toolu_c_par3', P('src', 'lib', 'p3.js'), 'core']];
    await fs.appendFile(path.join(slugDir, `${sid}.jsonl`), par.map(([id, file], i) => rec(sid, proj, tp + i, toolUse(id, 'Read', { file_path: file }))).join('\n') + '\n');
    const parTail = (st) => JSON.stringify(trailOf(st, `M:${sid}`)?.slice(-3));
    const parWant = JSON.stringify(par.map(([id, , room]) => ({ room, key: `s:${id}` })));
    check('parallel calls read from the transcript first join the trail in their order',
      await s1.untilState((st) => parTail(st) === parWant, 4000), parTail(s1.last('state')));
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_c_par1', tool_input: { file_path: par[0][1] } });
    await s1.untilLog((es) => es.find((e) => e.id === 'toolu_c_par1')?.source === 'hooks', 3000);
    const afterFirstHook = parTail(s1.last('state'));
    for (const [id, file] of par.slice(1)) await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: id, tool_input: { file_path: file } });
    await s1.untilLog((es) => es.filter((e) => /toolu_c_par/.test(e.id || '') && e.source === 'hooks').length === 3, 3000);
    check('and keep it as each of their hooks lands (a call both sources report takes the earlier time)',
      afterFirstHook === parWant && parTail(s1.last('state')) === parWant, `after the first hook ${afterFirstHook}, after all ${parTail(s1.last('state'))}`);

    // --- castle.json ----------------------------------------------------------------------
    await fs.writeFile(
      P('castle.json'),
      JSON.stringify({
        version: 2,
        rooms: [
          { id: 'treasury', name: 'Treasury of records', type: 'database', col: 0, row: 0, patterns: ['db/**'] },
          { id: 'manual', name: 'The manual', type: 'docs', col: 1, row: 0, patterns: ['manual/**'] },
          { id: 'front-door', name: 'Front door', type: 'api', col: 1, row: 1, patterns: ['src/app.js'] },
          { id: 'own-tests', name: 'Own tests', type: 'tests', col: 3, row: 1, patterns: ['tests/**'] },
        ],
        gate: 1,
        commands: [{ words: 'node run-tests.js', kind: 'test' }],
        proof: ['test', 'build'],
      })
    );
    const reloaded = await postRaw(base, '/api/castle/reload', { scanId }, H);
    check("castle.json version 2 gives the project its own rooms, types and places, and the floor their size",
      reloaded.status === 200 &&
        (await s1.untilMap((mp) => mp.source === 'castle.json' && !mp.error &&
          mp.rooms.map((r) => [r.id, r.name, r.type, r.col, r.row].join('|')).join() === 'treasury|Treasury of records|database|0|0,manual|The manual|docs|1|0,front-door|Front door|api|1|1,own-tests|Own tests|tests|3|1' &&
          JSON.stringify(mp.floor) === JSON.stringify({ cols: 4, rows: 2, gate: { col: 1 } }) && mp.perch === null)),
      JSON.stringify({ body: reloaded.body.slice(0, 200), rooms: s1.last('map')?.rooms?.map((r) => r.id), floor: s1.last('map')?.floor, error: s1.last('map')?.error }));
    check('the state frame carries exactly the rooms castle.json names',
      await s1.untilState((st) => Object.keys(st.rooms).sort().join() === 'front-door,manual,own-tests,treasury'), Object.keys(s1.last('state')?.rooms || {}).join());
    await call('toolu_c_manual', 'Read', { file_path: P('manual', 'guide.md') });
    check("a file a castle.json room claims lights that room", await s1.untilState((st) => st.rooms.manual.state === 'survey'), JSON.stringify(s1.last('state')?.rooms?.manual));
    await call('toolu_c_own', 'Bash', { command: 'node run-tests.js', description: 'Own tests' }, { response: { stdout: '' } });
    check("castle.json's command rule makes the project's own command a test run, in the first Tests room",
      await s1.untilState((st) => st.runs.some((r) => r.id === 'toolu_c_own' && r.kind === 'test') && st.rooms['own-tests'].state === 'survey'), JSON.stringify(s1.last('state')?.rooms?.['own-tests']));
    await call('toolu_c_moved', 'Read', { file_path: P('docs', 'q.md') });
    check("castle.json's patterns are the only ones: docs/ now lies in Hollowmere",
      await s1.untilLog((es) => es.find((e) => e.id === 'toolu_c_moved')?.where === 'Hollowmere'), JSON.stringify((s1.last('log')?.entries || []).find((e) => e.id === 'toolu_c_moved')));
    await call('toolu_c_ls', 'Bash', { command: 'ls -la', description: 'List' }, { response: { stdout: '' } });
    check('a plain shell call that names no file lights no room, on a castle.json map too',
      await s1.untilLog((es) => es.find((e) => e.id === 'toolu_c_ls')?.where === 'shell'), JSON.stringify((s1.last('log')?.entries || []).find((e) => e.id === 'toolu_c_ls')));

    // Documentation is never on trial (#170): Docs stayed in Alarm after every
    // hand-off, from thrash on HANDOFF.md and from runs judging it.
    for (let i = 1; i <= 4; i += 1) await call(`toolu_c_man${i}`, 'Edit', { file_path: P('manual', 'guide.md'), old_string: 'a', new_string: 'b' }, { response: { filePath: P('manual', 'guide.md') } });
    await s1.untilLog((es) => es.find((e) => e.id === 'toolu_c_man4')?.verdict === 'ok', 3000);
    await sleep(400);
    check('four edits of one file in a Docs room light it as Construction, with no scaffolding and no thrash (#170)',
      s1.last('state')?.rooms?.manual?.state === 'construction' && s1.last('state')?.rooms?.manual?.scaffolding === false,
      JSON.stringify(s1.last('state')?.rooms?.manual));
    await call('toolu_c_ownfail', 'Bash', { command: 'node run-tests.js', description: 'Own tests, failing' }, { fail: `Exit code 1\n${S.errorTail}` });
    check("a failing test run does not judge the Docs room: with nothing else unproven, the Alarm goes up in the run's own room (#170)",
      await s1.untilState((st) => st.runs.some((r) => r.id === 'toolu_c_ownfail' && r.ok === false && !r.judged.includes('manual')) && st.rooms['own-tests'].state === 'alarm' && st.rooms.manual.state !== 'alarm'),
      JSON.stringify({ manual: s1.last('state')?.rooms?.manual, run: s1.last('state')?.runs?.find((r) => r.id === 'toolu_c_ownfail') }));

    await fs.writeFile(P('castle.json'), '{ "rooms": ');
    await postRaw(base, '/api/castle/reload', { scanId }, H);
    check('an invalid castle.json leaves the built-in map in force AND says why',
      await s1.untilMap((mp) => mp.source === 'built-in' && /not valid JSON/.test(mp.error || '') && mp.rooms.find((r) => r.id === 'database')?.name === 'Database'), s1.last('map')?.error);
    await fs.writeFile(P('castle.json'), JSON.stringify({ version: 1, rooms: { vault: { name: 'Treasury' } } }));
    await postRaw(base, '/api/castle/reload', { scanId }, H);
    check('a version 1 castle.json (the old fixed rooms) is refused by name, pointing at the prompt',
      await s1.untilMap((mp) => mp.source === 'built-in' && /version 1 file/.test(mp.error || '') && /Copy prompt for Claude/.test(mp.error || '')), s1.last('map')?.error);
    await fs.writeFile(P('castle.json'), JSON.stringify({
      version: 2,
      rooms: [
        { id: 'gate', name: 'G', type: 'api', col: 0, row: 0 },
        { id: '__proto__', name: 'P', type: 'api', col: 1, row: 0 },
        { id: 'a', name: 'A', type: 'teleporter', col: 2, row: 0 },
        { id: 'b', name: 'B', type: 'ui', col: 3, row: 0, patterns: ['db/{a,b}/**'] },
        { id: 'c', name: 'C', type: 'ui', col: 3, row: 0 },
      ],
    }));
    await postRaw(base, '/api/castle/reload', { scanId }, H);
    check('castle.json version 2 refuses a reserved id, an id that is not a slug, an unknown type, two rooms in one cell and glob syntax beyond *, ? and **, each by name',
      await s1.untilMap((mp) => mp.source === 'built-in' && /"gate" is a place the castle already uses/.test(mp.error || '') && /rooms\[1\]\.id must be/.test(mp.error || '') && /"type" must be one of/.test(mp.error || '') && /both take col 3, row 0/.test(mp.error || '') && /only \*, \? and \*\*/.test(mp.error || '')),
      s1.last('map')?.error);
    await fs.writeFile(P('castle.json'), JSON.stringify({ version: 2, rooms: Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, name: `R${i}`, type: 'core', col: i % 4, row: Math.floor(i / 4) })) }));
    await postRaw(base, '/api/castle/reload', { scanId }, H);
    check('castle.json version 2 refuses more than 24 rooms', await s1.untilMap((mp) => mp.source === 'built-in' && /1 to 24 rooms/.test(mp.error || '')), s1.last('map')?.error);

    // A pattern that backtracking matchers take minutes over (measured with
    // picomatch 4.0.7 in review): timed against a benign one, both measured.
    const time = (pattern, subject) => {
      const g = compileGlob(pattern);
      const t = process.hrtime.bigint();
      for (let i = 0; i < 200; i += 1) g(subject);
      return Number(process.hrtime.bigint() - t);
    };
    const hostile = time(`${'*a'.repeat(12)}b`, 'a'.repeat(40));
    const benign = time('**/*.md', 'a'.repeat(40));
    const deep = time(`${'**/'.repeat(20)}x`, 'a/'.repeat(40) + 'y');
    check('a hostile glob costs about what a benign one does (the matcher never backtracks exponentially)', hostile < benign * 200 && deep < benign * 200, `${hostile} ns, ${deep} ns vs ${benign} ns`);
    const hostilePattern = `${'*a'.repeat(12)}b`;
    await fs.writeFile(P('castle.json'), JSON.stringify({ version: 2, rooms: [{ id: 'hostile', name: 'Hostile', type: 'core', col: 0, row: 0, patterns: [hostilePattern] }] }));
    await postRaw(base, '/api/castle/reload', { scanId }, H);
    // The control: the pattern is in force, or the timing below proves nothing.
    check('the hostile pattern is loaded (the control for the next check)', await s1.untilMap((mp) => mp.source === 'castle.json' && mp.rooms[0]?.patterns?.[0] === hostilePattern), s1.last('map')?.error);
    const th = Date.now();
    await call('toolu_c_hostile', 'Read', { file_path: P('a'.repeat(40)) });
    check('a hook through that pattern still reaches the stream within 1 s', (await s1.untilLog((es) => es.some((e) => e.id === 'toolu_c_hostile'), 3000)) && Date.now() - th < 1000, `${Date.now() - th} ms`);
    await fs.rm(P('castle.json'));
    await postRaw(base, '/api/castle/reload', { scanId }, H);
    await s1.untilMap((mp) => mp.source === 'built-in' && !mp.error);

    const roomRes = await get(base, `/api/castle/room?scanId=${scanId}&room=database`, H);
    bodies.push(roomRes.body);
    check("a room's recent files are served as paths", roomRes.status === 200 && JSON.parse(roomRes.body).recent.some((f) => f.path === 'db/schema.sql'), roomRes.body.slice(0, 300));
    const villageRes = await get(base, `/api/castle/room?scanId=${scanId}&room=village`, H);
    bodies.push(villageRes.body);
    check("Hollowmere's list is served by the room route as 'village' (#172)", villageRes.status === 200 && JSON.parse(villageRes.body).recent.some((f) => f.path === 'weird/thing.xyz'), villageRes.body.slice(0, 300));
    check('the room route refuses a room that is not on the map, or not an id at all', (await get(base, `/api/castle/room?scanId=${scanId}&room=__proto__`, H)).status === 400 && (await get(base, `/api/castle/room?scanId=${scanId}&room=no-such-room`, H)).status === 400);

    // --- thrash lapses (#170) ----------------------------------------------------------------
    // Raised on scripts/deploy.sh above (seen up then). The control is that no
    // test or build has passed since, so only time can have cleared it. Not a
    // timed "still up" check: the lapse is 6 s here, and the checks between
    // took 28.6 s beside two other smoke runs (the #170 mutation run).
    const { thrashLapseMs: lapse, thrashWindowMs: countWindow } = s1.last('map')?.windows || {};
    const passedSince = (s1.last('state')?.runs || []).filter((r) => r.ok === true && r.at >= lapseFrom);
    check('no test or build has passed since the thrash on the script went up (the control for the next checks)',
      lapse === 6000 && countWindow === 30_000 && passedSince.length === 0, `lapse ${lapse} ms, count ${countWindow} ms; passed since: ${JSON.stringify(passedSince)}`);
    await sleep(Math.max(0, lapseFrom + (lapse || 6000) + 1000 - Date.now()));
    check('a thrash Alarm lapses once 2 minutes (6 s here) pass with no further edit of that file (#170)',
      await s1.untilState((st) => st.rooms.build.state !== 'alarm', 3000), JSON.stringify(s1.last('state')?.rooms?.build));
    // Once its four edits have also left the 10-minute count, one more edit is
    // just an edit: the lapsed thrash must not come back with it.
    await sleep(Math.max(0, lapseFrom + (countWindow || 30_000) + 1000 - Date.now()));
    await call('toolu_c_lapse5', 'Edit', { file_path: P('scripts', 'deploy.sh'), old_string: 'a', new_string: 'b' }, { response: { filePath: P('scripts', 'deploy.sh') } });
    await s1.untilLog((es) => es.find((e) => e.id === 'toolu_c_lapse5')?.verdict === 'ok', 3000);
    await sleep(400);
    check('one more edit of that file after it lapsed, past the 10-minute count, is Construction, not the old thrash back (#170)',
      s1.last('state')?.rooms?.build?.state === 'construction', JSON.stringify(s1.last('state')?.rooms?.build));

    // --- the fold is the spec: a fresh fold equals the long-running one -------------------
    await sleep(3500); // every 3 s window lapses
    const strip = (st) => ({
      rooms: st.rooms,
      units: [...st.units].map(({ resting, ...u }) => u).sort((a, b) => a.key.localeCompare(b.key)),
      village: st.village,
      outside: st.outside,
      runs: st.runs,
      summary: st.summary,
    });
    await sleep(1200);
    const before = JSON.stringify(strip(s1.last('state')));
    s1.close();
    await sleep(500);
    check('with no stream open the castle is gone (state exists only while it is shown)', (await get(base, `/api/castle/room?scanId=${scanId}&room=database`, H)).status === 409);
    const s2 = openCastle(base, scanId, H);
    await s2.until(() => s2.last('state')?.sessions?.length >= 2, 8000);
    const after = JSON.stringify(strip(s2.last('state')));
    const firstDiff = (() => {
      const a = JSON.parse(before);
      const b = JSON.parse(after);
      for (const k of Object.keys(a)) {
        if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
        const inner = a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? Object.keys({ ...a[k], ...b[k] }).find((j) => JSON.stringify(a[k][j]) !== JSON.stringify(b[k]?.[j])) : null;
        return `${k}${inner ? `.${inner}` : ''}: before ${JSON.stringify(inner ? a[k][inner] : a[k]).slice(0, 400)} after ${JSON.stringify(inner ? b[k]?.[inner] : b[k]).slice(0, 400)}`;
      }
      return '';
    })();
    check('a fresh fold of the same events equals the long-running castle (the fold is the specification)', after === before, firstDiff);

    // --- a session with no hooks stops: no SessionEnd will ever come ---------------------
    // Its process going (the pid file with it) is the only evidence, and its
    // Mason and Knight must leave on it: a unit for a session that is gone
    // would be the castle inventing work.
    await fs.rm(pidFile, { force: true });
    check('a session with no hooks whose process is gone takes its units out and reads ended',
      await s2.untilState((st) => !st.units.some((u) => u.sessionId === sid2) && st.sessions.find((x) => x.sessionId === sid2)?.ended === true, 6000),
      JSON.stringify({ units: s2.last('state')?.units?.filter((u) => u.sessionId === sid2), session: s2.last('state')?.sessions?.find((x) => x.sessionId === sid2) }));

    // --- session end --------------------------------------------------------------------
    clearInterval(keepAlive);
    keepAlive = null;
    await hook({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    check('SessionEnd takes the session\'s units out, and the scaffolding it left stays up',
      await s2.untilState((st) => !st.units.some((u) => u.sessionId === sid) && st.sessions.find((x) => x.sessionId === sid)?.ended === true && st.rooms.api.scaffolding === true),
      JSON.stringify(s2.last('state')?.sessions));
    check('Proven ends with the session that ran the proof', s2.last('state')?.rooms?.database?.state !== 'proven', s2.last('state')?.rooms?.database?.state);

    // --- eviction ---------------------------------------------------------------------------
    for (let i = 0; i < 8; i += 1) await postRaw(base, '/api/scan', { dir: proj }, H);
    check('evicting its scan ends the castle stream', await s2.until(() => s2.ended, 5000));

    for (const s of [s1, s2]) bodies.push(s.raw.join(''));
    const all = bodies.join('\n');
    for (const [name, value] of Object.entries(S)) check(`no castle frame or route carries the ${name} sentinel`, !all.includes(value));
    check('every hook answer stayed an empty 204 while the castle watched', allEmpty);
    await fs.rm(pidFile, { force: true });
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    s1.close();
  }
}
