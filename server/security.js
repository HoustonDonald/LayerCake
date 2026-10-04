/**
 * Localhost CSRF guard.
 *
 * Why this exists now and did not before: while the app was read-only, a hostile
 * page in the same browser could *send* requests here but not read the replies,
 * and a JSON POST triggers a CORS preflight that fails outright. Exposure was
 * effectively nil.
 *
 * Writes end that. A cross-origin <form> POST is a "simple request": no
 * preflight, it just fires. The attacker never reads the response and does not
 * need to, because the write already happened. So state-changing routes need a
 * real origin check plus a secret the calling page must hold.
 *
 * That secret is the page key (#189, ensurePageKey in appdata.js). It is never
 * in the HTML: anything that can connect to the port could read the HTML,
 * another signed-in Windows user included, since a loopback port is open to
 * every user of the machine. The launch that opens our window passes it in the
 * address's fragment, which is never sent to a server and which another user
 * cannot read from the browser's command line; the page keeps it.
 *
 * Not a defense against a hostile process running as the same user: it can
 * write these files, and read the key, directly. This closes the browser path
 * and the other-user path.
 */

import crypto from 'node:crypto';

export const TOKEN_HEADER = 'x-layercake-token';

function allowedOrigins(port) {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
}

/**
 * Rejects anything a hostile page could originate.
 *
 * Header semantics that matter here:
 *  - Origin is absent on a same-origin GET and on non-browser clients (curl).
 *    It is always present on a cross-origin POST, which is the case we care about.
 *  - Sec-Fetch-Site is set by the browser and cannot be forged by page script,
 *    so "cross-site" / "same-site" is a reliable reject even when Origin is absent.
 */
export function originGuard(port) {
  const allowed = allowedOrigins(port);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && !allowed.has(origin)) {
      return res.status(403).json({ message: 'Cross-origin request refused.', code: 'ECROSSORIGIN' });
    }
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      return res.status(403).json({ message: 'Cross-site request refused.', code: 'ECROSSSITE' });
    }
    return next();
  };
}

/**
 * Refuses any request whose Host header is not this server's own name.
 *
 * DNS rebinding: a hostile site re-points its own hostname at 127.0.0.1 after
 * its page has loaded. The browser then treats this server as that site's
 * origin, so the page can read "/" (token included) as same-origin, and a
 * same-origin GET carries no Origin header and passes originGuard. What the
 * page cannot change is the Host header, which still names the hostile site.
 *
 * Unlike originGuard this belongs on EVERY route, the HTML included, because
 * the HTML is what a rebinding page reads to get the token. It cannot repeat
 * the mistake that rule warns about: however the user arrives at
 * http://127.0.0.1:PORT, from a bookmark or a link, the Host header says so.
 *
 * [::1] is not listed because the server binds 127.0.0.1 only. Port 80 is the
 * one case where a browser omits the port from Host.
 */
export function hostGuard(port) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (port === 80) {
    allowed.add('127.0.0.1');
    allowed.add('localhost');
  }
  return (req, res, next) => {
    if (allowed.has(String(req.headers.host || '').toLowerCase())) return next();
    return res
      .status(403)
      .type('text')
      .send(`Refused: this server answers only as http://127.0.0.1:${port} or http://localhost:${port}.`);
  };
}

/**
 * Requires the page key. Compared in constant time out of habit rather than
 * need: a timing oracle on localhost is not the realistic attack, but the
 * correct comparison is free.
 */
export function requireToken(key) {
  if (!/^[0-9a-f]{64}$/.test(String(key || ''))) throw new Error('requireToken needs the page key');
  const b = Buffer.from(key);
  return (req, res, next) => {
    const a = Buffer.from(req.get(TOKEN_HEADER) || '');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({
        message: "This page does not have LayerCake's key. Open LayerCake from its own window, or the address npm start printed.",
        code: 'EBADTOKEN',
      });
    }
    return next();
  };
}

/**
 * The answer to a launch's challenge (#189, #190): HMAC-SHA256 of the nonce
 * under the page key. A launch that finds something answering on the port
 * asks /hello?nonce=<random> and compares this with its own computation, so it
 * opens its window only on a server that knows its user's key, never sending
 * the key to one that might not. HMAC under a random 256-bit key reveals
 * nothing about the key, whatever nonces anyone asks for.
 */
export function keyProof(key, nonce) {
  return crypto.createHmac('sha256', key).update(String(nonce)).digest('hex');
}
