import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { followSession, getHistory, getSession, getUsage, listCodexSessions, listSessions, startTerminal, summarizeSession } from '../api.js';
import { clock, daysUntil, inProject, pathKey, terminalIdentity, terminalTitle, tokens, toolLabel, usd, when } from '../sessionFormat.js';
import SessionDetail from './SessionDetail.jsx';
const TerminalPane = lazy(() => import('./TerminalPane.jsx'));

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
        <span>Claude Code</span>
        <span>{s.prompts} prompt{s.prompts === 1 ? '' : 's'}</span>
        {kind === 'session' && s.tools > 0 && <span>{s.tools} tools</span>}
        {kind === 'session' && s.errors > 0 && <span className="err">{s.errors} errors</span>}
        {s.quiet === 'restart' && <span className="muted" title="Launched from LayerCake, and no report from it since LayerCake restarted">no report since restart</span>}
        {s.quiet === 'silent' && <span className="muted" title="Launched from LayerCake; it stopped reporting with no prompt open, so it has most likely stopped">stopped reporting</span>}
        {s.quiet === 'blocked' && <span className="warn" title="Launched from LayerCake, but its status line and hooks never reported: trust, --safe-mode, disableAllHooks or a managed policy">never reported</span>}
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

function TerminalGroup({ title, items, selectedId, onSelect }) {
  if (!items.length) return null;
  return <section className="s-group" aria-label={title}>
    <div className="group-label">{title} <span className="s-count">{items.length}</span></div>
    {items.map((terminal) => (
      <button className={`s-row terminal-row${selectedId === terminal.id ? ' selected' : ''}`} key={terminal.id}
        aria-current={selectedId === terminal.id ? 'true' : undefined} title={terminal.cwd}
        onClick={() => onSelect('terminal', terminal.id)}>
        <div className="s-row-title">{terminalTitle(terminal)}</div>
        <div className="s-row-meta"><span>{terminalIdentity(terminal)}</span><span>{terminal.running ? 'Open' : 'Exited'}</span></div>
        <div className="s-row-path">{terminal.cwd}</div>
      </button>
    ))}
  </section>;
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

export default function SessionsView({ projectDir, scanId, initialTerminal, terminalRequest, onTerminalSelect, terminals, onTerminalUpdate }) {
  const [scopeOverride, setScope] = useState(null);
  const [filter, setFilter] = useState('all');
  const [opening, setOpening] = useState(false);
  const [launchError, setLaunchError] = useState(null);
  const [launchNote, setLaunchNote] = useState(null);
  const [external, setExternal] = useState(false);
  const [report, setReport] = useState(false);
  const [codex, setCodex] = useState(null);
  const [codexError, setCodexError] = useState(null);
  const [codexLoading, setCodexLoading] = useState(false);
  const [list, setList] = useState(null);
  const [listError, setListError] = useState(null);
  const [selected, setSelected] = useState(initialTerminal ? { kind: 'terminal', id: initialTerminal } : null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [streamError, setStreamError] = useState(null);
  const [usage, setUsage] = useState(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState(null);
  const lastFetch = useRef(0);
  const pending = useRef(null);

  const activeTerminal = selected?.kind === 'terminal' ? terminals?.find((t) => t.id === selected.id) : null;
  const scopeTerminal = activeTerminal || terminals?.find((t) => t.id === initialTerminal);
  const scope = scopeOverride ?? (projectDir && (!scopeTerminal || inProject(scopeTerminal.cwd, projectDir)) ? 'project' : 'all');
  const dir = scope === 'project' ? projectDir : null;
  const visibleTerminals = (terminals || []).filter((t) => (!dir || inProject(t.cwd, dir)) && (filter === 'all' || t.tool === filter));
  const openTerminals = visibleTerminals.filter((t) => t.running);
  const selection = useRef(selected);
  selection.current = selected;

  useEffect(() => {
    if (!terminalRequest) return;
    setScope(null);
    setFilter('all');
    setSelected({ kind: 'terminal', id: terminalRequest.id });
    onTerminalSelect(terminalRequest.id);
  }, [terminalRequest, onTerminalSelect]);

  const codexSequence = useRef(0);
  const codexScan = dir ? scanId : null;
  const loadCodex = useCallback(async (cursor) => {
    const seq = ++codexSequence.current;
    setCodexLoading(true);
    setCodexError(null);
    try {
      const result = await listCodexSessions(codexScan, cursor);
      if (seq !== codexSequence.current) return;
      setCodex((old) => cursor && old ? { ...result, sessions: [...old.sessions, ...result.sessions] } : result);
    } catch (err) {
      if (seq === codexSequence.current) setCodexError(err.message);
    } finally {
      if (seq === codexSequence.current) setCodexLoading(false);
    }
  }, [codexScan]);
  useEffect(() => {
    setCodex(null);
    if (filter !== 'claude') loadCodex();
    return () => { codexSequence.current += 1; };
  }, [loadCodex, filter]);

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

  const firstOpen = openTerminals[0]?.id;
  // Give an open terminal priority over the history list on entry.
  useEffect(() => {
    if (!terminals || selected || terminalRequest) return;
    if (firstOpen) {
      onTerminalSelect(firstOpen);
      setSelected({ kind: 'terminal', id: firstOpen });
      return;
    }
    if (!list || filter === 'codex') return;
    const first = list.sessions.find((s) => s.live) || list.sessions[0];
    if (first) setSelected({ kind: 'session', id: first.sessionId });
  }, [list, selected, filter, terminals, firstOpen, terminalRequest, onTerminalSelect]);

  const onLaunch = useCallback(async (tool, resume = null) => {
    const before = selection.current;
    setOpening(true);
    setLaunchError(null);
    setLaunchNote(null);
    try {
      const result = await startTerminal({ scanId, tool, resume, report, external });
      if (result.id) {
        onTerminalUpdate(result);
        if (selection.current === before) {
          setFilter((current) => current === tool ? current : 'all');
          onTerminalSelect(result.id);
          setSelected({ kind: 'terminal', id: result.id });
        }
      } else {
        setLaunchNote(`${toolLabel(tool)} opened in ${result.terminal === 'console' ? 'a console window' : 'Windows Terminal'}.`);
        dockLeft();
      }
    } catch (e) {
      setLaunchError(e.message);
    } finally {
      setOpening(false);
    }
  }, [scanId, report, external, onTerminalUpdate, onTerminalSelect]);

  // Responses arrive in any order. One for a session that is no longer
  // selected (a slow session clicked before a fast one, a summary that
  // finished after the user moved on) must not paint over the current one.
  const currentId = useRef(null);
  currentId.current = selected?.kind === 'session' ? selected.id : null;

  // Read through a ref so a new scan does not re-run the effect below and blank the detail.
  const scanRef = useRef(scanId);
  scanRef.current = scanId;

  const loadDetail = useCallback((id) => {
    lastFetch.current = Date.now();
    return getSession(id, scanRef.current)
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

  const onSelect = (kind, id) => {
    if (kind === 'terminal') {
      const terminal = terminals?.find((t) => t.id === id);
      if (terminal && dir && !inProject(terminal.cwd, dir)) setScope('all');
      onTerminalSelect(id);
    }
    setSelected({ kind, id });
  };
  const rowFor = (kind, id) => (kind === 'expired' ? list?.expired : list?.promptOnly)?.find((s) => s.sessionId === id);
  const codexSession = selected?.kind === 'codex' ? codex?.sessions.find((s) => s.sessionId === selected.id) : null;
  const openFor = (tool, id) => terminals?.find((t) => t.running && t.tool === tool && t.sessionId === id);
  const withoutOpen = (items, tool) => items?.filter((s) => !openTerminals.some((t) => t.tool === tool && t.sessionId === s.sessionId));
  const codexTerminal = codexSession && openFor('codex', codexSession.sessionId);
  const claudeTerminal = selected && ['session', 'expired', 'promptOnly'].includes(selected.kind) && openFor('claude', selected.id);
  const linkedId = activeTerminal?.sessionId;
  const historyKinds = activeTerminal?.tool === 'codex' ? [['codex', codex?.sessions]]
    : [['session', list?.sessions], ['expired', list?.expired], ['promptOnly', list?.promptOnly]];
  const linkedKind = linkedId && historyKinds.find(([, items]) => items?.some((s) => s.sessionId === linkedId))?.[0];
  const selectedTerminalId = (activeTerminal || claudeTerminal || codexTerminal)?.id;

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
        <div className="s-scope" aria-label="Filter sessions by tool">
          {['all', 'claude', 'codex'].map((tool) => (
            <button key={tool} className={filter === tool ? 'active' : ''} aria-pressed={filter === tool}
              onClick={() => { setFilter(tool); setSelected(null); }}>{tool === 'all' ? 'All tools' : toolLabel(tool)}</button>
          ))}
        </div>
        <div className="s-launch">
          <div className="terminal-actions">
            <button className="btn btn-small" onClick={() => onLaunch('claude')} disabled={!scanId || opening}>New Claude Code</button>
            <button className="btn btn-small" onClick={() => onLaunch('codex')} disabled={!scanId || opening || codexLoading}>New Codex</button>
          </div>
          <label><input type="checkbox" disabled={!scanId || opening} checked={external} onChange={(e) => setExternal(e.target.checked)} /> Open in Windows Terminal</label>
          <label><input type="checkbox" disabled={!scanId || opening || external} checked={report && !external} onChange={(e) => setReport(e.target.checked)} /> Share Codex activity with the Castle</label>
          {!scanId && <span className="muted">Scan a working directory to start or resume a session.</span>}
        </div>
        {launchNote && <div className="launch-note">{launchNote}</div>}
        {launchError && <div className="err-item">{launchError}</div>}
        <TerminalGroup title="Active sessions" items={openTerminals} selectedId={selectedTerminalId} onSelect={onSelect} />
        {filter !== 'claude' && <div className="s-group">
          <div className="group-label terminal-actions">Codex history
            <button className="btn btn-small" disabled={codexLoading} onClick={() => loadCodex()}>Refresh</button>
          </div>
          {codexError && <div className="s-group-note">{codexError}</div>}
          {codexLoading && <div className="s-group-note">Reading Codex history…</div>}
          {codex && !codex.sessions.length && <div className="s-group-note">No saved Codex chats on this page.</div>}
          {withoutOpen(codex?.sessions, 'codex')?.map((s) => (
            <button key={s.sessionId} className={`s-row${codexSession?.sessionId === s.sessionId ? ' selected' : ''}`}
              onClick={() => onSelect('codex', s.sessionId)}>
              <div className="s-row-title">{s.title || s.preview || terminalTitle(s)}</div>
              <div className="s-row-meta">Codex · {s.branch || s.sessionId.slice(0, 8)}</div>
              <div className="s-row-path">{s.cwd}</div>
            </button>
          ))}
          {codex?.nextCursor && <button className="btn btn-small" disabled={codexLoading} onClick={() => loadCodex(codex.nextCursor)}>More Codex chats</button>}
        </div>}
        {filter !== 'codex' && listError && <div className="err-item">{listError}</div>}
        {filter !== 'codex' && !list && !listError && <div className="empty-state">Reading Claude Code sessions…</div>}
        {filter !== 'codex' && list && (
          <>
            <Group title="Claude Code history" kind="session" items={withoutOpen(list.sessions, 'claude')} selected={selected} onSelect={onSelect}
              note={`Full transcripts. Claude Code deletes them after ${list.retentionDays} days without activity.`} />
            <Group title="Kept after deletion" kind="expired" items={withoutOpen(list.expired, 'claude')} selected={selected} onSelect={onSelect} />
            <Group title="Prompt history only" kind="promptOnly" items={withoutOpen(list.promptOnly, 'claude')} selected={selected} onSelect={onSelect}
              note="Seen only in Claude Code's prompt history: prompts, no replies." />
            {!list.sessions.length && !list.expired.length && !list.promptOnly.length && (
              <div className="empty-state">No Claude Code sessions for {dir || 'any project'}.</div>
            )}
          </>
        )}
        <TerminalGroup title="Exited terminals" items={visibleTerminals.filter((t) => !t.running)} selectedId={selectedTerminalId} onSelect={onSelect} />
        {usage && (
          <div className="usage-note" title={`Kept in ${usage.dataRoot}`}>
            LayerCake&apos;s own Claude usage: {usage.totals.runs} AI summar{usage.totals.runs === 1 ? 'y' : 'ies'}
            {usage.totals.runs > 0 && `, ${tokens(usage.totals.inputTokens)} in, ${tokens(usage.totals.outputTokens)} out, ${usd(usage.totals.costUSD)}`}
            {usage.totals.interrupted > 0 && (
              <span className="warn" title="LayerCake stopped during these runs, so their usage was never reported">
                {' '}({usage.totals.interrupted} interrupted, usage unknown)
              </span>
            )}
            . Everything else here reads files and uses none.
          </div>
        )}
      </div>

      <div className="s-detail">
        {selected?.kind === 'terminal' && (activeTerminal
          ? <Suspense fallback={<div className="empty-state">Opening terminal…</div>}>
              <TerminalPane key={activeTerminal.id} terminal={activeTerminal} onUpdate={onTerminalUpdate}
                historyLabel={linkedKind === 'session' ? 'View transcript' : 'Chat details'}
                onOpenHistory={linkedKind ? () => onSelect(linkedKind, linkedId) : null} />
            </Suspense>
          : <div className="empty-state">{terminals ? 'This terminal has closed. Choose a saved session to resume.' : 'Looking for the terminal…'}</div>)}
        {codexSession && <section className="terminal-head">
          <div>
            <h2>{codexSession.title || codexSession.preview || terminalTitle(codexSession)}</h2>
            <div>Codex · {codexSession.sessionId.slice(0, 8)}{codexSession.branch ? ` · ${codexSession.branch}` : ''}</div>
            <code>{codexSession.cwd}</code>
            {codexSession.preview && codexSession.title && <p>{codexSession.preview}</p>}
          </div>
          {codexTerminal
            ? <button className="btn btn-small" onClick={() => onSelect('terminal', codexTerminal.id)}>Open terminal</button>
            : <button className="btn btn-small" disabled={opening || codexLoading || !scanId || pathKey(codexSession.cwd) !== pathKey(projectDir || '')}
                onClick={() => onLaunch('codex', codexSession.sessionId)}>Resume in Codex</button>}
          {!codexTerminal && pathKey(codexSession.cwd) !== pathKey(projectDir || '') && <div className="muted">Scan this working directory to resume.</div>}
        </section>}
        {streamError && selected?.kind === 'session' && <div className="err-item">Live updates stopped: {streamError}</div>}
        {selected?.kind === 'session' && detailError && <div className="err-item">{detailError}</div>}
        {claudeTerminal && <button className="btn btn-small" onClick={() => onSelect('terminal', claudeTerminal.id)}>Open terminal</button>}
        {!selected && <div className="empty-state">Pick a session on the left.</div>}
        {selected?.kind === 'session' && !detail && !detailError && <div className="empty-state">Reading transcript…</div>}
        {selected?.kind === 'session' && detail && (
          <SessionDetail detail={detail} onSummarize={onSummarize} summarizing={summarizing} summaryError={summaryError}
            onResume={claudeTerminal ? null : () => onLaunch('claude', detail.sessionId)} resuming={opening ? { busy: true } : null} />
        )}
        {selected?.kind === 'expired' && rowFor('expired', selected.id) && <KeptCard card={rowFor('expired', selected.id)} />}
        {selected?.kind === 'promptOnly' && <PromptOnly id={selected.id} row={rowFor('promptOnly', selected.id)} />}
      </div>
    </div>
  );
}
