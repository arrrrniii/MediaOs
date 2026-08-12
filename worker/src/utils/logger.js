/**
 * Tiny dependency-free structured logger.
 *
 * Emits single-line JSON: {ts, level, msg, ...fields}. Levels debug/info/warn/
 * error are gated by LOG_LEVEL (default 'info'; 'silent' under NODE_ENV=test so
 * the suite stays quiet unless a test opts in). Set LOG_PRETTY=true for a
 * one-line human format in development — the default is always JSON.
 *
 *   const logger = require('./utils/logger');
 *   logger.info('boot', { step: 'pg' });
 *   const reqLog = logger.child({ request_id: id });
 *   reqLog.error('request failed', { status: 500 });
 *
 * child(fields) returns a logger that merges `fields` into every record and
 * shares the parent's level/sink/format. Records route to stderr at warn/error,
 * stdout otherwise, so log pipelines can split them.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function resolveDefaultLevel() {
  const explicit = process.env.LOG_LEVEL && String(process.env.LOG_LEVEL).toLowerCase();
  if (explicit && LEVELS[explicit] != null) return explicit;
  // Stay quiet under Jest (detected via JEST_WORKER_ID, which survives a
  // sourced .env that would otherwise override NODE_ENV) unless a test opts in.
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined) return 'silent';
  return 'info';
}

function defaultSink(levelName, line) {
  if (LEVELS[levelName] >= LEVELS.warn) process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function prettyFormat(rec) {
  const { ts, level, msg, ...rest } = rec;
  const keys = Object.keys(rest);
  const tail = keys.length ? ' ' + keys.map((k) => `${k}=${format(rest[k])}`).join(' ') : '';
  return `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
}

function format(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function makeLogger(opts = {}) {
  const state = {
    level: opts.level || resolveDefaultLevel(),
    fields: opts.fields || {},
    sink: opts.sink || defaultSink,
    pretty: opts.pretty != null ? opts.pretty : process.env.LOG_PRETTY === 'true',
  };

  function emit(levelName, msg, extra) {
    if (LEVELS[levelName] < LEVELS[state.level]) return;
    const rec = {
      ts: new Date().toISOString(),
      level: levelName,
      msg: typeof msg === 'string' ? msg : format(msg),
      ...state.fields,
      ...(extra && typeof extra === 'object' ? extra : {}),
    };
    const line = state.pretty ? prettyFormat(rec) : JSON.stringify(rec);
    try {
      state.sink(levelName, line);
    } catch {
      /* never let logging throw into the caller */
    }
  }

  const logger = {
    debug: (msg, extra) => emit('debug', msg, extra),
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
    child: (fields) => makeLogger({
      level: state.level,
      sink: state.sink,
      pretty: state.pretty,
      fields: { ...state.fields, ...(fields || {}) },
    }),
    // Test/ops hook: change the active level at runtime.
    setLevel: (level) => { if (LEVELS[level] != null) state.level = level; },
    get level() { return state.level; },
  };
  return logger;
}

// Default singleton plus the factory (so tests can build a logger with a
// captured sink and assert on the emitted line without touching env).
const base = makeLogger();
base.create = makeLogger;
base.LEVELS = LEVELS;

module.exports = base;
