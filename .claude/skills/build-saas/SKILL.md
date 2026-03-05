---
name: build-saas
description: Build MediaVault Track 4 — SaaS Features. Signed URLs, webhooks, usage tracking, rate limiting, and bulk upload.
disable-model-invocation: true
context: fork
---

# Track 4: SaaS Features

Read `info.md` sections 9-12 for complete specifications. Tracks 2 and 3 must be complete.

## Tasks

### TASK 4.1 — Signed URLs
Create:
- `worker/src/services/signedUrl.js`
  - `generate(project, storageKey, expiresIn)` — HMAC-SHA256 signature, return URL with token + expires params
  - Payload: `"{project_id}/{key}:{expires_timestamp}"`
  - Signature: `HMAC-SHA256(project.signing_secret, payload)` as hex
  - `validate(project, storageKey, token, expires)` — Recompute HMAC, constant-time compare, check expiry

- Add GET /api/v1/files/:id/signed-url endpoint (scope: read)
- Update serve.js to check signatures for private/signed files

### TASK 4.2 — Webhook System
Create:
- `worker/src/services/webhookService.js`
  - `dispatch(projectId, event, data)` — Find active webhooks for project+event, POST with HMAC signature
  - Headers: Content-Type, X-MV-Signature, X-MV-Event, X-MV-Delivery-Id, X-MV-Timestamp, User-Agent: MediaVault/1.0
  - Retry: 3 attempts (immediate, +10s, +60s), log each in webhook_deliveries
  - Update webhook stats (last_triggered, last_status, success/failure counts)

- `worker/src/routes/webhooks.js`
  - POST /api/v1/webhooks — auth('admin'), create webhook, auto-generate secret, show ONCE
  - GET /api/v1/webhooks — auth('admin'), list
  - DELETE /api/v1/webhooks/:id — auth('admin'), delete

- Hook into fileService: file.uploaded, file.processed, file.failed, file.deleted

### TASK 4.3 — Usage Tracking
Create:
- `worker/src/services/usageService.js`
  - `trackUpload(projectId, originalSize)` — Increment usage_daily.uploads + upload_bytes
  - `trackDownload(projectId, fileId, bytesServed)` — Increment downloads + download_bytes, INSERT bandwidth_log
  - `trackTransform(projectId, fileId, bytesServed)` — Increment transforms, INSERT bandwidth_log with is_transform=true
  - `trackDelete(projectId)` — Increment deletes
  - `trackApiRequest(projectId)` — Increment api_requests
  - Buffered bandwidth_log inserts: in-memory buffer, flush every 5s or 100 entries
  - `getCurrentUsage(projectId)` — Current month aggregation + plan limits
  - `getUsageHistory(projectId, days)` — Daily breakdown

- `worker/src/routes/usage.js`
  - GET /api/v1/usage — auth('read'), current period usage with plan limits
  - GET /api/v1/usage/history — auth('read'), daily history

- Hook into: upload, serve, resize, delete flows (all fire-and-forget)

### TASK 4.4 — Rate Limiting
Create:
- `worker/src/middleware/rateLimit.js`
  - Sliding window counter per API key using Redis
  - Key: `ratelimit:{api_key_id}:{minute_bucket}`, TTL: 120s
  - Fallback: in-memory Map with periodic cleanup (no Redis)
  - Response headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
  - 429 response: `{ "error": "Rate limit exceeded", "retry_after": N }`

### TASK 4.5 — Bulk Upload
Update `worker/src/routes/upload.js`:
- POST /api/v1/upload/bulk — multer.array('files', 20), auth('upload')
- Process each file, collect results
- Response: `{ "uploaded": N, "failed": N, "files": [...], "errors": [...] }`

## Rules
- All tracking updates are fire-and-forget (never block the response)
- Use ON CONFLICT for usage_daily upserts
- CommonJS, 2-space indent, semicolons, single quotes
