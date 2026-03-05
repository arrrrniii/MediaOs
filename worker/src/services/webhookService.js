const crypto = require('crypto');
const { query } = require('../db');
const { hmacSha256 } = require('../utils/crypto');

async function createWebhook(projectId, url, events = ['file.uploaded', 'file.processed', 'file.failed', 'file.deleted']) {
  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');

  const { rows } = await query(
    `INSERT INTO webhooks (project_id, url, secret, events)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, url, secret, events, status, created_at`,
    [projectId, url, secret, events]
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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(webhook.url, {
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
    });

    clearTimeout(timeout);
    statusCode = response.status;
    responseBody = await response.text().catch(() => '');
    delivered = response.ok;
  } catch (err) {
    error = err.message;
  }

  const responseMs = Date.now() - start;

  // Determine next retry
  let nextRetryAt = null;
  if (!delivered && attempt < 3) {
    const delays = [10000, 60000]; // 10s, 60s
    nextRetryAt = new Date(Date.now() + delays[attempt - 1]);
  }

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
    if (attempt < 3) {
      const delays = [10000, 60000];
      setTimeout(() => {
        deliverWithRetry(webhook, event, data, projectId, attempt + 1);
      }, delays[attempt - 1]);
    }
  }
}

module.exports = { createWebhook, listWebhooks, deleteWebhook, dispatch };
