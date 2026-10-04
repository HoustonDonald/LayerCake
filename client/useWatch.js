import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getPrefs, savePrefs, watchScan } from './api.js';

/**
 * Live filesystem changes for the current scan.
 *
 * Deliberately does NOT re-scan on its own. A scan replaces the lineage, which
 * would swap the file under an open editor and throw away whatever was typed
 * into it. The hook reports; the user decides. That is also why the banner
 * carries a button rather than a countdown.
 */


/**
 * How long a path stays suppressed after LayerCake writes it.
 *
 * Our own saves are filesystem changes like any other, so without this every
 * save would immediately announce that the file changed on disk. The window
 * covers the server's 250ms debounce plus the round trip, with room to spare;
 * being slightly generous costs only a missed banner for a file the user just
 * saved themselves, which is the one case where they do not need telling.
 */
const SUPPRESS_MS = 2000;

/**
 * Windows path comparison is case insensitive and this is only ever used to
 * match our own writes against our own events, so folding case on every
 * platform is safe. The worst case on POSIX is two files differing only by
 * case, where one loses its banner for two seconds.
 */
function pathKey(p) {
  return String(p || '').toLowerCase();
}

/**
 * Files the viewer has muted in the bar (#13): lowercased-on-win32 path ->
 * the path as the server spelled it, kept for display.
 *
 * A mute is a preference about what may light the bar. It is kept in
 * LayerCake's data folder (/api/prefs, #198), since each run is a new browser
 * origin and the browser's storage starts empty; the server stores it and never
 * acts on it, and keeps reporting every event: the stream stays a truthful
 * account of the disk, and the mute decides only what the bar does about one
 * file (#13).
 */

/**
 * Unlike pathKey above, case is folded only where the filesystem folds it.
 * A wrong fold there costs a two-second blip; here it would mute a file the
 * viewer never chose, for good.
 */
function muteKeyFor(platform) {
  return (p) => (platform === 'win32' ? String(p || '').toLowerCase() : String(p || ''));
}

/** The stored mutes, as a Map; anything odd reads as none. */
function mutedFrom(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return new Map();
  return new Map(Object.entries(stored).filter(([, shown]) => typeof shown === 'string'));
}

