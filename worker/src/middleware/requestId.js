/**
 * Request correlation + access logging.
 *
 * Mounted FIRST (before helmet/body/cors) so every request — even one rejected
 * downstream — carries an id. Reads an incoming X-Request-Id (trusted only as a
 * bounded opaque string) or generates a uuid, echoes it back on the response,
 * and attaches req.log, a child logger bound to {request_id, method, path}.
 *
 * On response finish it records HTTP metrics and writes one access line. The
 * hot paths (/health, /metrics, and the byte-serving /f/ /img/ routes) are
 * logged at debug so a busy CDN does not drown the log; everything else logs at
 * info. req.id is what upload/enqueue code threads into job data so a job traces
 * back to the request that created it.
 */

const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
const metrics = require('../observability/metrics');

const HOT_PATHS = [/^\/health/, /^\/metrics/, /^\/f\//, /^\/img\//];

function isHotPath(path) {
  return HOT_PATHS.some((re) => re.test(path));
}

function sanitizeIncoming(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Bound length and charset so a header cannot inject newlines into logs.
  if (!trimmed || trimmed.length > 200) return null;
  if (!/^[\w.\-:]+$/.test(trimmed)) return null;
  return trimmed;
}

function requestId(req, res, next) {
  const id = sanitizeIncoming(req.headers['x-request-id']) || randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  req.log = logger.child({ request_id: id, method: req.method, path: req.path });

  const start = process.hrtime.bigint();
  let logged = false;
  const onDone = () => {
    if (logged) return;
    logged = true;
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    try {
      metrics.observeHttp(req, res, durationMs);
    } catch {
      /* metrics must never break a response */
    }
    const level = isHotPath(req.path) ? 'debug' : 'info';
    req.log[level]('request', {
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 1000) / 1000,
    });
  };
  res.on('finish', onDone);
  res.on('close', onDone);

  next();
}

module.exports = requestId;
module.exports.isHotPath = isHotPath;
