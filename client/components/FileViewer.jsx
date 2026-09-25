import React from 'react';
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

export default function FileViewer({ file, loading, onEdit, editableCategories }) {
  if (loading) return <div className="spinner">Reading…</div>;
  if (!file) return null;

  // The editable set comes from /api/manifest, which derives it from the guards
  // the server actually consults. Keeping a copy here would drift, and a stale
  // copy would either hide a legitimate Edit button or offer one that 403s.
  const editable =
    onEdit && (editableCategories || []).includes(file.category) && !file.truncated;

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
        </div>
      </div>
      <div className="viewer-body">
        <FileBody file={file} />
      </div>
    </>
  );
}
