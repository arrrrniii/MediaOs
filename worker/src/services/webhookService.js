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

async function dispatch(projectId, event, data) {
  // Get active webhooks for this project that listen to this event
  const { rows: webhooks } = await query(
    "SELECT * FROM webhooks WHERE project_id = $1 AND status = 'active' AND $2 = ANY(events)",
    [projectId, event]
  );

  for (const webhook of webhooks) {
    deliverWithRetry(webhook, event, data, projectId).catch((err) => {
      console.error(`Webhook delivery failed for ${webhook.id}:`, err.message);
    });
  }
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

async function deliverWithRetry(webhook, event, data, projectId, attempt = 1) {
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

  // Determine next retry
  const willRetry = !delivered && !permanent && attempt < MAX_ATTEMPTS;
  const nextRetryAt = willRetry ? new Date(Date.now() + RETRY_DELAYS[attempt - 1]) : null;

  // Log delivery
  await query(
    `INSERT INTO webhook_deliveries (webhook_id, event, payload, attempt, status_code, response_body, response_ms, error, delivered, next_retry_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [webhook.id, event, JSON.stringify(payload), attempt, statusCode, responseBody, responseMs, error, delivered, nextRetryAt]
  ).catch(() => {});

  // Update webhook stats
  if (delivered) {
    await query(
      `UPDATE webhooks SET last_triggered = NOW(), last_status = $1,
       success_count = success_count + 1 WHERE id = $2`,
      [statusCode, webhook.id]
    ).catch(() => {});
  } else {
    await query(
      `UPDATE webhooks SET last_triggered = NOW(), last_status = $1,
       failure_count = failure_count + 1 WHERE id = $2`,
      [statusCode, webhook.id]
    ).catch(() => {});

    // Schedule retry
    if (willRetry) {
      const timer = setTimeout(() => {
        deliverWithRetry(webhook, event, data, projectId, attempt + 1).catch(() => {});
      }, RETRY_DELAYS[attempt - 1]);
      if (timer.unref) timer.unref();
    }
  }
}

module.exports = {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  dispatch,
  deliverWithRetry,
  readCappedBody,
  validateEvents,
  WEBHOOK_EVENTS,
  MAX_RESPONSE_BYTES,
};
