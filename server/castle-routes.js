/**
 * /api/castle* routes (#159, #160): the Castle's live stream, a room's recent
 * files, and re-reading castle.json.
 *
 * Behind the same guards as the rest of /api (registered after them in
 * app.js). A project is addressed only by a scan id, whose project folder the
 * scan store holds, the way /api/launch takes its folder: nothing here accepts
 * a path. These are content routes, like the session routes: they carry file
 * paths, tool names and one-line summaries, never a file or tool body.
 */

import { openCastle, reloadCastleMap, subscribeCastle } from './castle.js';
import { ROOM_ID_RE } from './castlemap.js';

const MAX_STREAMS = 4;
/** An event, not a comment line, so the page can tell a quiet castle from a dead stream. */
const PING_MS = 30_000;
/** Hollowmere (village) and the Citadel (outside) have lists too; every other id must be one of the open castle's rooms (#167, #172). */
const BANDS = new Set(['village', 'outside']);

const streams = new Set();

/** Ends the castle streams opened under a scan the server no longer keeps. */
export function closeCastleStreamsFor(scanId) {
  for (const stream of [...streams]) if (stream.scanId === scanId) stream.close();
}

/**
 * @param {import('express').Express} app
 * @param {{ projectFor: (scanId: string) => string | null }} scansApi
 */
export function registerCastleRoutes(app, { projectFor }) {
  app.get('/api/castle/stream', async (req, res) => {
    const scanId = String(req.query.scanId || '');
    // The slot is taken before the first await, not only checked (#30), and
    // every early exit gives it back.
    if (streams.size >= MAX_STREAMS) {
      return res.status(429).json({ message: `Already showing ${MAX_STREAMS} castles. Close another LayerCake tab.`, code: 'ETOOMANY' });
    }
    let unsubscribe = null;
    let ping = null;
    let closed = false;
    const stream = {
      scanId,
      close() {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        if (unsubscribe) unsubscribe();
        streams.delete(stream);
        if (!res.writableEnded && res.headersSent) res.end();
      },
    };
    streams.add(stream);
    req.on('close', () => stream.close());

    const projectDir = projectFor(scanId);
    if (!projectDir) {
      stream.close();
      return res.status(404).json({ message: 'Unknown or expired scan. Re-scan the directory.', code: 'ESCANGONE' });
    }
    const send = (event, payload) => {
      if (closed || res.writableEnded || !res.headersSent) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    // Headers first, so the frames subscribeCastle sends on joining land.
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    try {
      const stop = await subscribeCastle(projectDir, send);
      // Gone while the castle started, or its scan evicted meanwhile.
      if (closed || !projectFor(scanId)) {
        stop();
        stream.close();
        return undefined;
      }
      unsubscribe = stop;
    } catch (err) {
      send('error', { message: err?.message || 'The castle could not start.' });
      stream.close();
      return undefined;
    }
    ping = setInterval(() => send('ping', { at: new Date().toISOString() }), PING_MS);
    return undefined;
  });

  /** A room's recent files (paths only), while the project's castle is open. */
  app.get('/api/castle/room', (req, res) => {
    const projectDir = projectFor(String(req.query.scanId || ''));
    if (!projectDir) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan the directory.', code: 'ESCANGONE' });
    const id = String(req.query.room || '');
    if (!BANDS.has(id) && !ROOM_ID_RE.test(id)) return res.status(400).json({ message: 'Not a room.', code: 'EBADREQUEST' });
    const castle = openCastle(projectDir);
    if (!castle?.folded) return res.status(409).json({ message: 'The castle for this project is not open.', code: 'ENOTOPEN' });
    const detail = castle.roomDetail(id);
    if (!detail) return res.status(400).json({ message: 'Not a room.', code: 'EBADREQUEST' });
    return res.json(detail);
  });

  /** Re-reads castle.json for the open castle (the map bar's Reload). */
  app.post('/api/castle/reload', async (req, res) => {
    const projectDir = projectFor(String(req.body?.scanId || ''));
    if (!projectDir) return res.status(404).json({ message: 'Unknown or expired scan. Re-scan the directory.', code: 'ESCANGONE' });
    try {
      const result = await reloadCastleMap(projectDir);
      if (!result) return res.status(409).json({ message: 'The castle for this project is not open.', code: 'ENOTOPEN' });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ message: err.message, code: err.code || null });
    }
  });
}
