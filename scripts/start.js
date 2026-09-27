/**
 * npm start: build the client if the bundle is stale or missing, then serve.
 * Keeps the single-command promise without shipping a watcher dependency.
 */

import { buildClientIfStale } from './build-if-stale.js';

await buildClientIfStale();

await import('../server/index.js');
