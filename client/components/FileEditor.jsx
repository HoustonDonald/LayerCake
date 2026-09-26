import React, { useEffect, useRef, useState } from 'react';

import { readFile, writeFile } from '../api.js';
import DiffView from './DiffView.jsx';

/**
 * A browser text box turns every line break into LF (a lone CR too), so the
 * draft never holds a CR. The draft starts from the body in this form, which
 * keeps "unsaved changes" and the review diff about the text rather than about
 * line endings: against the raw body, every line of a CRLF file would count as
 * changed and bury the actual edit.
 */
function asTextBoxShowsIt(text) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * The line ending Save writes, decided from the file as it was loaded, because
 * the text box cannot remember it. Without this, saving a CRLF file (any repo
 * checked out with core.autocrlf=true) quietly rewrote every line of it as LF
 * (#51).
 *
 * A file that mixes the two gets the one it uses more. That keeps the file's
 * own convention when a tool has appended a few lines in the other one. A tie,
 * like a file with no line break at all, gets LF, the text box's own. The
 * editor states this rule on screen for any mixed file, since a save then
 * changes the minority lines too. A lone CR (classic Mac OS) is not counted;
 * the text box already made it a line break, and it is saved as the chosen one.
 */
function lineEndingOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return { eol: crlf > lf ? '\r\n' : '\n', crlf, lf, mixed: crlf > 0 && lf > 0 };
}

function withLineEnding(text, eol) {
  return text.replace(/\r\n|\r|\n/g, eol);
}

/**
 * Edit surface for one file.
 *
 * A plain textarea rather than a code editor component. These are small config
 * and prose files, the project keeps its dependency list deliberately tiny, and
 * a syntax highlighter would be the largest dependency in the tree by an order
 * of magnitude. Validation happens server side on save, which is where it has
 * to happen anyway.
 */
