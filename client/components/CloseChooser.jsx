import React, { useEffect, useState } from 'react';

import { answerClosing, getClosing } from '../api.js';
import { terminalIdentity, terminalTitle } from '../sessionFormat.js';
import { tabColor } from './SessionTabs.jsx';

/**
 * Asked in a small window of its own after LayerCake's last window closes with
 * embedded sessions still running (#205). The executable is still up behind
 * it and waits for the answer. A kept session is not carried across: its
 * embedded process ends and the same chat is resumed in Windows Terminal, so
 * each row says what that costs for the state the session is in.
 *
 * Closing this window without answering is not an answer: the sessions marked
 * Keep on their tabs are kept and the rest end, which is also what happens
 * once "Don't ask again" is ticked.
 */
const COST = {
  waiting: 'Waiting on a prompt. The prompt is dropped; the chat is kept.',
  working: 'Working. The step in progress is cut off; the chat is kept.',
  idle: 'Idle. Moves cleanly.',
  unknown: 'Not reporting, so its state is not known. Anything in progress is cut off; the chat is kept.',
};

export default function CloseChooser() {
  const [sessions, setSessions] = useState(null);
  const [keep, setKeep] = useState(() => new Set());
  const [dontAsk, setDontAsk] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);

  useEffect(() => {
    document.title = 'LayerCake is closing';
    getClosing()
      .then((closing) => {
        setSessions(closing.sessions);
        // Pre-ticked from the Keep marks on the tabs, where a session can be kept at all.
        setKeep(new Set(closing.sessions.filter((s) => s.keep && !s.refusal).map((s) => s.id)));
      })
      .catch((err) => setError(err.message));
  }, []);

  const toggle = (id) => setKeep((old) => {
    const next = new Set(old);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  async function answer(body, done) {
    setError(null);
    try {
      await answerClosing(body);
      setSent(done);
      if (body.cancel) {
        // Back to LayerCake in this same window, at a usable size.
        try { window.resizeTo(Math.min(1500, window.screen.availWidth), Math.min(950, window.screen.availHeight)); } catch { /* not an app window */ }
        window.location.replace('/');
      } else {
        window.close();
      }
    } catch (err) {
      setError(err.message);
    }
  }

  // The window closes itself where the browser lets a page do that; where it does not, say so.
  if (sent) return <div className="close-chooser"><p>{sent}</p><p className="muted">You can close this window.</p></div>;
  const count = keep.size;
  return (
    <div className="close-chooser">
      <h1>{sessions ? `${sessions.length} session${sessions.length === 1 ? ' is' : 's are'} still running in LayerCake` : 'LayerCake is closing'}</h1>
      <p className="muted">
        Ticked sessions reopen in Windows Terminal and carry on from their saved chat. The rest end.
        Either way the chats stay in History.
      </p>
      {error && <div className="err-item" role="alert">{error}</div>}
      {!sessions && !error && <div className="empty-state">Reading the open sessions…</div>}
      <ul className="close-list">
        {sessions?.map((s) => {
          const state = s.activity?.state || 'unknown';
          return (
            <li key={s.id} style={{ '--tab': tabColor(s) }}>
              <label className={s.refusal ? 'is-refused' : ''}>
                <input type="checkbox" id={`keep-${s.id}`} disabled={Boolean(s.refusal)} checked={keep.has(s.id)} onChange={() => toggle(s.id)} />
                <span>
                  <span className="close-name"><span className={`tab-dot st-${state}`} aria-hidden="true" /><strong>{terminalTitle(s)}</strong></span>
                  <span className="close-sub">{terminalIdentity(s)} · <code>{s.cwd}</code></span>
                  <span className="close-cost">{s.refusal ? `Cannot be kept: ${s.refusal}` : COST[state]}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <label className="close-dontask">
        <input type="checkbox" id="close-dontask" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        <span>Don&apos;t ask again. From then on, closing keeps the sessions marked <strong>Keep</strong> on their tabs and ends the rest. Turn this question back on from the History tab.</span>
      </label>
      <div className="close-actions">
        <button className="btn" onClick={() => answer({ cancel: true }, 'Opening LayerCake…')}>Back to LayerCake</button>
        <button className="btn" disabled={!sessions} onClick={() => answer({ keep: [], dontAsk }, 'Ending the sessions…')}>End all and close</button>
        <button className="btn btn-primary" disabled={!sessions || !count} onClick={() => answer({ keep: [...keep], dontAsk }, `Moving ${count} session${count === 1 ? '' : 's'} to Windows Terminal…`)}>
          Keep {count || ''} and close
        </button>
      </div>
    </div>
  );
}
