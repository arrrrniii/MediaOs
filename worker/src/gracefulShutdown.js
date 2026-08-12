/**
 * Ordered, bounded graceful shutdown.
 *
 * createGracefulShutdown({ steps, timeoutMs, exit, logger }) returns a
 * shutdown(signal) handler that:
 *   - runs each step in `steps` order, awaiting it and logging begin/end;
 *   - catches a step's error so a later step still runs (a failed flush must
 *     not skip closing the pool);
 *   - arms an unref'd force-exit timer so a hung step still terminates the
 *     process with code 1 after `timeoutMs`;
 *   - on a SECOND signal, exits immediately with code 1;
 *   - exits 0 once every step resolves.
 *
 * The order the worker uses (built in index.js): stop timers → close HTTP →
 * drain workers → flush usage → flush access → close redis+pg → flush traces.
 */

function createGracefulShutdown({ steps = [], timeoutMs = 25000, exit = process.exit, logger } = {}) {
  const log = logger || require('./utils/logger');
  let shuttingDown = false;

  return async function shutdown(signal) {
    if (shuttingDown) {
      log.warn('shutdown.forced', { signal });
      return exit(1);
    }
    shuttingDown = true;
    log.info('shutdown.begin', { signal, timeout_ms: timeoutMs });

    const forceTimer = setTimeout(() => {
      log.error('shutdown.timeout', { timeout_ms: timeoutMs });
      exit(1);
    }, timeoutMs);
    if (forceTimer.unref) forceTimer.unref();

    for (const step of steps) {
      try {
        await step.run();
        log.info('shutdown.step', { step: step.name });
      } catch (err) {
        log.error('shutdown.step_error', { step: step.name, error: err && err.message });
      }
    }

    clearTimeout(forceTimer);
    log.info('shutdown.complete');
    return exit(0);
  };
}

module.exports = { createGracefulShutdown };
