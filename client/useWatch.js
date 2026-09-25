import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { watchScan } from './api.js';

/**
 * Live filesystem changes for the current scan.
 *
 * Deliberately does NOT re-scan on its own. A scan replaces the lineage, which
 * would swap the file under an open editor and throw away whatever was typed
 * into it. The hook reports; the user decides. That is also why the banner
 * carries a button rather than a countdown.
 */

const NOTIFY_KEY = 'layercake.notifyOnChange';

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

export default function useWatch(scanId) {
  const [changes, setChanges] = useState([]);
  const [ready, setReady] = useState(null);
  const [error, setError] = useState(null);
  const [notify, setNotify] = useState(() => {
    try {
      return localStorage.getItem(NOTIFY_KEY) === 'yes';
    } catch {
      return false;
    }
  });

  // A ref, not state: suppression is consulted inside the stream callback, and
  // a stale closure over state would let a just-saved file through.
  const suppressed = useRef(new Map());
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

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

        setChanges((prev) => {
          // Keyed merge, so a file touched five times is one row, not five.
          const merged = new Map(prev.map((c) => [pathKey(c.absPath), c]));
          for (const c of incoming) merged.set(pathKey(c.absPath), c);
          return [...merged.values()];
        });

        // Only toast a window the user is not looking at. With the tab focused
        // the banner is already in front of them, and a duplicate toast is just
        // noise they have to dismiss.
        if (notifyRef.current && document.visibilityState === 'hidden') {
          maybeNotify(incoming);
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
      setError('This browser has no notification support.');
      return false;
    }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    const granted = permission === 'granted';
    setNotify(granted);
    try {
      localStorage.setItem(NOTIFY_KEY, granted ? 'yes' : 'no');
    } catch {
      /* private mode: the toggle just does not persist */
    }
    if (!granted) {
      setError('Notifications are blocked for this site. Re-enable them in site settings.');
    }
    return granted;
  }, []);

  const disableNotifications = useCallback(() => {
    setNotify(false);
    try {
      localStorage.setItem(NOTIFY_KEY, 'no');
    } catch {
      /* not worth reporting */
    }
  }, []);

  const notifySupported = useMemo(() => typeof window !== 'undefined' && 'Notification' in window, []);

  return {
    changes,
    ready,
    error,
    clear,
    suppress,
    notify,
    notifySupported,
    enableNotifications,
    disableNotifications,
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
