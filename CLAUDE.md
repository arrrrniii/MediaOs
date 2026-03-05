# MediaOS - CDN Platform

## What Is This

MediaOS is a self-hosted multi-tenant media CDN platform. It handles file uploads (images, videos, audio, documents), processes them (WebP conversion, video transcoding), stores them in MinIO, and serves them via Express with imgproxy for dynamic resizing.

**The complete architecture spec lives in `info.md` — that is the single source of truth.**

## Stack

- **API Worker:** Node.js 20, Express 4, CommonJS (no TypeScript)
- **Dashboard:** Next.js 15, TypeScript, Tailwind CSS, shadcn/ui
- **SDK:** TypeScript npm package (`@mediaos/sdk`)
- **Database:** PostgreSQL 16 (pg driver, raw SQL, no ORM)
- **Storage:** MinIO (S3-compatible)
- **Image Resizing:** imgproxy (dedicated service)
- **Cache/Rate Limiting:** Redis 7
- **Deployment:** Docker Compose

## Project Structure

```
mediaos/
├── worker/          # Express API (Node.js, CommonJS)
├── dashboard/       # Next.js 15 admin panel (TypeScript)
├── sdk/             # TypeScript SDK package
├── docker-compose.yml
├── .env.example
└── info.md          # Full architecture spec
```

## Code Conventions

### Worker (JavaScript)
- CommonJS (`require`/`module.exports`) — NO TypeScript, NO ESM
- 2-space indentation, semicolons, single quotes
- `const` by default, `let` when needed, never `var`
- async/await everywhere — no callbacks, no `.then` chains
- All env vars read in `src/config.js`, nowhere else
- Queries use parameterized `$1, $2` — never string interpolation
- Error responses: `{ "error": "message", "code": "MACHINE_CODE" }`

### Dashboard (TypeScript)
- Next.js 15 App Router, strict TypeScript
- Tailwind CSS only (no CSS modules, no styled-components)
- shadcn/ui as component base
- Server components by default, `"use client"` only when needed
- Dark-mode first design (Vercel/Linear aesthetic)

### Database
- UUID primary keys everywhere (`gen_random_uuid()`)
- `created_at` + `updated_at` on all tables (auto-trigger)
- Soft deletes via `deleted_at` column
- Raw SQL migrations in `worker/migrations/` — no ORM

### Security (non-negotiable)
- API keys: SHA-256 hash stored, prefix for lookup, full key shown once
- Passwords: bcrypt only
- All comparisons: constant-time
- File paths: sanitized, no traversal
- Rate limiting on all authenticated endpoints
- HMAC-SHA256 for webhook signatures and signed URLs

## Agent Tracks

Work is organized into 6 parallel tracks. See `info.md` section 15 for full task breakdown.

| Track | Scope | Directory |
|-------|-------|-----------|
| 1. Infrastructure | Docker, migrations, worker scaffold | root, `worker/` |
| 2. Auth & Admin API | Keys, auth middleware, admin routes | `worker/src/` |
| 3. File Processing | Upload, process, serve, list/delete | `worker/src/` |
| 4. SaaS Features | Signed URLs, webhooks, usage, rate limits | `worker/src/` |
| 5. Dashboard | Next.js admin panel | `dashboard/` |
| 6. SDK | TypeScript client library | `sdk/` |

## Key Patterns

- **File processing:** Images are sync (Sharp -> WebP), videos are async (FFmpeg, return 202)
- **Storage keys:** `{project_id}/{folder}/{slug}-{nanoid6}.{ext}`
- **API key format:** `mv_live_<32hex>` or `mv_test_<32hex>`, prefix = first 12 chars
- **Auth flow:** Extract key -> lookup by prefix -> SHA-256 compare -> check scope -> load project
- **Usage tracking:** Fire-and-forget async INSERTs, never block response
- **Queue:** Bounded concurrency in-memory, optional Redis persistence

## Commands

```bash
# Start all services
docker compose up -d

# Worker dev
cd worker && npm run dev

# Dashboard dev
cd dashboard && npm run dev

# Run migrations manually
cd worker && node migrations/migrate.js
```
