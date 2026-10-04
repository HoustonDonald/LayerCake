import React, { useCallback, useEffect, useRef, useState } from 'react';

import { followCastle, getCastleRoom, reloadCastleMap } from '../api.js';
import { duration } from '../sessionFormat.js';
import { FigureIcon } from './castleArt.jsx';
import { describeUnit } from './castleDescribe.js';
import CastleStage, { SESSION_COLOURS } from './CastleStage.jsx';

/**
 * The Castle view (#159, #160; docs/reference.md "Castle"): the running sessions in
 * the scanned project as rooms and units. Keyed on the project by App, so a
 * rescan hands it a new scan id and it reconnects without losing the picture.
 *
 * It never lies about being live: while the stream is down, a layer that does
 * not fade says since when and why, because a dead stream and a quiet castle
 * otherwise look exactly alike.
 */

/** No frame for this long (a ping comes every 30 s) means the stream is dead, whatever the socket says. */
const SILENT_MS = 70_000;

function useCastle(scanId) {
  const [map, setMap] = useState(null);
  const [state, setState] = useState(null);
  const [log, setLog] = useState([]);
  const [conn, setConn] = useState({ status: 'connecting', since: null, error: null, httpStatus: null, code: null });
  const [attempt, setAttempt] = useState(0);
  const [hidden, setHidden] = useState(() => document.hidden);
  // Bumped on every (re)connection: the stage shows a fresh picture at once
  // instead of holding states from before the gap.
  const [generation, setGeneration] = useState(0);
  const lastFrameAt = useRef(0);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    // Paused while the tab is hidden: nobody is looking, and each open stream
    // holds one of the browser's six connections to this server. A visible tab
    // reconnects and gets the whole picture again.
    if (!scanId || hidden) return undefined;
    let stopped = false;
    setConn((c) => ({ ...c, status: c.status === 'live' ? 'reconnecting' : 'connecting', error: null }));
    const mark = () => {
      if (stopped) return;
      lastFrameAt.current = Date.now();
      setConn((c) => (c.status === 'live' ? c : { status: 'live', since: new Date().toISOString(), error: null, httpStatus: null, code: null }));
    };
    let first = true;
    const stop = followCastle(scanId, {
      onMap: (m) => {
        if (first) {
          first = false;
          setGeneration((g) => g + 1);
        }
        mark();
        setMap(m);
      },
      onState: (s) => {
        mark();
        setState(s);
      },
      onLog: (l) => {
        mark();
        setLog(Array.isArray(l?.entries) ? l.entries : []);
      },
      onPing: mark,
      onError: (message, info) => {
        if (stopped) return;
        setConn({ status: 'down', since: new Date().toISOString(), error: message, httpStatus: info?.status ?? null, code: info?.code ?? null });
      },
    });
    const watchdog = setInterval(() => {
      if (lastFrameAt.current && Date.now() - lastFrameAt.current > SILENT_MS) {
        setConn((c) =>
          c.status === 'live' ? { status: 'down', since: new Date(lastFrameAt.current).toISOString(), error: 'Nothing heard from LayerCake for over a minute.', httpStatus: null, code: null } : c
        );
      }
    }, 10_000);
    return () => {
      stopped = true;
      clearInterval(watchdog);
      stop();
    };
  }, [scanId, hidden, attempt]);

  const reconnect = useCallback(() => setAttempt((a) => a + 1), []);
  return { map, state, log, conn, hidden, generation, reconnect };
}

