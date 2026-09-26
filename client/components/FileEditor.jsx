import React, { useEffect, useState } from 'react';

import { readFile, writeFile } from '../api.js';
import DiffView from './DiffView.jsx';

/**
 * A browser text box turns every line break into LF, so after the first
 * keystroke the draft holds no CR at all and Save writes LF. Diffing against
 * the raw body would mark every line of a CRLF file as changed and bury the
 * actual edit, so the review compares against the body as the text box shows
 * it and says separately that the line endings change.
 */
function asTextBoxShowsIt(text) {
  return text.replace(/\r\n?/g, '\n');
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
  const [draft, setDraft] = useState(file.content ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // What the disk said when the review opened: checking, current, changed, or error.
  const [disk, setDisk] = useState(null);

  // A different file selected while the editor is open must not inherit the
  // previous file's draft, which would write one file's contents into another.
  useEffect(() => {
    setDraft(file.content ?? '');
    setError(null);
    setResult(null);
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

  const loaded = file.content ?? '';
  const dirty = draft !== loaded;
  const isExecutable = file.category === 'hook';
  const lineEndingsChange = /\r/.test(loaded) && !/\r/.test(draft);

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
    try {
      const res = await writeFile({
        scanId,
        path: file.path,
        content: draft,
        // Sent so the server can refuse if something else changed the file
        // since it was opened here. The common case is the same file open in
        // an editor, not a second person.
        expectedMtime: file.mtime || null,
        acknowledgeExecutable: acknowledge,
      });
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
              {lineEndingsChange && (
                <div className="notice info">
                  This file has CRLF line endings and Save writes LF, because a browser text box
                  turns every line break into LF. The diff below leaves that difference out so the
                  edit itself is visible.
                </div>
              )}
              <DiffView before={asTextBoxShowsIt(loaded)} after={draft} />
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
