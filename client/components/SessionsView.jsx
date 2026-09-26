import React, { useCallback, useEffect, useRef, useState } from 'react';

import { followSession, getHistory, getSession, getUsage, launchClaude, listSessions, summarizeSession } from '../api.js';
import { clock, daysUntil, tokens, usd, when } from '../sessionFormat.js';
import SessionDetail from './SessionDetail.jsx';

const LIST_REFRESH_MS = 15000;
/** A live session can write several times a second; the detail is re-read at most this often. */
const DETAIL_THROTTLE_MS = 2000;

function Row({ s, selected, onSelect, kind }) {
  const expiresIn = kind === 'session' ? daysUntil(s.expiresAt) : null;
  return (
    <button className={`s-row${selected ? ' selected' : ''}${s.live ? ' is-live' : ''}`} onClick={() => onSelect(kind, s.sessionId)}>
      <div className="s-row-title">
        {s.live && <span className="health-dot h-working" title={`running${s.status ? `, ${s.status}` : ''}`} />}
        {s.title}
        {s.launched && <span className="launched-badge" title="Started from LayerCake: reports exact context, cost, limits and when it waits for you">wrapped</span>}
      </div>
      <div className="s-row-meta">
        <span>{when(s.lastAt)}</span>
        <span>{s.prompts} prompt{s.prompts === 1 ? '' : 's'}</span>
        {kind === 'session' && s.tools > 0 && <span>{s.tools} tools</span>}
        {kind === 'session' && s.errors > 0 && <span className="err">{s.errors} errors</span>}
        {expiresIn != null && !s.live && expiresIn <= 7 && <span className="warn">deleted in {expiresIn}d</span>}
        {kind === 'expired' && <span className="muted">transcript gone, card kept</span>}
        {kind === 'promptOnly' && <span className="muted">prompts only</span>}
      </div>
      {s.cwd && <div className="s-row-path">{s.cwd}</div>}
    </button>
  );
}

function Group({ title, items, kind, selected, onSelect, note }) {
  if (!items.length) return null;
  return (
    <div className="s-group">
      <div className="group-label">
        {title} <span className="s-count">{items.length}</span>
      </div>
      {note && <div className="s-group-note">{note}</div>}
      {items.map((s) => (
        <Row key={s.sessionId} s={s} kind={kind} selected={selected?.id === s.sessionId} onSelect={onSelect} />
      ))}
    </div>
  );
}

function KeptCard({ card }) {
  return (
    <div className="session-pane glow-offline">
      <div className="s-head">
        <div className="s-title">{card.title}</div>
        <div className="s-health">transcript deleted</div>
      </div>
      <div className="s-meta">
        <span>{card.cwd}</span>
        <span>started {clock(card.startedAt)}</span>
        <span>last active {clock(card.lastAt)}</span>
      </div>
      <p className="muted">
        Claude Code deleted this session&apos;s transcript after its retention period. LayerCake kept the card below when it
        last saw the session; the prompts and replies themselves are gone.
      </p>
      {card.recaps?.map((r) => (
        <div key={r.at} className="recap">
          <span className="muted">Claude Code recap, {clock(r.at)}: </span>
          {r.text}
        </div>
      ))}
      <div className="stats">
        <div className="stat"><div className="stat-value">{card.prompts ?? '–'}</div><div className="stat-label">prompts</div></div>
        <div className="stat"><div className="stat-value">{card.tools ?? '–'}</div><div className="stat-label">tool calls</div></div>
        <div className="stat"><div className="stat-value">{card.filesEdited ?? '–'}</div><div className="stat-label">files edited</div></div>
        <div className="stat"><div className="stat-value">{tokens(card.tokens?.output)}</div><div className="stat-label">tokens out</div></div>
      </div>
      {card.aiSummary && (
        <div className="ai-summary">
          <div className="ai-summary-head">
            AI summary <span className="muted">· {clock(card.aiSummary.at)} · {card.aiSummary.model}</span>
          </div>
          <div className="ai-summary-text">{card.aiSummary.text}</div>
        </div>
      )}
      {card.firstPrompt && (
        <div className="turn-prompt">
          <div className="turn-label">First prompt</div>
          <pre className="turn-text">{card.firstPrompt}</pre>
        </div>
      )}
    </div>
  );
}

