---
name: build-auth
description: Build MediaVault Track 2 — Auth & Admin API. API key service, crypto utils, auth middleware, and admin CRUD routes.
disable-model-invocation: true
context: fork
---

# Track 2: Auth & Admin API

Read `info.md` sections 5-7 for complete specifications before writing any code. Track 1 (infra) must be complete before starting.

## Tasks

### TASK 2.1 — Key Service + Crypto Utils
Create:
- `worker/src/utils/crypto.js`
  - `sha256(input)` — returns hex digest
  - `constantTimeCompare(a, b)` — timing-safe comparison
  - `hmacSha256(secret, data)` — HMAC-SHA256 hex digest
  - `randomHex(bytes)` — crypto.randomBytes hex string

- `worker/src/services/keyService.js`
  - Key format: `mv_{mode}_{32 hex chars}` (40 chars total)
  - `generateKey(mode = 'live')` — returns `{ fullKey, prefix, hash }` where prefix = first 12 chars, hash = SHA-256
  - `validateKey(providedKey)` — lookup by prefix, constant-time compare hash, check expiry/status, return apiKeyRow or null
  - `createKey(projectId, name, scopes)` — generate key, INSERT into api_keys, return `{ key, id, name, scopes }` (full key shown ONCE)
  - `revokeKey(keyId)` — UPDATE status = 'revoked'
  - `listKeys(projectId)` — SELECT id, name, prefix, scopes, status, last_used_at (never full key)

### TASK 2.2 — Auth Middleware
Create:
- `worker/src/middleware/auth.js`
  - Factory function: `auth(requiredScope)` returns middleware
  - Extract key from X-API-Key header or Authorization: Bearer
  - Parse prefix (first 12 chars), lookup by prefix WHERE status = 'active'
  - SHA-256 hash provided key, constant-time compare with stored hash
  - Check expires_at, check scopes against requiredScope
  - Load project from projects table
  - Set `req.apiKey` and `req.project`
  - Update last_used_at fire-and-forget
  - 401 for missing key, 403 for invalid/expired/wrong scope

- `worker/src/middleware/adminAuth.js`
  - Validate against config.masterKey (constant-time compare)
  - If MASTER_KEY not set, return 503
  - 401 for missing, 403 for invalid

### TASK 2.3 — Admin Routes
Create per info.md section 6 API contracts:
- `worker/src/routes/accounts.js` — POST /api/v1/accounts (create), GET /api/v1/accounts (list with pagination)
- `worker/src/routes/projects.js` — POST/GET/GET/:id/DELETE/:id /api/v1/projects. Auto-generate slug if omitted, auto-generate signing_secret
- `worker/src/routes/apiKeys.js` — POST/GET/DELETE /api/v1/projects/:id/keys

Wire all routes into app.js with adminAuth middleware.

## Security (non-negotiable)
- API keys: SHA-256 hash stored, prefix for lookup, full key shown ONCE
- Passwords: bcrypt only (hash before INSERT)
- All secret comparisons: constant-time
- Parameterized queries only ($1, $2) — never string interpolation in SQL
- Error format: `{ "error": "message", "code": "MACHINE_CODE" }`

## Rules
- CommonJS, 2-space indent, semicolons, single quotes
- const by default, async/await everywhere
