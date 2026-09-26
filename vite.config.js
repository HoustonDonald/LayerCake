import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.PORT || 5178;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

/**
 * Dev only (npm run dev:client; `apply: 'serve'` keeps it out of every build).
 * Every /api route requires the per-start session token, which the server
 * writes into the HTML it serves (injectToken in server/security.js). Vite
 * serves client/index.html itself, so without this the page has no token.
 *
 * The token is read from the running server's own page, the place the
 * production page gets it, rather than from a route that hands it out: such a
 * route would give the token to anything that can reach the port. It is read
 * on every page load because dev:server makes a new token each time it starts,
 * and a reload is what the app's stale-token message asks for.
 *
 * The server serves that page from public/, so it answers with a token only
 * once the client has been built (npm run build). The error below says so.
 */
function devSessionToken() {
  return {
    name: 'layercake-dev-session-token',
    apply: 'serve',
    async transformIndexHtml() {
      let res;
      try {
        res = await fetch(`${API_ORIGIN}/`, { signal: AbortSignal.timeout(5000) });
      } catch (err) {
        throw new Error(
          `No LayerCake server answered at ${API_ORIGIN} (${err.cause?.code || err.name}). ` +
            'Start it with "npm run dev:server", then reload.'
        );
      }
      const body = await res.text();
      // Hex only, so nothing but a token can reach the page from here.
      const token = /<meta name="layercake-token" content="([0-9a-f]+)">/.exec(body)?.[1];
      if (!token) {
        throw new Error(`${API_ORIGIN}/ answered ${res.status} without a session token: ${body.slice(0, 200)}`);
      }
      return [{ tag: 'meta', attrs: { name: 'layercake-token', content: token }, injectTo: 'head-prepend' }];
    },
  };
}

export default defineConfig({
  root: 'client',
  plugins: [react(), devSessionToken()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5179,
    // Vite's default CORS lets any localhost origin (another dev server's page,
    // say) read what this server returns, and the page it returns now carries
    // the session token. The security design rests on no other page being able
    // to read that token, and nothing legitimate here is cross-origin.
    cors: false,
    proxy: {
      // '/api/' and not '/api': a proxy key is a plain prefix match, and '/api'
      // also took the client's own module /api.js, so the page received the
      // server's HTML in place of its JavaScript and never started.
      '/api/': {
        target: API_ORIGIN,
        // The server's Host guard answers only to its own name.
        changeOrigin: true,
        configure(proxy) {
          // The server's origin guard allows only its own origin, and a POST from
          // this page carries Origin: http://localhost:5179. Only a request the
          // browser marks same-origin, which is this page's own, is presented as
          // the server's page. Any other request keeps its Origin and
          // Sec-Fetch-Site and meets the guard exactly as it would in production.
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin') {
              proxyReq.setHeader('origin', API_ORIGIN);
            }
          });
        },
      },
    },
  },
});