function PromptOnly({ id, row }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    getHistory(id)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <div className="session-pane glow-offline">
      <div className="s-head">
        <div className="s-title">{row?.title}</div>
        <div className="s-health">prompts only</div>
      </div>
      <div className="s-meta">
        <span>{row?.cwd}</span>
      </div>
      <p className="muted">
        Only the prompts survive, from Claude Code&apos;s prompt history (history.jsonl). The transcript with the replies was
        deleted before LayerCake saw this session, so there is nothing else to show.
      </p>
      {error && <div className="err-item">{error}</div>}
      {data?.prompts.map((p, i) => (
        <div key={`${p.at}-${i}`} className="turn-prompt">
          <div className="turn-label">{clock(p.at)}</div>
          <pre className="turn-text">{p.text}</pre>
        </div>
      ))}
    </div>
  );
}

/**
 * Puts this window on the left half, beside the terminal the server placed on
 * the right. Browsers allow this only for app-mode and popup windows; in a
 * normal tab it silently does nothing, which is fine.
 */
function dockLeft() {
  try {
    window.moveTo(0, 0);
    window.resizeTo(Math.floor(window.screen.availWidth / 2), window.screen.availHeight);
  } catch {
    /* not permitted here */
  }
}

const LAUNCH_POLL_MS = 2000;
const LAUNCH_WAIT_MS = 10 * 60 * 1000;