/** Element full screen for the Castle view's root. One consumer today; moving it to its own file is the whole cost of reuse. */
function useFullscreen(ref) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState(null);
  const supported = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled);
  useEffect(() => {
    const onChange = () => setActive(Boolean(ref.current) && document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [ref]);
  const toggle = useCallback(() => {
    setError(null);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (ref.current) {
      ref.current.requestFullscreen().catch((err) => setError(`Full screen was refused: ${err?.message || 'the browser said no'}`));
    }
  }, [ref]);
  return { supported, active, toggle, error };
}

function clockTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ago(ms) {
  if (typeof ms !== 'number') return '–';
  return `${duration(Date.now() - ms)} ago`;
}

function sessionLabel(s) {
  const short = s.sessionId.slice(0, 8);
  const title = s.title ? `${s.title} (${short})` : short;
  let source;
  if (s.source === 'hooks') source = 'live from its hooks';
  else if (s.lagSamples) source = `from its transcript, about ${s.lagS} s behind; no waiting signal`;
  else source = 'from its transcript (lag not measured yet); no waiting signal';
  let status;
  if (s.live) status = 'running';
  else if (s.quiet === 'blocked') status = 'never reported (hooks or status line blocked)';
  else if (s.quiet === 'restart') status = 'not heard from since LayerCake restarted';
  else if (s.quiet === 'silent') status = 'most likely stopped';
  else status = 'ended';
  return { title, source, status };
}

function causeText(cause, map) {
  if (!cause) return null;
  const roomName = (id) => map?.rooms?.find((r) => r.id === id)?.name || id;
  switch (cause.kind) {
    case 'tool':
      return `${cause.tool || 'A change'} failed on ${cause.path || 'a file here'}, ${ago(cause.at)}.`;
    case 'run':
      return `A ${cause.runKind} run failed${cause.exitCode !== null && cause.exitCode !== undefined ? ` (exit ${cause.exitCode})` : ''} while this room had unproven changes, ${ago(cause.at)}: ${cause.summary || 'a command'}. This is a heuristic: the failing tests may have nothing to do with this room.`;
    case 'thrash':
      return `${cause.path} was edited ${cause.edits} times in ${duration(map?.windows?.thrashWindowMs)} with no passing run between (last ${ago(cause.at)}).`;
    case 'change':
      return `${cause.path || 'A file'} changed ${ago(cause.at)}.`;
    case 'activity':
      return `Worked on ${ago(cause.at)}.`;
    case 'proven':
      return `Proven by a passing run ${ago(cause.at)}: ${cause.summary || 'a command'}.`;
    default:
      return roomName(cause.kind);
  }
}

/**
 * Who stands in this place now and what each is working on: the hover card's
 * lines (castleDescribe), here for keyboard and touch too, where hover is not.
 */
function HereNow({ state, map, place }) {
  const here = (state?.units || []).filter((u) => u.room === place);
  if (!here.length) return null;
  return (
    <>
      <h4>Here now</h4>
      <ul className="drawer-units">
        {here.map((u) => {
          const d = describeUnit(u, { state, map });
          return (
            <li key={u.key}>
              <div className="unit-card-head">
                <span className="legend-figure">
                  <FigureIcon kind={u.kind} size={14} />
                </span>
                <strong>{d.title}</strong>
                {d.tags.map((t) => (
                  <span key={t} className="unit-card-tag">
                    {t}
                  </span>
                ))}
              </div>
              <dl>
                {d.rows.map(([k, v, note]) => (
                  <React.Fragment key={k}>
                    <dt>{k}</dt>
                    <dd>
                      {v}
                      {note && <span className="unit-card-note">{note}</span>}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Drawer({ scanId, map, state, selected, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  // Refetch when what the drawer lists changes: a room's last touch, or Hollowmere's or the Citadel's count.
  const stamp = selected === 'village' ? state?.village?.count : selected === 'outside' ? state?.outside?.count : (state?.rooms?.[selected]?.touchedAt ?? 0);
  useEffect(() => {
    let alive = true;
    setError(null);
    getCastleRoom(scanId, selected)
      .then((d) => alive && setDetail(d))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [scanId, selected, stamp]);

  if (selected === 'village' || selected === 'outside') {
    const village = selected === 'village';
    return (
      <aside className="castle-drawer">
        <div className="drawer-head">
          <h3>{village ? 'Hollowmere' : 'The Citadel'}</h3>
          <button className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="drawer-note">
          {village
            ? 'Files in the project that no room claims. Activity here means the map needs a pattern: add one to castle.json (Copy prompt for Claude drafts it).'
            : "Files outside the project folder: your home folder, Claude's configuration, other projects. No room can claim these; the Citadel keeps count of them so nothing is silently dropped."}
        </p>
        <HereNow state={state} map={map} place={selected} />
        {error && <div className="castle-error">{error}</div>}
        <ul className="drawer-files">
          {(detail?.recent || []).map((f) => (
            <li key={f.path}>
              <code>{f.path}</code> <span className="dim">{f.verb}, {ago(f.at)}</span>
            </li>
          ))}
          {detail && !detail.recent?.length && <li className="dim">Nothing yet.</li>}
        </ul>
      </aside>
    );
  }

  const room = map?.rooms?.find((r) => r.id === selected);
  const r = state?.rooms?.[selected];
  const def = map?.states?.find((s) => s.state === r?.state);
  if (!room) return null;
  const halfLife = map?.windows?.heatHalfLifeMs || 45_000;
  const heat = r?.heat?.v ? r.heat.v * 0.5 ** Math.max(0, (Date.now() - r.heat.t) / halfLife) : 0;
  return (
    <aside className="castle-drawer">
      <div className="drawer-head">
        <h3>{room.name}</h3>
        <button className="btn btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="dim">
        {map?.types?.find((t) => t.type === room.type)?.label || room.type}: {map?.types?.find((t) => t.type === room.type)?.job || ''}
      </div>
      <div className={`drawer-state st-${r?.state || 'dark'}`}>
        <strong>
          {def?.glyph ? `${def.glyph} ` : ''}
          {def?.label || r?.state || 'Dark'}
        </strong>
        <div className="drawer-rule">{def?.rule}</div>
      </div>
      {r?.cause && <p>{causeText(r.cause, map)}</p>}
      {r?.scaffolding && <p className="drawer-scaffold">Scaffolding: changed here since the last passing proof run, so unverified.</p>}
      <dl className="drawer-facts">
        <dt>Heat</dt>
        <dd>{heat.toFixed(1)}</dd>
        <dt>Last read or run</dt>
        <dd>{ago(r?.lastRead)}</dd>
        <dt>Last change</dt>
        <dd>{ago(r?.lastChange)}</dd>
      </dl>
      <HereNow state={state} map={map} place={selected} />
      <h4>Recent files</h4>
      {error && <div className="castle-error">{error}</div>}
      <ul className="drawer-files">
        {(detail?.recent || []).map((f) => (
          <li key={f.path}>
            <code>{f.path}</code> <span className="dim">{f.verb}, {ago(f.at)}</span>
          </li>
        ))}
        {detail && !detail.recent?.length && <li className="dim">None this session.</li>}
      </ul>
      <h4>Patterns {room.custom ? '(castle.json)' : '(built-in)'}</h4>
      <ul className="drawer-patterns">
        {room.patterns.map((p) => (
          <li key={p}>
            <code>{p}</code>
          </li>
        ))}
      </ul>
    </aside>
  );
}

const TIP_W = 320;

/**
 * The legend: each state and unit says what it means at once on hover or
 * keyboard focus, in the hover card's style (#174; the native title waited a
 * second and never showed on focus). The words are the server's rules
 * (ROOM_STATES, UNIT_KINDS), shipped with the map, so the page keeps no list.
 */
function Legend({ map }) {
  const [tip, setTip] = useState(null);
  const show = (title, text) => (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ title, text, x: r.left + r.width / 2, y: r.top });
  };
  const hide = () => setTip(null);
  const item = (key, className, title, text, children) => (
    <span
      key={key}
      className={className}
      tabIndex={0}
      aria-describedby={tip?.title === title ? 'castle-legend-tip' : undefined}
      onMouseEnter={show(title, text)}
      onMouseLeave={hide}
      onFocus={show(title, text)}
      onBlur={hide}
    >
      {children}
    </span>
  );
  return (
    <div className="castle-legend">
      {(map?.states || []).map((s) =>
        item(s.state, `legend-state st-${s.state}`, s.label, s.rule, (
          <>
            <span className="swatch" />
            {s.glyph ? `${s.glyph} ` : ''}
            {s.label}
          </>
        ))
      )}
      {item('unproven', 'legend-state scaffold', 'Unproven (scaffolding)', 'Changed since the last passing proof run: unverified work. A Docs room is never unproven.', (
        <>
          <span className="swatch" />
          unproven
        </>
      ))}
      <span className="legend-sep" />
      {(map?.units || []).map((u) =>
        item(u.kind, 'legend-unit', u.label, u.rule, (
          <>
            <span className="legend-figure">
              <FigureIcon kind={u.kind} size={14} />
            </span>{' '}
            {u.label}
          </>
        ))
      )}
      {tip && (
        // Above the item, centred on it, kept inside the window.
        <div
          id="castle-legend-tip"
          className="castle-unit-card legend-tip"
          role="tooltip"
          style={{ left: Math.max(8, Math.min(tip.x - TIP_W / 2, window.innerWidth - TIP_W - 8)), bottom: window.innerHeight - tip.y + 8, width: TIP_W }}
        >
          <div className="unit-card-head">
            <strong>{tip.title}</strong>
          </div>
          <div>{tip.text}</div>
        </div>
      )}
    </div>
  );
}

function EventLog({ log, state, map }) {
  const index = new Map((state?.sessions || []).map((s) => [s.sessionId, s.index]));
  const rows = [...log].reverse();
  return (
    <div className="castle-log">
      <table>
        <tbody>
          {rows.map((e, i) => (
            <tr key={`${e.at}-${i}`}>
              <td className="dim">{clockTime(e.at)}</td>
              <td>
                <span className="log-dot" style={{ background: SESSION_COLOURS[(index.get(e.sessionId) ?? 0) % SESSION_COLOURS.length] }} />
                {e.agentId ? 'K' : 'M'}
              </td>
              <td>{e.tool || e.kind}</td>
              <td className="log-summary">{e.summary}</td>
              <td>{e.where || ''}</td>
              <td className={e.verdict?.startsWith('failed') ? 'log-bad' : 'dim'}>{e.verdict || ''}</td>
              <td className="dim">{e.source}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td className="dim" colSpan={7}>
                No events yet{map ? '' : ' (connecting)'}.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function CastleView({ scanId, projectDir }) {
  const { map, state, log, conn, hidden, generation, reconnect } = useCastle(scanId);
  const rootRef = useRef(null);
  const fullscreen = useFullscreen(rootRef);
  const [selected, setSelected] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [copy, setCopy] = useState(null);
  const [reloadMsg, setReloadMsg] = useState(null);

  const copyPrompt = async () => {
    if (!map?.prompt) return;
    try {
      await navigator.clipboard.writeText(map.prompt);
      setCopy({ ok: true });
    } catch {
      // Refused when the page is not focused, among other things: the text is
      // shown instead, selected, for Ctrl+C.
      setCopy({ ok: false });
    }
  };
  const reload = async () => {
    setReloadMsg(null);
    try {
      const r = await reloadCastleMap(scanId);
      setReloadMsg(r.error ? r.error : `Map reloaded (${r.source}).`);
    } catch (err) {
      setReloadMsg(err.message);
    }
  };

  const sessions = state?.sessions || [];
  const summary = state?.summary;
  const busyNames = (summary?.busy || []).map((id) => map?.rooms?.find((r) => r.id === id)?.name || id);
  const notLive = conn.status === 'down';

  return (
    <div className={`castle-view${fullscreen.active ? ' is-fullscreen' : ''}`} ref={rootRef}>
      {/* While the stream is down the toolbar's facts are old: said so, and dimmed. */}
      <div className={`castle-toolbar${notLive ? ' is-stale' : ''}`}>
        <div className="castle-summary" aria-live="polite">
          {notLive && <span className="castle-error">Last known, as of {clockTime(Date.parse(conn.since))}: </span>}
          {summary ? (
            <>
              <strong>{summary.sessions}</strong> session{summary.sessions === 1 ? '' : 's'} · <strong>{summary.workers}</strong> worker
              {summary.workers === 1 ? '' : 's'} ·{' '}
              <strong className={summary.alarms ? 'summary-alarm' : ''}>
                {summary.alarms} alarm{summary.alarms === 1 ? '' : 's'}
              </strong>
              {busyNames.length ? <> · working in {busyNames.join(', ')}</> : <> · quiet</>}
              {state?.leftOut ? <span className="dim"> · {state.leftOut} oldest events left out (the latest 20,000 are shown)</span> : null}
            </>
          ) : (
            'Opening the castle…'
          )}
        </div>
        <div className="castle-actions">
          <button className={`btn btn-small${showLog ? ' active' : ''}`} onClick={() => setShowLog((v) => !v)}>
            Event log
          </button>
          {fullscreen.supported && (
            <button className="btn btn-small" onClick={fullscreen.toggle}>
              {fullscreen.active ? 'Exit full screen' : 'Full screen'}
            </button>
          )}
        </div>
        <div className="castle-sessions">
          {sessions.map((s) => {
            const l = sessionLabel(s);
            return (
              <span key={s.sessionId} className={`castle-session${s.live ? '' : ' gone'}`} title={s.sessionId}>
                <span className="log-dot" style={{ background: SESSION_COLOURS[s.index % SESSION_COLOURS.length] }} />
                {l.title} · {l.status} · {l.source}
                {s.waiting && <b className="session-waiting"> · waiting for you</b>}
              </span>
            );
          })}
          {state && !sessions.length && (
            <span className="dim">
              No session in {projectDir} yet. Start one in a terminal, or with Start Claude here on the Sessions tab (that one also reports when it waits for you).
            </span>
          )}
        </div>
        <div className="castle-mapbar">
          {map && (
            <>
              <span>
                Map: {map.source === 'castle.json' ? 'castle.json' : 'built-in'}
                {map.source === 'built-in' && !map.error ? ' (no castle.json)' : ''} · proof: {map.proof.join(' or ')} runs
              </span>
              {map.error && <span className="castle-error">{map.error}</span>}
              <button className="btn btn-small" onClick={reload}>
                Reload map
              </button>
              <button className="btn btn-small" onClick={copyPrompt} title="A prompt to paste into a Claude session in this project, so Claude drafts castle.json from the project's real layout.">
                Copy prompt for Claude
              </button>
              {copy?.ok && <span className="dim">Copied. Paste it into a session here.</span>}
              {reloadMsg && <span className="dim">{reloadMsg}</span>}
            </>
          )}
        </div>
        {copy && !copy.ok && (
          <textarea className="castle-prompt" readOnly value={map?.prompt || ''} ref={(el) => el?.select()} aria-label="Prompt for Claude" />
        )}
        {fullscreen.error && <div className="castle-error">{fullscreen.error}</div>}
      </div>

      <div className="castle-body">
        <div className="castle-stage">
          {map ? (
            <CastleStage map={map} state={state} generation={generation} selected={selected} onSelect={setSelected} />
          ) : (
            <div className="castle-empty">{conn.status === 'down' ? '' : 'Opening the castle…'}</div>
          )}
          {notLive && (
            <div className="castle-notlive" role="alert">
              <div>
                <strong>Not live since {clockTime(Date.parse(conn.since))}.</strong>
                <div>{conn.error}</div>
                {conn.httpStatus === 403 ? (
                  <div>LayerCake restarted, so this page's key is stale: reload the page.</div>
                ) : conn.code === 'ESCANGONE' ? (
                  <div>This scan has expired: scan the project again.</div>
                ) : (
                  <button className="btn btn-small" onClick={reconnect}>
                    Reconnect
                  </button>
                )}
              </div>
            </div>
          )}
          {conn.status === 'reconnecting' && <div className="castle-reconnecting">Reconnecting…</div>}
          {hidden && <div className="castle-reconnecting">Paused while hidden</div>}
          <Legend map={map} />
        </div>
        {selected && map && <Drawer scanId={scanId} map={map} state={state} selected={selected} onClose={() => setSelected(null)} />}
      </div>
      {showLog && <EventLog log={log} state={state} map={map} />}
    </div>
  );
}
