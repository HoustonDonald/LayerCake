import React, { useCallback, useEffect, useState } from 'react';

import { createFile, deleteFile, getManifest, getPrefs, getSession, listSessions, readFile, savePrefs, scan } from './api.js';
import useWatch from './useWatch.js';
import { pathKey } from './sessionFormat.js';

/**
 * A snapshot id (its UTC creation time, 2026-09-28T00-32-29-981Z) as local
 * time, the way the snapshot list shows it; the id itself if it is not one.
 */
function snapshotTime(id) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(String(id));
  if (!m) return String(id);
  const t = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t.getTime()) ? String(id) : t.toLocaleString();
}

/**
 * A file read, plus what its scan entry says about it. The category comes from
 * the entry, not the read: the editor needs it to know whether this is
 * executable content, and the server makes the same distinction from the same
 * source. The note (why a file is not read, or the link it is reached through,
 * #144) and why it is read only (#126) are said where the file is opened.
 */
function withEntry(result, entry) {
  return { ...result, category: entry?.category, note: entry?.note || null, readOnly: entry?.readOnly || null };
}
import LineageTree from './components/LineageTree.jsx';
import FileViewer from './components/FileViewer.jsx';
import FlattenView from './components/FlattenView.jsx';
import FileEditor from './components/FileEditor.jsx';
import SnapshotPanel from './components/SnapshotPanel.jsx';
import SessionsView from './components/SessionsView.jsx';
import CastleView from './components/CastleView.jsx';
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

// The last and recent folders are kept in LayerCake's own data folder (#198,
// /api/prefs): each run is a new browser origin (a new port), so the browser's
// storage starts empty every time.
const MAX_RECENT = 6;