export default function FileEditor({ file, scanId, onSaved, onCancel, onDirtyChange }) {
  const [draft, setDraft] = useState(() => asTextBoxShowsIt(file.content ?? ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // What the disk said when the review opened: checking, current, changed, or error.
  const [disk, setDisk] = useState(null);
  // What this editor last wrote, and where, so the reload that follows its own
  // save can be told apart from any other change to the file.
  const ownSave = useRef(null);

  // A different file selected while the editor is open must not inherit the
  // previous file's draft, which would write one file's contents into another.
  useEffect(() => {
    const ours = ownSave.current;
    ownSave.current = null;
    setDraft(asTextBoxShowsIt(file.content ?? ''));
    setError(null);
    // App re-reads the file after every save so the next conflict check uses
    // the new mtime, and that reload changes file.content. Clearing the result
    // on it hid the undo snapshot id, the restart notice and any validation
    // warning a moment after they appeared (#50). The reload is recognised by
    // carrying exactly what was written; anything else still clears it.
    if (!(ours && ours.path === file.path && ours.content === file.content)) setResult(null);
    setAcknowledge(false);
    setReviewing(false);
  }, [file.path, file.content]);

  // The diff is against the body loaded when the editor opened, and that is
  // what Save replaces only if nothing else has written the file since. The
  // server refuses the save in that case by comparing mtimes, so the review
  // makes the same comparison first, through the same /api/file read, rather
  // than drawing a diff against a version that is no longer on disk.
  useEffect(() => {
    if (!reviewing) return undefined;
    let alive = true;
    setDisk({ state: 'checking' });
    readFile(scanId, file.path)
      .then((now) => {
        if (!alive) return;
        if (now.error) setDisk({ state: 'error', message: `${now.error.code}: ${now.error.message}` });
        else if (file.mtime && now.mtime !== file.mtime) setDisk({ state: 'changed', mtime: now.mtime });
        else setDisk({ state: 'current' });
      })
      .catch((err) => alive && setDisk({ state: 'error', message: err.message }));
    return () => {
      alive = false;
    };
  }, [reviewing, scanId, file.path, file.mtime]);

  const loaded = asTextBoxShowsIt(file.content ?? '');
  const dirty = draft !== loaded;
  const isExecutable = file.category === 'hook';
  const endings = lineEndingOf(file.content ?? '');

  // Echoed upward so the "changed on disk" banner can warn before a re-scan
  // throws the draft away. The editor still owns the state; this is a read-only
  // report, and the unmount pass clears it so a closed editor is never dirty.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  async function save() {
    setSaving(true);
    setError(null);
    setResult(null);
    const content = withLineEnding(draft, endings.eol);
    try {
      const res = await writeFile({
        scanId,
        path: file.path,
        content,
        // Sent so the server can refuse if something else changed the file
        // since it was opened here. The common case is the same file open in
        // an editor, not a second person.
        expectedMtime: file.mtime || null,
        acknowledgeExecutable: acknowledge,
      });
      ownSave.current = { path: file.path, content };
      setResult(res);
      onSaved?.(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (file.truncated) {
    return (
      <div className="notice err">
        This file was truncated for display, so it cannot be edited here. Saving would discard
        everything past the truncation point.
      </div>
    );
  }

  return (
    <div className="editor">
      {isExecutable && (
        <div className="notice warn">
          <strong>This file is executed by Claude Code, not just read.</strong> A change here runs on
          your machine the next time the hook fires.
          <label className="ack">
            <input
              type="checkbox"
              checked={acknowledge}
              onChange={(e) => setAcknowledge(e.target.checked)}
            />
            I understand, allow saving this hook
          </label>
        </div>
      )}

      {file.sensitive && (
        <div className="notice warn">
          This file can hold tokens or machine-specific values. Check what you are about to save.
        </div>
      )}

      {endings.mixed && (
        <div className="notice info">
          This file mixes line endings: {endings.crlf} CRLF and {endings.lf} LF. Save writes every
          line break as {endings.eol === '\r\n' ? 'CRLF' : 'LF'}, the ending the file uses more (a
          tie goes to LF), so the {endings.eol === '\r\n' ? 'LF' : 'CRLF'} lines change too. The
          review diff leaves line endings out.
        </div>
      )}

      {reviewing ? (
        <div className="editor-review">
          {disk?.state === 'checking' && <div className="spinner">Checking the file on disk…</div>}
          {disk?.state === 'changed' && (
            <div className="notice err">
              This file changed on disk since you opened it here (now modified{' '}
              {new Date(disk.mtime).toLocaleString()}). A diff against the version you loaded would
              not show what Save replaces, and Save will be refused. Go back to editing to copy your
              text, then reopen the file and reapply the edit.
            </div>
          )}
          {disk?.state === 'error' && (
            <div className="notice err">
              Could not re-read the file to check it is unchanged, so no diff is shown: {disk.message}
            </div>
          )}
          {disk?.state === 'current' && (
            <>
              {endings.crlf > 0 && !endings.mixed && (
                <div className="notice info">
                  This file has CRLF line endings, and Save keeps them. A browser text box shows
                  every line break as LF, so the diff below compares lines without their endings.
                </div>
              )}
              <DiffView before={loaded} after={draft} />
            </>
          )}
        </div>
      ) : (
        <textarea
          className="editor-area"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          wrap="off"
        />
      )}

      <div className="editor-bar">
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={saving || !dirty || (isExecutable && !acknowledge)}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="btn"
          onClick={() => {
            // Cleared on every toggle so a reopened review never shows the
            // previous check's verdict while the new one is in flight.
            setDisk(null);
            setReviewing((r) => !r);
          }}
          disabled={saving || (!dirty && !reviewing)}
        >
          {reviewing ? 'Back to editing' : 'Review changes'}
        </button>
        <button className="btn" onClick={onCancel} disabled={saving}>
          {dirty ? 'Discard changes' : 'Close editor'}
        </button>
        <span className="editor-hint">
          {dirty ? 'Unsaved changes' : 'No changes'} · a snapshot is taken automatically before every
          save
        </span>
      </div>

      {error && <div className="notice err">{error}</div>}

      {result && (
        <div className="notice ok">
          <div>
            Saved. Undo snapshot <code>{result.undoSnapshotId}</code> holds the previous version.
          </div>
          {result.notice && <div className="notice-sub">{result.notice}</div>}
          {result.warnings?.map((w) => (
            <div key={w} className="notice-sub warn-text">
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
