const crypto = require('crypto');
const { fetch: undiciFetch } = require('undici');
const { query } = require('../db');
const { hmacSha256 } = require('../utils/crypto');
const { validateWebhookUrl, resolveAndValidate, createPinnedDispatcher } = require('../utils/urlGuard');

const WEBHOOK_EVENTS = ['file.uploaded', 'file.processed', 'file.failed', 'file.deleted'];
const MAX_RESPONSE_BYTES = 4096;
const RETRY_DELAYS = [10000, 60000]; // after attempt 1, after attempt 2
const MAX_ATTEMPTS = 3;

function validationError(code, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw validationError('INVALID_WEBHOOK_EVENTS', 'events must be a non-empty array');
  }
  const seen = new Set();
  for (const event of events) {
    if (!WEBHOOK_EVENTS.includes(event)) {
      throw validationError(
        'INVALID_WEBHOOK_EVENTS',
        `Unknown event "${event}". Allowed: ${WEBHOOK_EVENTS.join(', ')}`
      );
    }
    if (seen.has(event)) {
      throw validationError('INVALID_WEBHOOK_EVENTS', `Duplicate event "${event}"`);
    }
    seen.add(event);
  }
  return events;
}

async function createWebhook(projectId, url, events) {
  validateWebhookUrl(url);
  const validEvents = validateEvents(events == null ? WEBHOOK_EVENTS : events);

  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');

  const { rows } = await query(
    `INSERT INTO webhooks (project_id, url, secret, events)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, url, secret, events, status, created_at`,
    [projectId, url, secret, validEvents]
  );

  return rows[0];
}

