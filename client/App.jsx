import React, { useCallback, useEffect, useState } from 'react';

import { getManifest, getSession, listSessions, readFile, scan } from './api.js';
import useWatch from './useWatch.js';
import { pathKey } from './sessionFormat.js';
import LineageTree from './components/LineageTree.jsx';
import FileViewer from './components/FileViewer.jsx';
import FlattenView from './components/FlattenView.jsx';
import FileEditor from './components/FileEditor.jsx';
import SnapshotPanel from './components/SnapshotPanel.jsx';
import SessionsView from './components/SessionsView.jsx';
import WatchBanner from './components/WatchBanner.jsx';

/**
 * Which memory files the project's current session actually loaded, for the
 * Explorer overlay. "Current" is a running session whose working directory is
 * the scanned one, else the most recent session there. Null when there is none.
 */
async function loadOverlay(projectDir) {
  const list = await listSessions(projectDir);
  const here = list.sessions.filter((s) => pathKey(s.cwd) === pathKey(projectDir));
  const current = here.find((s) => s.live) || here[0];
  if (!current) return null;
  const detail = await getSession(current.sessionId);
  const byKey = new Map();
  for (const i of detail.instructions) {
    const k = pathKey(i.path);
    if (!byKey.has(k)) byKey.set(k, i.reason);
  }
  return {
    sessionId: current.sessionId,
    title: current.title,
    live: current.live,
    version: detail.version,
    // No record is not the same as "nothing loaded": Claude Code writes the
    // instruction record only from about 2.1.265, and 28 of 44 real sessions
    // predate it. Badges appear only when the session recorded its loads.
    recorded: detail.instructions.length > 0,
    byKey,
    instructions: detail.instructions,
  };
}

