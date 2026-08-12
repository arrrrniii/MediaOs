/**
 * OpenTelemetry tracing — optional, off by default.
 *
 * init() is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (or OTEL_ENABLED
 * =true). When disabled it requires none of the @opentelemetry/* packages and
 * adds zero overhead, so boot and the test suite run with no collector present.
 * When enabled it starts a NodeSDK with the OTLP/HTTP trace exporter and the
 * standard auto-instrumentations (http, express, pg, ioredis).
 *
 * Call init() at the very top of index.js, BEFORE requiring instrumented
 * modules, so the auto-instrumentations can patch them.
 */

function isEnabled() {
  return process.env.OTEL_ENABLED === 'true' || !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

let sdk = null;

function init() {
  if (sdk || !isEnabled()) return null;

  // Required lazily so the packages are never loaded when tracing is off. We
  // register only the four instrumentations this worker actually uses (http,
  // express, pg, ioredis) rather than auto-instrumentations-node — that meta
  // package pulls in dozens of unused instrumentations plus a vulnerable jaeger
  // propagator, for no benefit here.
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
  const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
  const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis');

  const serviceName = process.env.OTEL_SERVICE_NAME || 'mediaos-worker';
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const exporter = new OTLPTraceExporter(
    endpoint ? { url: `${endpoint.replace(/\/$/, '')}/v1/traces` } : {}
  );

  sdk = new NodeSDK({
    serviceName,
    traceExporter: exporter,
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });

  try {
    sdk.start();
    // eslint-disable-next-line no-console
    console.log(`OpenTelemetry tracing enabled (service=${serviceName}, endpoint=${endpoint})`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('OpenTelemetry failed to start; continuing without tracing:', err.message);
    sdk = null;
  }
  return sdk;
}

async function shutdown() {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    /* best-effort flush on exit */
  }
  sdk = null;
}

module.exports = { init, shutdown, isEnabled };