async function listWebhooks(projectId) {
  const { rows } = await query(
    `SELECT id, project_id, url, events, status, last_triggered, last_status,
     success_count, failure_count, created_at
     FROM webhooks WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId]
  );
  return rows;
}

async function deleteWebhook(webhookId, projectId) {
  const { rowCount } = await query(
    'DELETE FROM webhooks WHERE id = $1 AND project_id = $2',
    [webhookId, projectId]
  );
  return rowCount > 0;
}

/**
 * Fire an event. Now a thin shim over the transactional outbox: it persists
 * the event durably (emitEventStandalone) so the outbox poller can enqueue
 * the actual durable webhook-delivery jobs. Kept so any remaining direct
 * caller keeps working; new code should prefer emitting through the outbox in
 * the same transaction as the state change.
 */
async function dispatch(projectId, event, data) {
  const { emitEventStandalone } = require('./outboxService');
  const aggregateId = data && (data.id || data.file_id) ? (data.id || data.file_id) : null;
  await emitEventStandalone({
    aggregateType: 'file',
    aggregateId,
    eventType: event,
    payload: { ...data, project_id: data?.project_id || projectId },
  });
}

/**
 * Look up the active webhooks subscribed to an event for a project.
 */
async function subscribersFor(projectId, event) {
  const { rows } = await query(
    "SELECT * FROM webhooks WHERE project_id = $1 AND status = 'active' AND $2 = ANY(events)",
    [projectId, event]
  );
  return rows;
}

/** Read at most `cap` bytes of the response, then cancel the rest. */
async function readCappedBody(response, cap = MAX_RESPONSE_BYTES) {
  if (!response || !response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
  }

  return Buffer.concat(chunks).subarray(0, cap).toString('utf8');
}

/**
 * Re-check the target immediately before connecting, then pin the connection
 * to the addresses that were checked. Returns a dispatcher, or throws a typed
 * error; code 'BLOCKED_ADDRESS'/'INVALID_WEBHOOK_URL' means permanent failure.
 */
async function guardTarget(url) {
  const parsed = validateWebhookUrl(url);
  const addresses = await resolveAndValidate(parsed.hostname);
  return createPinnedDispatcher(addresses);
}

/**
 * Perform ONE delivery attempt: build+sign the payload, guard+pin the target,
 * POST it, read a capped body. Pure of retry policy — the caller (BullMQ, or
 * the legacy deliverWithRetry) decides what to do with the result.
 *
 * @returns {object} { payload, payloadStr, delivered, permanent, statusCode,
 *   responseBody, error, responseMs }. `permanent` marks a failure that must
 *   never be retried (target resolves to a non-public address).
 */
async function attemptSend(webhook, event, data, projectId) {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    project_id: projectId,
    data,
  };

  const payloadStr = JSON.stringify(payload);
  const signature = hmacSha256(webhook.secret, payloadStr);
  const deliveryId = crypto.randomUUID();

  const start = Date.now();
  let statusCode = null;
  let responseBody = null;
  let error = null;
  let delivered = false;
  let permanent = false;
  let dispatcher = null;

  try {
    dispatcher = await guardTarget(webhook.url);
  } catch (err) {
    if (err.code === 'DNS_FAILED') {
      error = err.message;
    } else {
      error = 'blocked: non-public address';
      permanent = true;
    }
  }

  if (dispatcher) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await undiciFetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-MV-Signature': signature,
            'X-MV-Event': event,
            'X-MV-Delivery-Id': deliveryId,
            'X-MV-Timestamp': String(Math.floor(Date.now() / 1000)),
            'User-Agent': 'MediaOS/1.0',
          },
          body: payloadStr,
          signal: controller.signal,
          redirect: 'manual',
          dispatcher,
        });

        statusCode = response.status;
        responseBody = await readCappedBody(response).catch(() => '');

        if (statusCode >= 300 && statusCode < 400) {
          // Following the redirect would re-open the SSRF hole the pinning closes.
          error = `redirect not followed (status ${statusCode})`;
        } else {
          delivered = response.ok;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      error = err.message;
    } finally {
      if (dispatcher.close) dispatcher.close().catch(() => {});
    }
  }

  const responseMs = Date.now() - start;
  return { payload, payloadStr, delivered, permanent, statusCode, responseBody, error, responseMs };
}

/**
 * Log a webhook_deliveries row and bump the webhook's success/failure stats.
 */
async function logDelivery(webhook, event, result, attempt, nextRetryAt) {
  const { payload, statusCode, responseBody, responseMs, error, delivered } = result;

  await query(
    `INSERT INTO webhook_deliveries (webhook_id, event, payload, attempt, status_code, response_body, response_ms, error, delivered, next_retry_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [webhook.id, event, JSON.stringify(payload), attempt, statusCode, responseBody, responseMs, error, delivered, nextRetryAt]
  ).catch(() => {});

  const statsCol = delivered ? 'success_count' : 'failure_count';
  await query(
    `UPDATE webhooks SET last_triggered = NOW(), last_status = $1,
     ${statsCol} = ${statsCol} + 1 WHERE id = $2`,
    [statusCode, webhook.id]
  ).catch(() => {});
}

/**
 * Deliver a webhook exactly once and record it. This is the unit BullMQ's
 * WEBHOOK worker runs; BullMQ owns retries, backoff, and the dead-letter set,
 * so there is no self-scheduled retry here. next_retry_at is left NULL — the
 * live retry schedule lives in Redis, not this log row.
 *
 * @param {number} [attempt] the BullMQ attempt number, for the log.
 * @returns {object} { delivered, permanent, statusCode, error }
 */
async function deliverOnce(webhook, event, data, projectId, attempt = 1) {
  const result = await attemptSend(webhook, event, data, projectId);
  await logDelivery(webhook, event, result, attempt, null);
  return {
    delivered: result.delivered,
    permanent: result.permanent,
    statusCode: result.statusCode,
    error: result.error,
  };
}

/**
 * Legacy single-shot delivery that also computes a next_retry_at for the log
 * (BullMQ now owns the actual retry scheduling, so no timer is armed). Kept
 * for backward compatibility and unit coverage.
 */
async function deliverWithRetry(webhook, event, data, projectId, attempt = 1) {
  const result = await attemptSend(webhook, event, data, projectId);
  const willRetry = !result.delivered && !result.permanent && attempt < MAX_ATTEMPTS;
  const nextRetryAt = willRetry ? new Date(Date.now() + RETRY_DELAYS[attempt - 1]) : null;
  await logDelivery(webhook, event, result, attempt, nextRetryAt);
}

module.exports = {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  dispatch,
  subscribersFor,
  attemptSend,
  deliverOnce,
  deliverWithRetry,
  readCappedBody,
  validateEvents,
  WEBHOOK_EVENTS,
  MAX_RESPONSE_BYTES,
};