// Persisted in the browser, never on disk: the server writes only config edits
// (snapshot first) and its own data store, and UI preferences belong in neither.
// Keys keep the old product name on purpose. Renaming them would silently drop
// the remembered directory and recent list on first launch after the rename,
// which is a worse trade than an inconsistent string nobody sees.
const LAST_KEY = 'claude-explorer.lastDir';
const RECENT_KEY = 'claude-explorer.recentDirs';
const MAX_RECENT = 6;

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [dir, setDir] = useState(() => localStorage.getItem(LAST_KEY) || '');
  const [recent, setRecent] = useState(loadRecent);
  const [lineage, setLineage] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [mode, setMode] = useState('explorer');
  const [selected, setSelected] = useState(null);
  const [file, setFile] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  // Lifted out of FileEditor so the watch banner can warn before a re-scan
  // discards a draft. The editor still owns the text.
  const [editorDirty, setEditorDirty] = useState(false);
  // The write policy is served, never assumed, so the UI and the guards cannot
  // disagree about what is editable.
  const [policy, setPolicy] = useState(null);
  const [overlay, setOverlay] = useState(null);

  // Live filesystem events for the current scan. Reports only: re-scanning is
  // the user's call, because it replaces the lineage under whatever is open.
  const {
    changes: watchChanges,
    ready: watchReady,
    error: watchError,
    clear: clearWatch,
    suppress: suppressWatch,
    notify,
    notifySupported,
    enableNotifications,
    disableNotifications,
  } = useWatch(lineage?.scanId);

  useEffect(() => {
    getManifest()
      .then((m) => setPolicy(m.write))
      .catch(() => setPolicy(null));
  }, []);

  const runScan = useCallback(
    async (target) => {
      const value = (target ?? dir).trim();
      if (!value) return;
      setScanning(true);
      setScanError(null);
      setFile(null);
      setSelected(null);
      try {
        const result = await scan(value);
        setLineage(result);
        setDir(result.projectDir);
        localStorage.setItem(LAST_KEY, result.projectDir);
        setRecent((prev) => {
          const next = [result.projectDir, ...prev.filter((p) => p !== result.projectDir)].slice(
            0,
            MAX_RECENT
          );
          localStorage.setItem(RECENT_KEY, JSON.stringify(next));
          return next;
        });
      } catch (err) {
        setScanError(err.message);
        setLineage(null);
      } finally {
        setScanning(false);
      }
    },
    [dir]
  );

  // The overlay is a convenience on the Explorer, so a failure to read sessions
  // simply leaves it off rather than raising an error over the lineage.
  useEffect(() => {
    let alive = true;
    setOverlay(null);
    if (!lineage?.projectDir) return undefined;
    loadOverlay(lineage.projectDir)
      .then((o) => alive && setOverlay(o))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [lineage]);

  // Scan the remembered directory once on load, so a reopened tab lands ready.
  useEffect(() => {
    const last = localStorage.getItem(LAST_KEY);
    if (last) runScan(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelect = useCallback(
    async (entry) => {
      setSelected(entry.absPath);
      setMode('explorer');
      setEditing(false);
      setFileLoading(true);
      try {
        const result = await readFile(lineage.scanId, entry.absPath);
        // category comes from the scan entry, not the file read: the editor
        // needs it to know whether this is executable content, and the server
        // makes the same distinction from the same source.
        setFile({ ...result, category: entry.category });
      } catch (err) {
        setFile({ path: entry.absPath, kind: 'text', error: { code: 'EREQ', message: err.message } });
      } finally {
        setFileLoading(false);
      }
    },
    [lineage]
  );

  // After a save the file on disk has a new mtime. Re-reading keeps the next
  // save's conflict check honest instead of comparing against a stale value.
  const reloadSelected = useCallback(async () => {
    if (!lineage || !selected) return;
    const entry = lineage.levels
      .flatMap((l) => l.entries)
      .find((e) => e.absPath === selected);
    const result = await readFile(lineage.scanId, selected);
    setFile({ ...result, category: entry?.category });
  }, [lineage, selected]);

  // LayerCake's own writes are filesystem changes like any other, so they would
  // announce themselves in the banner. Suppressing them keeps it a report of
  // what happened OUTSIDE this window, which is the only part the user cannot
  // already see on screen.
  const onFileSaved = useCallback(async () => {
    if (selected) suppressWatch([selected]);
    await reloadSelected();
  }, [selected, suppressWatch, reloadSelected]);

  const onRestored = useCallback(
    async (res) => {
      if (res?.restored?.length) suppressWatch(res.restored);
      await reloadSelected();
    },
    [suppressWatch, reloadSelected]
  );

  const rescanCurrent = useCallback(() => {
    clearWatch();
    runScan(lineage?.projectDir || dir);
  }, [clearWatch, runScan, lineage, dir]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          Layer<span>Cake</span>
        </div>

        <form
          className="path-form"
          onSubmit={(e) => {
            e.preventDefault();
            runScan();
          }}
        >
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="C:\dev\my-project"
            spellCheck={false}
            autoComplete="off"
          />
          <button className="btn btn-primary" type="submit" disabled={scanning || !dir.trim()}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </form>

        <div className="modes">
          <button
            className={mode === 'explorer' ? 'active' : ''}
            onClick={() => setMode('explorer')}
          >
            Explorer
          </button>
          <button
            className={mode === 'flat' ? 'active' : ''}
            onClick={() => setMode('flat')}
            disabled={!lineage}
          >
            Flattened
          </button>
          <button
            className={mode === 'snapshots' ? 'active' : ''}
            onClick={() => setMode('snapshots')}
            disabled={!lineage}
          >
            Snapshots
          </button>
          <button className={mode === 'sessions' ? 'active' : ''} onClick={() => setMode('sessions')}>
            Sessions
          </button>
        </div>

        {recent.length > 1 && (
          <div className="recent">
            <span className="recent-label">recent</span>
            {recent.slice(1).map((p) => (
              <button key={p} className="chip" onClick={() => runScan(p)} title={p}>
                {p}
              </button>
            ))}
          </div>
        )}
      </header>

      {scanError && <div className="error-banner">{scanError}</div>}

      {lineage && (
        <WatchBanner
          changes={watchChanges}
          ready={watchReady}
          error={watchError}
          editorDirty={editing && editorDirty}
          onRescan={rescanCurrent}
          onDismiss={clearWatch}
          notify={notify}
          notifySupported={notifySupported}
          onEnableNotifications={enableNotifications}
          onDisableNotifications={disableNotifications}
        />
      )}

      {mode === 'sessions' ? (
        <div className="panes single">
          <SessionsView key={lineage?.projectDir || 'none'} projectDir={lineage?.projectDir || null} scanId={lineage?.scanId || null} />
        </div>
      ) : (
      <div className="panes">
        <div className="pane-left">
          {lineage ? (
            <LineageTree lineage={lineage} selectedPath={selected} onSelect={onSelect} overlay={overlay} />
          ) : (
            <div className="empty-state">
              {scanning ? 'Scanning…' : 'Enter a project directory and press Scan.'}
            </div>
          )}
        </div>

        <div className="pane-right">
          {mode === 'snapshots' && lineage ? (
            <SnapshotPanel scanId={lineage.scanId} onRestored={onRestored} />
          ) : mode === 'flat' && lineage ? (
            <FlattenView scanId={lineage.scanId} />
          ) : editing && file && !file.error ? (
            <>
              <div className="viewer-head">
                <div className="viewer-path">{file.path}</div>
                <div className="viewer-meta">
                  <span>editing</span>
                  <span>{file.category}</span>
                </div>
              </div>
              <div className="viewer-body">
                <FileEditor
                  file={file}
                  scanId={lineage.scanId}
                  onSaved={onFileSaved}
                  onDirtyChange={setEditorDirty}
                  onCancel={() => setEditing(false)}
                />
              </div>
            </>
          ) : file || fileLoading ? (
            <FileViewer
              file={file}
              loading={fileLoading}
              editableCategories={policy?.editableCategories}
              onEdit={file && !file.error ? () => setEditing(true) : null}
            />
          ) : (
            <div className="empty-state">
              <p>
                Select a file on the left to read or edit it, switch to <strong>Flattened</strong>{' '}
                to see the whole chain concatenated in precedence order, or open{' '}
                <strong>Snapshots</strong> to back up and restore.
              </p>
              <p>
                Levels are numbered <code>00</code> (weakest, managed settings) downward to the
                project directory (strongest). Levels where nothing was found are still listed and
                grayed out, and each one can be expanded to show exactly which paths were probed and
                came back empty.
              </p>
              <p>
                Editing writes to the real file, so every save takes a snapshot first and lands
                atomically. Credential files are excluded from the scan entirely and can be neither
                opened nor written. Claude Code loads memory and settings at session start, so a
                session already running will not see a change until it restarts.
              </p>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
