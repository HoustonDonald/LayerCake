/**
 * Counts requests whose handler has not finished yet, so the single executable
 * can wait for them before it exits.
 *
 * server.close() is not that wait. It waits for open CONNECTIONS, and when the
 * window closes the browser takes its sockets with it, so close() calls back at
 * once while a save or a restore is still running. Exiting then loses the edit
 * (the target and the snapshot manifest are written last) and can stop a
 * multi-file restore halfway. Measured in review: close() called back at 610 ms,
 * the handler finished at 1526 ms.
 *
 * "Finished" means the handler called res.end(). Express does that for every
 * response, including one whose client has already gone, which is the case
 * that matters here. The 'finish' event never fires for such a response and
 * 'close' fires at the disconnect, so neither can stand in for it.
 */

export function trackInflight(server) {
  let inflight = 0;
  let onIdle = null;

  // Prepended so it runs before Express, which can end a response
  // synchronously (a 404, a 403 from a guard) before a later listener ran.
  server.prependListener('request', (_req, res) => {
    inflight += 1;
    const end = res.end;
    let open = true;
    res.end = function endAndCount(...args) {
      if (open) {
        open = false;
        inflight -= 1;
        if (inflight === 0 && onIdle) onIdle();
      }
      return end.apply(this, args);
    };
  });

  return {
    get count() {
      return inflight;
    },
    /** Resolves true once no handler is running, or false after maxMs. */
    idle(maxMs) {
      if (inflight === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          onIdle = null;
          resolve(false);
        }, maxMs);
        onIdle = () => {
          clearTimeout(timer);
          onIdle = null;
          resolve(true);
        };
      });
    },
  };
}