export default function useWatch(scanId, platform) {
  const [changes, setChanges] = useState([]);
  const [ready, setReady] = useState(null);
  const [error, setError] = useState(null);
  // Kept apart from `error`, which means the stream is down: a refused
  // permission once shared it, and the bar then read "Not watching for
  // changes" and hid real events until a rescan (#128).
  const [notifyError, setNotifyError] = useState(null);
  const [notify, setNotify] = useState(false);
  const [muted, setMuted] = useState(() => new Map());
  // The stored preferences, once. Notification permission belongs to the
  // browser origin, and each run is a new one (#198), so a stored "notify"
  // takes effect only where the browser already allows it; otherwise the bar
  // says it needs allowing again.
  useEffect(() => {
    let alive = true;
    getPrefs()
      .then((p) => {
        if (!alive) return;
        setMuted(mutedFrom(p.muted));
        if (p.notify === true) {
          const allowed = 'Notification' in window && Notification.permission === 'granted';
          setNotify(allowed);
          if (!allowed) setNotifyError('Change notifications were on: LayerCake opens on a new address each run, so allow them again with Notify me.');
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const keyOf = useMemo(() => muteKeyFor(platform), [platform]);
  const isMuted = useCallback((p) => muted.has(keyOf(p)), [muted, keyOf]);

  // A ref, not state: suppression is consulted inside the stream callback, and
  // a stale closure over state would let a just-saved file through.
  const suppressed = useRef(new Map());
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  // Same reason: the stream callback is bound once per scan, and a mute set
  // after that must still stop the next toast.
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;

  // A toggle starts from what is STORED, not this window's copy: another
  // window may have muted something since, and writing this window's older
  // list back erased it (#77). Stored preferences that cannot be read fall back
  // to this window's list. Another window sees the change on its next toggle
  // or reload.
  const toggleMute = useCallback(
    async (absPath) => {
      const stored = await getPrefs().then((p) => mutedFrom(p.muted), () => null);
      const key = keyOf(absPath);
      setMuted((prev) => {
        const next = new Map(stored || prev);
        if (next.has(key)) next.delete(key);
        else next.set(key, absPath);
        // Idempotent, so React running this updater twice costs a repeat only.
        savePrefs({ muted: Object.fromEntries(next) }).catch(() => {});
        return next;
      });
    },
    [keyOf]
  );

  const suppress = useCallback((paths) => {
    const until = Date.now() + SUPPRESS_MS;
    for (const p of [].concat(paths || [])) suppressed.current.set(pathKey(p), until);
  }, []);

  const clear = useCallback(() => setChanges([]), []);

  useEffect(() => {
    setChanges([]);
    setReady(null);
    setError(null);
    if (!scanId) return undefined;

    const stop = watchScan(scanId, {
      onReady: (payload) => {
        setReady(payload);
        setError(null);
      },
      onError: (message) => setError(message),
      onChange: (payload) => {
        const now = Date.now();
        const incoming = (payload?.changes || []).filter((c) => {
          const until = suppressed.current.get(pathKey(c.absPath));
          if (until && until > now) return false;
          if (until) suppressed.current.delete(pathKey(c.absPath));
          return true;
        });
        if (incoming.length === 0) return;

        // Muted files are merged in like any other: a mute keeps a file from
        // lighting the bar, never from being counted or shown.
        setChanges((prev) => {
          // Keyed merge, so a file touched five times is one row, not five.
          const merged = new Map(prev.map((c) => [pathKey(c.absPath), c]));
          for (const c of incoming) merged.set(pathKey(c.absPath), c);
          return [...merged.values()];
        });

        // Only toast a window the user is not looking at. With the tab focused
        // the banner is already in front of them, and a duplicate toast is just
        // noise they have to dismiss. A muted file does not toast either: a
        // toast is the bar lighting up somewhere else.
        const loud = incoming.filter((c) => !isMutedRef.current(c.absPath));
        if (loud.length && notifyRef.current && document.visibilityState === 'hidden') {
          maybeNotify(loud);
        }
      },
    });

    return stop;
  }, [scanId]);

  /**
   * Must be called from a click. Chrome refuses Notification.requestPermission
   * outside a user gesture, and a refusal is indistinguishable from a denial,
   * so asking on load would silently poison the permission for the session.
   */
  const enableNotifications = useCallback(async () => {
    if (!('Notification' in window)) {
      setNotifyError('This browser has no notification support.');
      return false;
    }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    const granted = permission === 'granted';
    setNotify(granted);
    savePrefs({ notify: granted }).catch(() => {});
    setNotifyError(granted ? null : 'Notifications are blocked for this site. Re-enable them in site settings.');
    return granted;
  }, []);

  const disableNotifications = useCallback(() => {
    setNotify(false);
    setNotifyError(null);
    savePrefs({ notify: false }).catch(() => {});
  }, []);

  const notifySupported = useMemo(() => typeof window !== 'undefined' && 'Notification' in window, []);

  const mute = useMemo(
    () => ({ isMuted, keyOf, paths: [...muted.values()], toggle: toggleMute }),
    [isMuted, keyOf, muted, toggleMute]
  );

  return {
    changes,
    ready,
    error,
    clear,
    suppress,
    notify,
    notifyError,
    notifySupported,
    enableNotifications,
    disableNotifications,
    mute,
  };
}

/**
 * One toast per batch, never one per file: a git checkout can rewrite a dozen
 * config files at once and twelve toasts is an attack on the user, not a
 * notification. The tag collapses repeats onto a single toast as well.
 */
function maybeNotify(changes) {
  try {
    if (Notification.permission !== 'granted') return;
    const first = changes[0];
    const rest = changes.length - 1;
    const title =
      changes.length === 1
        ? `${first.name || 'A watched folder'} changed`
        : `${changes.length} config files changed`;
    const body = rest > 0 ? `${first.absPath} and ${rest} more` : first.absPath;
    // eslint-disable-next-line no-new
    new Notification(title, { body, tag: 'layercake-change', silent: true });
  } catch {
    /* a toast that cannot be shown is not worth an error banner */
  }
}
