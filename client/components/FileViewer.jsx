import React, { useEffect, useState } from 'react';
import Markdown from 'react-markdown';

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function renderValue(value) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function Frontmatter({ data, raw, error }) {
  if (error) {
    return (
      <>
        <div className="notice warn">Frontmatter did not parse as YAML: {error}</div>
        <pre className="code">{raw}</pre>
      </>
    );
  }
  if (!data) return null;
  return (
    <table className="frontmatter">
      <tbody>
        {Object.entries(data).map(([key, value]) => (
          <tr key={key}>
            <td>{key}</td>
            <td>{renderValue(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FileBody({ file }) {
  if (file.error) {
    return (
      <div className="notice err">
        {file.error.code}: {file.error.message}
      </div>
    );
  }

  return (
    <>
      {file.sensitive && (
        <div className="notice warn">
          This file can contain tokens or machine-specific secrets. Shown because it is part of the
          config lineage. Take care before sharing a screenshot of it.
        </div>
      )}
      {file.truncated && (
        <div className="notice info">
          Truncated at {formatBytes(file.truncatedAt)} of {formatBytes(file.size)}. The file is read
          only up to this point.
        </div>
      )}
      {file.jsonError && (
        <div className="notice warn">
          JSON did not parse: {file.jsonError}. Showing the raw text below.
        </div>
      )}

      {file.kind === 'markdown' ? (
        <>
          <Frontmatter
            data={file.frontmatter}
            raw={file.frontmatterRaw}
            error={file.frontmatterError}
          />
          <div className="markdown">
            <Markdown>{file.body ?? file.content}</Markdown>
          </div>
        </>
      ) : file.kind === 'json' && file.parsed && !file.jsonError ? (
        <pre className="code">{JSON.stringify(file.parsed, null, 2)}</pre>
      ) : (
        <pre className="code">{file.content}</pre>
      )}
    </>
  );
}

/**
 * Delete, asked for twice: a button in the header, then a confirmation above
 * the body. Inline rather than a browser dialog, so it can say what happens to
 * the file and show a refusal (no snapshot could hold it, it changed on disk)
 * where it was asked for.
 */
function DeleteConfirm({ file, onDelete, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onDelete(file);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notice warn delete-confirm">
      Delete <code>{file.path}</code>? A snapshot is taken first, and the file can be restored from{' '}
      <strong>Snapshots</strong>. If that snapshot cannot hold it, nothing is deleted.
      <div className="create-row">
        <button className="btn btn-small btn-danger" onClick={go} disabled={busy}>
          {busy ? 'Deleting…' : 'Delete file'}
        </button>
        <button className="btn btn-small" onClick={onCancel} disabled={busy}>
          Keep it
        </button>
      </div>
      {error && <div className="notice err">{error}</div>}
    </div>
  );
}

function LoadedFile({ file, onEdit, onDelete, editableCategories }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [file.path]);

  // The editable set comes from /api/manifest, which derives it from the guards
  // the server actually consults. Keeping a copy here would drift, and a stale
  // copy would either hide a legitimate Edit button or offer one that 403s.
  const editable =
    onEdit && (editableCategories || []).includes(file.category) && !file.truncated;
  // Delete follows the same policy as edit. A truncated (oversized) file is
  // left to the server, which refuses it because no snapshot can hold it.
  const deletable = onDelete && (editableCategories || []).includes(file.category) && !file.error;

  return (
    <>
      <div className="viewer-head">
        <div className="viewer-path">{file.path}</div>
        <div className="viewer-meta">
          <span>{file.kind}</span>
          {file.size != null && <span>{formatBytes(file.size)}</span>}
          {file.mtime && <span>modified {new Date(file.mtime).toLocaleString()}</span>}
          {editable ? (
            <button className="btn btn-edit" onClick={onEdit}>
              Edit
            </button>
          ) : (
            <span style={{ color: 'var(--text-faint)' }}>
              {file.truncated ? 'too large to edit' : 'not editable'}
            </span>
          )}
          {deletable && !confirming && (
            <button className="btn btn-edit" onClick={() => setConfirming(true)}>
              Delete
            </button>
          )}
        </div>
      </div>
      <div className="viewer-body">
        {confirming && <DeleteConfirm file={file} onDelete={onDelete} onCancel={() => setConfirming(false)} />}
        <FileBody file={file} />
      </div>
    </>
  );
}

export default function FileViewer({ file, loading, onEdit, onDelete, editableCategories }) {
  if (loading) return <div className="spinner">Reading…</div>;
  if (!file) return null;
  return <LoadedFile file={file} onEdit={onEdit} onDelete={onDelete} editableCategories={editableCategories} />;
}
