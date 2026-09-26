import React, { useCallback, useEffect, useRef, useState } from 'react';

import { followSession, getHistory, getSession, getUsage, listSessions, summarizeSession } from '../api.js';
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

export default function SessionsView({ projectDir }) {
  const [scope, setScope] = useState(projectDir ? 'project' : 'all');
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

  const loadList = useCallback(() => {
    listSessions(dir)
      .then((l) => {
        setList(l);
        setListError(null);
      })
      .catch((e) => setListError(e.message));
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

  const loadDetail = useCallback((id) => {
    lastFetch.current = Date.now();
    return getSession(id)
      .then((d) => {
        setDetail(d);
        setDetailError(null);
      })
      .catch((e) => setDetailError(e.message));
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
    setSummarizing(true);
    setSummaryError(null);
    try {
      await summarizeSession(detail.sessionId);
      await loadDetail(detail.sessionId);
    } catch (e) {
      setSummaryError(e.message);
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