export default function SessionsView({ projectDir, scanId }) {
  const [scope, setScope] = useState(projectDir ? 'project' : 'all');
  const [launch, setLaunch] = useState(null);
  const [launchError, setLaunchError] = useState(null);
  const [list, setList] = useState(null);
  const [listError, setListError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [streamError, setStreamError] = useState(null);
  const [usage, setUsage] = useState(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState(null);
  const lastFetch = useRef(0);
  const pending = useRef(null);

  const dir = scope === 'project' ? projectDir : null;

  // Only the latest listing may land: a slow one for the previous scope would
  // otherwise replace the list the user just switched to.
  const listSeq = useRef(0);
  const loadList = useCallback(() => {
    const seq = ++listSeq.current;
    listSessions(dir)
      .then((l) => {
        if (seq !== listSeq.current) return;
        setList(l);
        setListError(null);
      })
      .catch((e) => {
        if (seq === listSeq.current) setListError(e.message);
      });
    getUsage()
      .then(setUsage)
      .catch(() => {});
  }, [dir]);

  useEffect(() => {
    loadList();
    const t = setInterval(loadList, LIST_REFRESH_MS);
    return () => clearInterval(t);
  }, [loadList]);

  // Land on the running session if there is one, else the most recent.
  useEffect(() => {
    if (!list || selected) return;
    const first = list.sessions.find((s) => s.live) || list.sessions[0];
    if (first) setSelected({ kind: 'session', id: first.sessionId });
  }, [list, selected]);

  // A launched session has no transcript until Claude Code writes its first
  // record, so poll quickly until it appears, then switch to it.
  useEffect(() => {
    if (!launch) return undefined;
    if (list?.sessions.some((s) => s.sessionId === launch.sessionId)) {
      setSelected({ kind: 'session', id: launch.sessionId });
      setLaunch(null);
      return undefined;
    }
    if (Date.now() - launch.at > LAUNCH_WAIT_MS) return undefined;
    const t = setTimeout(loadList, LAUNCH_POLL_MS);
    return () => clearTimeout(t);
  }, [launch, list, loadList]);

  const onLaunch = useCallback(async () => {
    setLaunchError(null);
    try {
      const r = await launchClaude(scanId);
      setLaunch({ ...r, at: Date.now() });
      dockLeft();
    } catch (e) {
      setLaunchError(e.message);
    }
  }, [scanId]);

  // Responses arrive in any order. One for a session that is no longer
  // selected (a slow session clicked before a fast one, a summary that
  // finished after the user moved on) must not paint over the current one.
  const currentId = useRef(null);
  currentId.current = selected?.kind === 'session' ? selected.id : null;

  const loadDetail = useCallback((id) => {
    lastFetch.current = Date.now();
    return getSession(id)
      .then((d) => {
        if (currentId.current !== id) return;
        setDetail(d);
        setDetailError(null);
      })
      .catch((e) => {
        if (currentId.current === id) setDetailError(e.message);
      });
  }, []);

  useEffect(() => {
    setDetail(null);
    setSummaryError(null);
    setStreamError(null);
    if (!selected || selected.kind !== 'session') return undefined;
    loadDetail(selected.id);
    // Follow it: the stream says when something moved, the detail says what.
    const stop = followSession(selected.id, {
      onUpdate: (u) => {
        setDetail((d) => (d && d.sessionId === selected.id ? { ...d, health: u.health } : d));
        const wait = DETAIL_THROTTLE_MS - (Date.now() - lastFetch.current);
        clearTimeout(pending.current);
        pending.current = setTimeout(() => loadDetail(selected.id), Math.max(0, wait));
      },
      onError: (m) => setStreamError(m),
    });
    return () => {
      stop();
      clearTimeout(pending.current);
    };
  }, [selected, loadDetail]);

  const onSummarize = useCallback(async () => {
    if (!detail) return;
    const id = detail.sessionId;
    setSummarizing(true);
    setSummaryError(null);
    try {
      await summarizeSession(id);
      if (currentId.current === id) await loadDetail(id);
    } catch (e) {
      if (currentId.current === id) setSummaryError(e.message);
    } finally {
      setSummarizing(false);
      getUsage().then(setUsage).catch(() => {});
    }
  }, [detail, loadDetail]);

  const onSelect = (kind, id) => setSelected({ kind, id });
  const rowFor = (kind, id) => (kind === 'expired' ? list?.expired : list?.promptOnly)?.find((s) => s.sessionId === id);

  return (
    <div className="sessions">
      <div className="s-list">
        <div className="s-scope">
          <button className={scope === 'project' ? 'active' : ''} disabled={!projectDir} onClick={() => { setScope('project'); setList(null); setSelected(null); }} title={projectDir || 'Scan a directory first'}>
            This project
          </button>
          <button className={scope === 'all' ? 'active' : ''} onClick={() => { setScope('all'); setList(null); setSelected(null); }}>
            All projects
          </button>
        </div>
        <div className="s-launch">
          <button className="btn btn-primary btn-small" onClick={onLaunch} disabled={!scanId || Boolean(launch)} title={projectDir ? `Open Claude Code in Windows Terminal in ${projectDir}` : 'Scan a directory first'}>
            Start Claude here
          </button>
          <span className="muted">
            Opens Claude Code in Windows Terminal beside this window, wired to report exact context, cost, limits and when
            it waits for you. Adds nothing to Claude&apos;s context.
          </span>
        </div>
        {launch && (
          <div className="launch-note">
            Claude Code is starting in Windows Terminal (tab &quot;Claude: {projectDir?.split(/[\\/]/).pop()}&quot;). It shows up here
            once it writes its first record, usually after your first prompt.
          </div>
        )}
        {launchError && <div className="err-item">{launchError}</div>}
        {listError && <div className="err-item">{listError}</div>}
        {!list && !listError && <div className="empty-state">Reading sessions…</div>}
        {list && (
          <>
            <Group title="Sessions" kind="session" items={list.sessions} selected={selected} onSelect={onSelect}
              note={`Full transcripts. Claude Code deletes them after ${list.retentionDays} days without activity.`} />
            <Group title="Kept after deletion" kind="expired" items={list.expired} selected={selected} onSelect={onSelect} />
            <Group title="Prompt history only" kind="promptOnly" items={list.promptOnly} selected={selected} onSelect={onSelect}
              note="Seen only in Claude Code's prompt history: prompts, no replies." />
            {!list.sessions.length && !list.expired.length && !list.promptOnly.length && (
              <div className="empty-state">No Claude Code sessions for {dir || 'any project'}.</div>
            )}
          </>
        )}
        {usage && (
          <div className="usage-note" title={`Kept in ${usage.dataRoot}`}>
            LayerCake&apos;s own Claude usage: {usage.totals.runs} AI summar{usage.totals.runs === 1 ? 'y' : 'ies'}
            {usage.totals.runs > 0 && `, ${tokens(usage.totals.inputTokens)} in, ${tokens(usage.totals.outputTokens)} out, ${usd(usage.totals.costUSD)}`}
            . Everything else here reads files and uses none.
          </div>
        )}
      </div>

      <div className="s-detail">
        {streamError && selected?.kind === 'session' && <div className="err-item">Live updates stopped: {streamError}</div>}
        {detailError && <div className="err-item">{detailError}</div>}
        {!selected && <div className="empty-state">Pick a session on the left.</div>}
        {selected?.kind === 'session' && !detail && !detailError && <div className="empty-state">Reading transcript…</div>}
        {selected?.kind === 'session' && detail && (
          <SessionDetail detail={detail} onSummarize={onSummarize} summarizing={summarizing} summaryError={summaryError} />
        )}
        {selected?.kind === 'expired' && rowFor('expired', selected.id) && <KeptCard card={rowFor('expired', selected.id)} />}
        {selected?.kind === 'promptOnly' && <PromptOnly id={selected.id} row={rowFor('promptOnly', selected.id)} />}
      </div>
    </div>
  );
}
