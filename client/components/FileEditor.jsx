import React, { useEffect, useState } from 'react';

import { writeFile } from '../api.js';

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

  // A different file selected while the editor is open must not inherit the
  // previous file's draft, which would write one file's contents into another.
  useEffect(() => {
    setDraft(file.content ?? '');
    setError(null);
    setResult(null);
    setAcknowledge(false);
  }, [file.path, file.content]);

  const dirty = draft !== (file.content ?? '');
  const isExecutable = file.category === 'hook';

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

      <textarea
        className="editor-area"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        wrap="off"
      />

      <div className="editor-bar">
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={saving || !dirty || (isExecutable && !acknowledge)}
        >
          {saving ? 'Saving…' : 'Save'}
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
