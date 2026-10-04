import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { ensurePageKey } from './server/appdata.js';

const API_PORT = process.env.PORT || 5178;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

// Resolved from this file rather than the working directory, which differs
// between `npm run build` and desktop/build.mjs.
const ICON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop', 'layercake.ico');

/**
 * The page's icon (#60): the exe's own icon, desktop/layercake.ico, emitted
 * into the build as favicon.ico. That puts it in public/, which npm start
 * serves from disk and desktop/build.mjs embeds in the exe with the rest of the
 * client, so both serve it the same way as any other asset, behind the same
 * Host guard. Emitted rather than copied into client/public/, so the .ico
 * stays one file and scripts/make-icon.mjs stays its only writer.
 *
 * The dev server (npm run dev:client) builds nothing, so there it is served by
 * a middleware instead (#94), read on each request so a redrawn icon shows
 * without a restart. generateBundle runs only in a build and configureServer
 * only in dev, so each half stays out of the other.
 */
function favicon() {
  return {
    name: 'layercake-favicon',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'favicon.ico', source: fs.readFileSync(ICON) });
    },
    configureServer(server) {
      server.middlewares.use('/favicon.ico', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        res.setHeader('Content-Type', 'image/x-icon');
        return res.end(fs.readFileSync(ICON));
      });
    },
  };
}

/**
 * Dev only (npm run dev:client; `apply: 'serve'` keeps it out of every build).
 * Every /api route requires the page key (#189), which no page carries: the
 * production window is handed it in its address fragment. The dev page gets it
 * the same way: this prints the address to open, key included, on the
 * developer's own console once Vite is listening. Never in the HTML, which
 * anything that can reach the port could read. Opened once, the page keeps the
 * key in this origin's localStorage, so reloads and HMR keep working.
 */
function devPageAddress() {
  return {
    name: 'layercake-dev-page-address',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', async () => {
        const key = await ensurePageKey();
        const { port } = server.httpServer.address();
        server.config.logger.info(`\n  LayerCake dev page:  http://localhost:${port}/#t=${key}\n`);
      });
    },
  };
}

export default defineConfig({
  root: 'client',
  plugins: [react(), devPageAddress(), favicon()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5179,
    // Vite's default CORS lets any localhost origin (another dev server's page,
    // say) read what this server returns, including /api answers proxied
    // through it. Nothing legitimate here is cross-origin.
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
