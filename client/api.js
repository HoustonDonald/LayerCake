/**
 * The per-start session token, injected into our HTML by the server.
 * A cross-origin page cannot read it, which is what stops a hostile tab from
 * driving the write endpoints. Read once: a stale token means the server
 * restarted, and the 403 tells the user to reload.
 */
const TOKEN = document.querySelector('meta[name="layercake-token"]')?.content || '';

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), 'X-LayerCake-Token': TOKEN },
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Unexpected response from server (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(payload?.message || `Request failed (${res.status})`);
  }
  return payload;
}

export function getManifest() {
  return request('/api/manifest');
}

export function validateDir(dir) {
  return request(`/api/validate?dir=${encodeURIComponent(dir)}`);
}

export function scan(dir) {
  return request('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
}

export function readFile(scanId, filePath) {
  return request(`/api/file?scanId=${encodeURIComponent(scanId)}&path=${encodeURIComponent(filePath)}`);
}

export function getFlatten(scanId, kind) {
  return request(`/api/flatten?scanId=${encodeURIComponent(scanId)}&kind=${encodeURIComponent(kind)}`);
}

function post(url, body) {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function writeFile({ scanId, path, content, expectedMtime, acknowledgeExecutable }) {
  return post('/api/write', { scanId, path, content, expectedMtime, acknowledgeExecutable });
}

export function createSnapshot(scanId, label) {
  return post('/api/snapshot', { scanId, label });
}

export function listSnapshots() {
  return request('/api/snapshots');
}

export function getSnapshot(id) {
  return request(`/api/snapshot/${encodeURIComponent(id)}`);
}

export function compareSnapshot(id) {
  return request(`/api/snapshot/${encodeURIComponent(id)}/compare`);
}

export function getSnapshotFile(id, filePath) {
  return request(
    `/api/snapshot/${encodeURIComponent(id)}/file?path=${encodeURIComponent(filePath)}`
  );
}

export function restore(scanId, id, paths) {
  return post('/api/restore', { scanId, id, paths });
}

/**
 * Subscribes to filesystem events for a scan. Returns a function that stops it.
 *
 * Read with fetch and a stream reader rather than EventSource, because
 * EventSource cannot set a request header. The only alternative would be
 * putting the session token in the query string, where it would end up in
 * browser history and any future access log. Hand-parsing eight lines of SSE
 * framing is the cheaper half of that trade.
 *
 * All three callbacks are optional. `onError` is called for a refused stream
 * (an expired scan, too many tabs) and for a dropped connection, never for an
 * abort the caller asked for.
 */
export function watchScan(scanId, { onReady, onChange, onError } = {}) {
  const controller = new AbortController();

  (async () => {
    let res;
    try {
      res = await fetch(`/api/watch?scanId=${encodeURIComponent(scanId)}`, {
        headers: { 'X-LayerCake-Token': TOKEN },
        signal: controller.signal,
      });
    } catch (err) {
      if (!controller.signal.aborted) onError?.(err.message || 'Watch connection failed');
      return;
    }

    if (!res.ok) {
      // A refusal is an ordinary JSON body, not a stream.
      let message = `Watch failed (${res.status})`;
      try {
        const payload = await res.json();
        if (payload?.message) message = payload.message;
      } catch {
        /* keep the status-based message */
      }
      onError?.(message);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames end with a blank line. Anything after the last one is a
        // partial frame and stays in the buffer until the rest arrives.
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          dispatchFrame(frame, { onReady, onChange });
          split = buffer.indexOf('\n\n');
        }
      }
      // The server only ends the stream when the scan is evicted or it shuts
      // down. Either way the client's view is stale and should say so.
      if (!controller.signal.aborted) onError?.('Watch stream ended. Re-scan to resume.');
    } catch (err) {
      if (!controller.signal.aborted) onError?.(err.message || 'Watch connection lost');
    }
  })();

  return () => controller.abort();
}

/** One SSE frame to one callback. Comment-only frames (the keepalive) are dropped. */
function dispatchFrame(frame, { onReady, onChange }) {
  let event = null;
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!event || dataLines.length === 0) return;

  let payload;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }
  if (event === 'ready') onReady?.(payload);
  else if (event === 'change') onChange?.(payload);
}