export default function App() {
  const [dir, setDir] = useState('');
  const [recent, setRecent] = useState([]);
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
  // The outcome of a create or delete, kept on screen after the rescan that
  // follows it (which clears the selection), with the undo snapshot id.
  const [flash, setFlash] = useState(null);

  // Live filesystem events for the current scan. Reports only: re-scanning is
  // the user's call, because it replaces the lineage under whatever is open.
  const {
    changes: watchChanges,
    ready: watchReady,
    error: watchError,
    clear: clearWatch,
    suppress: suppressWatch,
    notify,
    notifyError,
    notifySupported,
    enableNotifications,
    disableNotifications,
    mute: watchMute,
  } = useWatch(lineage?.scanId, lineage?.platform);

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
        // The box takes the scanned folder's own spelling, unless it was edited
        // while the scan ran: the scan on load is not the user's, and replacing
        // what they typed meanwhile submitted a path nobody typed (#180).
        setDir((cur) => (cur.trim() === value ? result.projectDir : cur));
        setRecent((prev) => {
          const next = [result.projectDir, ...prev.filter((p) => p !== result.projectDir)].slice(
            0,
            MAX_RECENT
          );
          // Idempotent, so React running this updater twice costs a repeat only.
          savePrefs({ lastDir: result.projectDir, recent: next }).catch(() => {});
          return next;
        });
        return result;
      } catch (err) {
        setScanError(err.message);
        setLineage(null);
        return null;
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

  // Scan the remembered directory once on load, so a reopened window lands
  // ready. The box takes it only if nothing was typed while it loaded (#180).
  useEffect(() => {
    let alive = true;
    getPrefs()
      .then((p) => {
        if (!alive) return;
        if (Array.isArray(p.recent)) setRecent(p.recent.slice(0, MAX_RECENT));
        if (p.lastDir) {
          setDir((cur) => cur || p.lastDir);
          runScan(p.lastDir);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the editor unmounts it, and the draft lives only there, so every
  // way out asks first while there are unsaved changes: another view, another
  // file, another scan (#52). The watch banner's Rescan asks in its own bar.
  // Asking was chosen over keeping the draft for later: a kept draft would have
  // to be matched back to its file after a rescan or a save elsewhere, which is
  // the same stale-draft risk the editor's reset exists to prevent.
  const leaveEditorOk = useCallback(
    () =>
      !(editing && editorDirty) ||
      window.confirm(
        `You have unsaved changes to ${file?.path}.\n\nOK discards them and leaves the editor. Cancel keeps editing.`
      ),
    [editing, editorDirty, file]
  );

  // Closing the window, or reloading it, with unsaved editor changes asks
  // first, through the browser's own prompt (#71; owner decision 11). Only
  // while the draft is dirty: the exe's window then stays open, and the exe
  // running, until the prompt is answered, which no one should meet for nothing.
  useEffect(() => {
    if (!(editing && editorDirty)) return undefined;
    const ask = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [editing, editorDirty]);

  const switchMode = (next) => {
    if (next !== mode && leaveEditorOk()) setMode(next);
  };

  // Takes the scan id rather than reading lineage, so a file can be opened in
  // a scan that has only just replaced the one this render closed over.
  const loadEntry = useCallback(async (scanId, entry, { edit = false } = {}) => {
    setSelected(entry.absPath);
    setMode('explorer');
    setEditing(false);
    setFileLoading(true);
    try {
      const result = await readFile(scanId, entry.absPath);
      setFile(withEntry(result, entry));
      if (edit && !result.error) setEditing(true);
    } catch (err) {
      setFile({ path: entry.absPath, kind: 'text', error: { code: 'EREQ', message: err.message } });
    } finally {
      setFileLoading(false);
    }
  }, []);

  const onSelect = useCallback(
    async (entry) => {
      if (!leaveEditorOk()) return;
      setFlash(null);
      await loadEntry(lineage.scanId, entry);
    },
    [lineage, leaveEditorOk, loadEntry]
  );

  // After a save the file on disk has a new mtime. Re-reading keeps the next
  // save's conflict check honest instead of comparing against a stale value.
  const reloadSelected = useCallback(async () => {
    if (!lineage || !selected) return;
    const entry = lineage.levels
      .flatMap((l) => l.entries)
      .find((e) => e.absPath === selected);
    const result = await readFile(lineage.scanId, selected);
    setFile(withEntry(result, entry));
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
      // A "Deleted ... restore it from Snapshots" banner is done once that
      // file is back; it used to outlive the restore (#133).
      const back = new Set((res?.restored || []).map(pathKey));
      setFlash((f) => (f?.deleted && back.has(pathKey(f.deleted)) ? null : f));
      // A file that was gone from disk is back (#92), and the lineage does not
      // list it yet: rescan, so it can be opened again.
      const known = new Set((lineage?.levels || []).flatMap((l) => l.entries).map((e) => pathKey(e.absPath)));
      if ((res?.restored || []).some((p) => !known.has(pathKey(p)))) {
        clearWatch();
        await runScan(lineage.projectDir);
        return;
      }
      await reloadSelected();
    },
    [suppressWatch, reloadSelected, lineage, clearWatch, runScan]
  );

  // #15. Both rescan afterwards, because the scan result is the allowlist: a
  // new file cannot be opened, nor a deleted one forgotten, until it is redone.
  const onCreate = useCallback(
    async ({ option, name, ext, acknowledge }) => {
      if (!leaveEditorOk()) return false;
      const res = await createFile({
        scanId: lineage.scanId,
        createId: option.id,
        name,
        ext,
        acknowledgeExecutable: acknowledge,
      });
      suppressWatch([res.absPath]);
      clearWatch();
      const next = await runScan(lineage.projectDir);
      setFlash({ text: `Created ${res.absPath} from a template.`, sub: res.notice });
      const entry = next?.levels.flatMap((l) => l.entries).find((e) => pathKey(e.absPath) === pathKey(res.absPath));
      if (entry) await loadEntry(next.scanId, entry, { edit: true });
      return true;
    },
    [lineage, leaveEditorOk, suppressWatch, clearWatch, runScan, loadEntry]
  );

  const onDelete = useCallback(
    async (target) => {
      const res = await deleteFile({ scanId: lineage.scanId, path: target.path, expectedMtime: target.mtime || null });
      suppressWatch([res.absPath]);
      clearWatch();
      await runScan(lineage.projectDir);
      // Local time first, as the snapshot list shows it; the id, which is UTC,
      // stays for `layercake restore <id>` (#133). The banner remembers the
      // file, so restoring it clears the banner (onRestored).
      setFlash({
        text: `Deleted ${res.absPath}. The snapshot taken ${snapshotTime(res.undoSnapshotId)} (${res.undoSnapshotId}) holds it; restore it from Snapshots.`,
        sub: res.notice,
        deleted: res.absPath,
      });
    },
    [lineage, suppressWatch, clearWatch, runScan]
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
            if (leaveEditorOk()) runScan();
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
            onClick={() => switchMode('explorer')}
          >
            Explorer
          </button>
          <button
            className={mode === 'flat' ? 'active' : ''}
            onClick={() => switchMode('flat')}
            disabled={!lineage}
          >
            Flattened
          </button>
          <button
            className={mode === 'snapshots' ? 'active' : ''}
            onClick={() => switchMode('snapshots')}
            disabled={!lineage}
          >
            Snapshots
          </button>
          <button className={mode === 'sessions' ? 'active' : ''} onClick={() => switchMode('sessions')}>
            Sessions
          </button>
          <button className={mode === 'castle' ? 'active' : ''} onClick={() => switchMode('castle')} disabled={!lineage}>
            Castle
          </button>
        </div>

        {recent.length > 1 && (
          <div className="recent">
            <span className="recent-label">recent</span>
            {recent.slice(1).map((p) => (
              <button key={p} className="chip" onClick={() => leaveEditorOk() && runScan(p)} title={p}>
                {p}
              </button>
            ))}
          </div>
        )}
      </header>

      {scanError && <div className="error-banner">{scanError}</div>}
      {flash && (
        <div className="flash-banner">
          <div>
            {flash.text}
            {flash.sub && <div className="notice-sub">{flash.sub}</div>}
          </div>
          <button className="btn btn-small" onClick={() => setFlash(null)}>
            Dismiss
          </button>
        </div>
      )}

      {lineage && (
        <WatchBanner
          changes={watchChanges}
          ready={watchReady}
          error={watchError}
          editorDirty={editing && editorDirty}
          onRescan={rescanCurrent}
          onDismiss={clearWatch}
          notify={notify}
          notifyError={notifyError}
          notifySupported={notifySupported}
          onEnableNotifications={enableNotifications}
          onDisableNotifications={disableNotifications}
          mute={watchMute}
        />
      )}

      {mode === 'sessions' ? (
        <div className="panes single">
          <SessionsView key={lineage?.projectDir || 'none'} projectDir={lineage?.projectDir || null} scanId={lineage?.scanId || null} />
        </div>
      ) : mode === 'castle' && lineage ? (
        // Keyed on the project, not the scan (#159): a rescan (the watch bar,
        // a create, a delete) gives a new scan id, and the castle reconnects
        // under it instead of starting over.
        <div className="panes single">
          <CastleView key={pathKey(lineage.projectDir)} scanId={lineage.scanId} projectDir={lineage.projectDir} />
        </div>
      ) : mode === 'snapshots' && lineage ? (
        // Full width, as Sessions is (#143; owner decision 2026-09-28): the
        // tree is not used while comparing, and beside it every path wrapped
        // at 1000 px. Explorer brings it back.
        <div className="panes single">
          <div className="pane-right">
            <SnapshotPanel scanId={lineage.scanId} onRestored={onRestored} />
          </div>
        </div>
      ) : (
      <div className="panes">
        <div className="pane-left">
          {lineage ? (
            <LineageTree
              lineage={lineage}
              selectedPath={selected}
              onSelect={onSelect}
              overlay={overlay}
              namePattern={policy?.create?.namePattern}
              onCreate={policy?.create ? onCreate : null}
            />
          ) : (
            <div className="empty-state">
              {scanning ? 'Scanning…' : 'Enter a project directory and press Scan.'}
            </div>
          )}
        </div>

        <div className="pane-right">
          {mode === 'flat' && lineage ? (
            <FlattenView scanId={lineage.scanId} />
          ) : editing && file && !file.error ? (
            <div className="editor-view">
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
            </div>
          ) : file || fileLoading ? (
            <FileViewer
              file={file}
              loading={fileLoading}
              editableCategories={policy?.editableCategories}
              onEdit={file && !file.error ? () => setEditing(true) : null}
              onDelete={onDelete}
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
