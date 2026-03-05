# MediaOS — CDN Platform Architecture & Build Spec

> **Purpose:** This document is the complete architecture specification for building MediaOS, a self-hosted multi-tenant media CDN platform. It contains every schema, API contract, file structure, module boundary, and implementation detail needed to build the entire project. Claude Code agents should reference this document as the single source of truth.

> **Stack:** Express 4 + PostgreSQL 16 + MinIO + imgproxy + Redis 7 + Next.js 15 (dashboard)
> **Language:** Node.js 20 (worker), TypeScript (dashboard + SDK)
> **Deployment:** Docker Compose, single `docker compose up -d`

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Docker Compose Stack](#2-docker-compose-stack)
3. [Environment Variables](#3-environment-variables)
4. [PostgreSQL Schema & Migrations](#4-postgresql-schema--migrations)
5. [API Worker — Module Architecture](#5-api-worker--module-architecture)
6. [API Contracts — Full Endpoint Spec](#6-api-contracts--full-endpoint-spec)
7. [Auth System](#7-auth-system)
8. [File Processing Pipeline](#8-file-processing-pipeline)
9. [File Serving & Signed URLs](#9-file-serving--signed-urls)
10. [Webhook System](#10-webhook-system)
11. [Usage Tracking](#11-usage-tracking)
12. [Rate Limiting](#12-rate-limiting)
13. [Dashboard (Next.js)](#13-dashboard-nextjs)
14. [TypeScript SDK](#14-typescript-sdk)
15. [Agent Task Breakdown](#15-agent-task-breakdown)
16. [Conventions & Rules](#16-conventions--rules)

---

## 1. Project Structure

```
mediaos/
├── docker-compose.yml
├── .env.example
├── .gitignore
├── README.md
├── LICENSE
│
├── worker/                          # Express API worker
│   ├── Dockerfile
│   ├── package.json
│   ├── .eslintrc.json
│   ├── src/
│   │   ├── index.js                 # Entry point — bootstrap & start
│   │   ├── config.js                # All env vars, defaults, validation
│   │   ├── db.js                    # pg Pool singleton + query helper
│   │   ├── minio.js                 # MinIO client singleton + helpers
│   │   ├── app.js                   # Express app factory (no listen)
│   │   │
│   │   ├── middleware/
│   │   │   ├── auth.js              # API key auth → req.project
│   │   │   ├── adminAuth.js         # Master key auth for admin routes
│   │   │   ├── rateLimit.js         # Per-key rate limiting
│   │   │   ├── errorHandler.js      # Global error handler
│   │   │   └── cors.js              # CORS configuration
│   │   │
│   │   ├── routes/
│   │   │   ├── health.js            # GET /health
│   │   │   ├── upload.js            # POST /api/v1/upload, POST /api/v1/upload/bulk
│   │   │   ├── files.js             # GET/DELETE /api/v1/files, GET /api/v1/files/:id
│   │   │   ├── serve.js             # GET /f/:projectId/*, GET /img/*
│   │   │   ├── accounts.js          # POST /api/v1/accounts (admin)
│   │   │   ├── projects.js          # CRUD /api/v1/projects (admin)
│   │   │   ├── apiKeys.js           # CRUD /api/v1/projects/:id/keys (admin)
│   │   │   ├── webhooks.js          # CRUD /api/v1/webhooks
│   │   │   └── usage.js             # GET /api/v1/usage
│   │   │
│   │   ├── services/
│   │   │   ├── imageProcessor.js    # Sharp: resize + WebP conversion
│   │   │   ├── videoProcessor.js    # FFmpeg: transcode + thumbnail
│   │   │   ├── fileService.js       # Upload orchestration, DB writes
│   │   │   ├── keyService.js        # API key generation, hashing, validation
│   │   │   ├── webhookService.js    # Dispatch webhooks with HMAC + retry
│   │   │   ├── usageService.js      # Track + query usage metrics
│   │   │   ├── signedUrl.js         # Generate + validate signed URLs
│   │   │   └── queue.js             # Bounded concurrency job queue
│   │   │
│   │   └── utils/
│   │       ├── slugify.js           # Filename normalization
│   │       ├── mimeTypes.js         # Extension → MIME mapping
│   │       ├── fileTypes.js         # Extension → type classification
│   │       └── crypto.js            # HMAC, hash, constant-time compare
│   │
│   └── migrations/
│       ├── 001_initial_schema.sql
│       ├── 002_usage_tracking.sql
│       ├── 003_webhooks.sql
│       └── migrate.js               # Simple migration runner
│
├── dashboard/                       # Next.js 15 admin panel
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── tailwind.config.ts
│   ├── next.config.ts
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx             # Redirect to /dashboard or /login
│   │   │   ├── login/
│   │   │   │   └── page.tsx
│   │   │   ├── dashboard/
│   │   │   │   ├── layout.tsx       # Sidebar + auth check
│   │   │   │   ├── page.tsx         # Overview: storage, bandwidth, recent uploads
│   │   │   │   ├── projects/
│   │   │   │   │   ├── page.tsx             # List projects
│   │   │   │   │   └── [id]/
│   │   │   │   │       ├── page.tsx         # Project detail
│   │   │   │   │       ├── files/
│   │   │   │   │       │   └── page.tsx     # File browser
│   │   │   │   │       ├── keys/
│   │   │   │   │       │   └── page.tsx     # API key management
│   │   │   │   │       ├── webhooks/
│   │   │   │   │       │   └── page.tsx     # Webhook config
│   │   │   │   │       ├── usage/
│   │   │   │   │       │   └── page.tsx     # Usage charts
│   │   │   │   │       └── settings/
│   │   │   │   │           └── page.tsx     # Project settings
│   │   │   │   └── account/
│   │   │   │       └── page.tsx     # Account settings
│   │   │   └── api/
│   │   │       └── auth/
│   │   │           └── [...nextauth]/
│   │   │               └── route.ts # NextAuth session management
│   │   │
│   │   ├── components/
│   │   │   ├── ui/                  # Reusable: Button, Input, Card, Modal, Badge, etc.
│   │   │   ├── layout/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── Header.tsx
│   │   │   │   └── ProjectSwitcher.tsx
│   │   │   ├── files/
│   │   │   │   ├── FileGrid.tsx
│   │   │   │   ├── FileList.tsx
│   │   │   │   ├── FilePreview.tsx
│   │   │   │   ├── UploadDropzone.tsx
│   │   │   │   └── FileActions.tsx
│   │   │   ├── projects/
│   │   │   │   ├── ProjectCard.tsx
│   │   │   │   ├── CreateProjectModal.tsx
│   │   │   │   └── ProjectSettings.tsx
│   │   │   ├── keys/
│   │   │   │   ├── KeyList.tsx
│   │   │   │   └── CreateKeyModal.tsx
│   │   │   ├── usage/
│   │   │   │   ├── UsageChart.tsx
│   │   │   │   ├── StorageBar.tsx
│   │   │   │   └── BandwidthChart.tsx
│   │   │   └── webhooks/
│   │   │       ├── WebhookList.tsx
│   │   │       └── WebhookForm.tsx
│   │   │
│   │   └── lib/
│   │       ├── api.ts               # Fetch wrapper for worker API
│   │       ├── auth.ts              # NextAuth config
│   │       ├── utils.ts             # Format bytes, dates, etc.
│   │       └── types.ts             # Shared TypeScript types
│   │
│   └── public/
│       └── favicon.ico
│
└── sdk/                             # TypeScript SDK (npm package)
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts                 # Main export: MediaOS class
    │   ├── client.ts                # HTTP client with auth
    │   ├── upload.ts                # Upload methods
    │   ├── files.ts                 # File operations
    │   ├── url.ts                   # URL builder helpers
    │   └── types.ts                 # TypeScript interfaces
    └── README.md
```

---

## 2. Docker Compose Stack

**File: `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: mv-postgres
    environment:
      POSTGRES_DB: ${PG_DATABASE:-mediaos}
      POSTGRES_USER: ${PG_USER:-mediaos}
      POSTGRES_PASSWORD: ${PG_PASSWORD:-changeme_pg_password}
    ports:
      - "${PG_PORT:-5432}:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${PG_USER:-mediaos}"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped
    networks:
      - mediaos

  minio:
    image: minio/minio:latest
    container_name: mv-minio
    command: server /data --console-address ":9001"
    ports:
      - "${MINIO_CONSOLE_PORT:-9001}:9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-mvadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-changeme_minio_password}
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    networks:
      - mediaos

  redis:
    image: redis:7-alpine
    container_name: mv-redis
    command: redis-server --requirepass ${REDIS_PASSWORD:-changeme_redis_password}
    ports:
      - "${REDIS_PORT:-6379}:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD:-changeme_redis_password}", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped
    networks:
      - mediaos

  imgproxy:
    image: darthsim/imgproxy:latest
    container_name: mv-imgproxy
    environment:
      IMGPROXY_USE_S3: "true"
      IMGPROXY_S3_ENDPOINT: http://minio:9000
      AWS_ACCESS_KEY_ID: ${MINIO_ROOT_USER:-mvadmin}
      AWS_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:-changeme_minio_password}
      AWS_REGION: us-east-1
      IMGPROXY_PREFERRED_FORMATS: webp
      IMGPROXY_ENFORCE_WEBP: "true"
      IMGPROXY_QUALITY: ${WEBP_QUALITY:-80}
      IMGPROXY_WEBP_QUALITY: ${WEBP_QUALITY:-80}
      IMGPROXY_MAX_SRC_RESOLUTION: 50
      IMGPROXY_CONCURRENCY: 10
      IMGPROXY_SET_CACHE_CONTROL: "public, max-age=31536000"
      IMGPROXY_ALLOW_ORIGIN: "*"
    depends_on:
      minio:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - mediaos

  worker:
    build: ./worker
    container_name: mv-worker
    ports:
      - "${API_PORT:-3000}:3000"
    environment:
      NODE_ENV: ${NODE_ENV:-production}
      PORT: 3000
      # Postgres
      PG_HOST: postgres
      PG_PORT: 5432
      PG_DATABASE: ${PG_DATABASE:-mediaos}
      PG_USER: ${PG_USER:-mediaos}
      PG_PASSWORD: ${PG_PASSWORD:-changeme_pg_password}
      # MinIO
      MINIO_ENDPOINT: minio
      MINIO_PORT: 9000
      MINIO_USE_SSL: "false"
      MINIO_ACCESS_KEY: ${MINIO_ROOT_USER:-mvadmin}
      MINIO_SECRET_KEY: ${MINIO_ROOT_PASSWORD:-changeme_minio_password}
      MINIO_BUCKET: ${MINIO_BUCKET:-mediaos}
      # imgproxy
      IMGPROXY_URL: http://imgproxy:8080
      # Redis
      REDIS_URL: redis://:${REDIS_PASSWORD:-changeme_redis_password}@redis:6379
      # App
      PUBLIC_URL: ${PUBLIC_URL:-http://localhost:3000}
      MASTER_KEY: ${MASTER_KEY:-}
      # Processing
      WEBP_QUALITY: ${WEBP_QUALITY:-80}
      MAX_WIDTH: ${MAX_WIDTH:-1600}
      MAX_HEIGHT: ${MAX_HEIGHT:-1600}
      VIDEO_CRF: ${VIDEO_CRF:-20}
      VIDEO_MAX_HEIGHT: ${VIDEO_MAX_HEIGHT:-1080}
      MAX_FILE_SIZE: ${MAX_FILE_SIZE:-104857600}
      CONCURRENCY: ${CONCURRENCY:-3}
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - mediaos

  dashboard:
    build: ./dashboard
    container_name: mv-dashboard
    ports:
      - "${DASHBOARD_PORT:-3001}:3000"
    environment:
      NEXT_PUBLIC_API_URL: ${PUBLIC_URL:-http://localhost:3000}
      INTERNAL_API_URL: http://worker:3000
      NEXTAUTH_URL: ${DASHBOARD_URL:-http://localhost:3001}
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET:-changeme_nextauth_secret}
      PG_HOST: postgres
      PG_PORT: 5432
      PG_DATABASE: ${PG_DATABASE:-mediaos}
      PG_USER: ${PG_USER:-mediaos}
      PG_PASSWORD: ${PG_PASSWORD:-changeme_pg_password}
    depends_on:
      - worker
    restart: unless-stopped
    networks:
      - mediaos

volumes:
  pg_data:
  minio_data:
  redis_data:

networks:
  mediaos:
    driver: bridge
```

---

## 3. Environment Variables

**File: `.env.example`**

```bash
# ═══════════════════════════════════════
#  MediaOS Configuration
# ═══════════════════════════════════════

# ── PostgreSQL ──────────────────────
PG_DATABASE=mediaos
PG_USER=mediaos
PG_PASSWORD=changeme_pg_password
PG_PORT=5432

# ── MinIO ───────────────────────────
MINIO_ROOT_USER=mvadmin
MINIO_ROOT_PASSWORD=changeme_minio_password
MINIO_BUCKET=mediaos
MINIO_CONSOLE_PORT=9001

# ── Redis ───────────────────────────
REDIS_PASSWORD=changeme_redis_password
REDIS_PORT=6379

# ── API Worker ──────────────────────
API_PORT=3000
PUBLIC_URL=http://localhost:3000
NODE_ENV=production

# Master admin key — REQUIRED for account/project management
# Generate with: node -e "console.log('mv_master_' + require('crypto').randomBytes(24).toString('hex'))"
MASTER_KEY=mv_master_your_secret_here

# ── Image Processing ────────────────
WEBP_QUALITY=80
MAX_WIDTH=1600
MAX_HEIGHT=1600

# ── Video Processing ────────────────
VIDEO_CRF=20
VIDEO_MAX_HEIGHT=1080
CONCURRENCY=3

# ── Limits ──────────────────────────
MAX_FILE_SIZE=104857600   # 100MB

# ── Dashboard ───────────────────────
DASHBOARD_PORT=3001
DASHBOARD_URL=http://localhost:3001
NEXTAUTH_SECRET=changeme_nextauth_secret
```

---

## 4. PostgreSQL Schema & Migrations

### Migration 001: Initial Schema

**File: `worker/migrations/001_initial_schema.sql`**

```sql
-- ═══════════════════════════════════════════════════════════
--  MediaOS — Initial Schema
-- ═══════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Accounts ────────────────────────────────────────────
-- An account is the top-level entity (a paying customer, org, or individual)
CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255),                          -- bcrypt hash, nullable for API-only accounts
    plan            VARCHAR(50) NOT NULL DEFAULT 'free',   -- free, pro, business, enterprise
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active, suspended, deleted
    metadata        JSONB DEFAULT '{}',                    -- extensible: company, address, etc.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_email ON accounts(email);
CREATE INDEX idx_accounts_status ON accounts(status);

-- ── Projects ────────────────────────────────────────────
-- Each account can have multiple projects (e.g. staging, production, mobile)
CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(100) NOT NULL,                 -- URL-safe identifier
    description     TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active, paused, deleted
    signing_secret  VARCHAR(64) NOT NULL,                  -- for signed URLs, auto-generated
    settings        JSONB DEFAULT '{                        
        "max_file_size": 104857600,
        "allowed_types": ["image", "video", "file"],
        "webp_quality": 80,
        "max_width": 1600,
        "max_height": 1600,
        "default_access": "public"
    }',
    storage_used    BIGINT NOT NULL DEFAULT 0,             -- bytes, updated on upload/delete
    file_count      INTEGER NOT NULL DEFAULT 0,            -- updated on upload/delete
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_projects_account_slug ON projects(account_id, slug);
CREATE INDEX idx_projects_account_id ON projects(account_id);
CREATE INDEX idx_projects_status ON projects(status);

-- ── API Keys ────────────────────────────────────────────
-- Multiple keys per project with granular scopes
CREATE TABLE api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL DEFAULT 'Default Key',
    -- Key format: mv_live_xxxxxxxxxxxx or mv_test_xxxxxxxxxxxx
    -- We store prefix (first 12 chars) in plaintext for lookup
    -- Full key is hashed with SHA-256 for validation
    key_prefix      VARCHAR(20) NOT NULL,                  -- "mv_live_abc1" — for fast lookup
    key_hash        VARCHAR(64) NOT NULL,                  -- SHA-256 of full key
    scopes          TEXT[] NOT NULL DEFAULT '{upload,read}', -- upload, read, delete, admin
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active, revoked
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,                           -- null = no expiry
    rate_limit      INTEGER DEFAULT 100,                   -- requests per minute
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX idx_api_keys_project_id ON api_keys(project_id);
CREATE INDEX idx_api_keys_status ON api_keys(status);

-- ── Files ───────────────────────────────────────────────
-- Every uploaded file is tracked with full metadata
CREATE TABLE files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Storage info
    storage_key     VARCHAR(500) NOT NULL,                 -- full MinIO key: {project_id}/{folder}/{slug}.ext
    filename        VARCHAR(255) NOT NULL,                 -- display name: hero-banner-a8x3k2.webp
    original_name   VARCHAR(500),                          -- what the user uploaded: "My Photo.JPG"
    folder          VARCHAR(255),                          -- optional subfolder
    -- File info
    type            VARCHAR(20) NOT NULL,                  -- image, video, file
    mime_type       VARCHAR(100) NOT NULL,
    size            BIGINT NOT NULL,                       -- final size in bytes
    original_size   BIGINT,                                -- pre-processing size
    -- Image metadata
    width           INTEGER,
    height          INTEGER,
    -- Video metadata
    duration        REAL,                                  -- seconds
    thumbnail_key   VARCHAR(500),                          -- thumbnail storage key
    -- Processing
    status          VARCHAR(20) NOT NULL DEFAULT 'done',   -- uploading, processing, done, failed
    processing_ms   INTEGER,                               -- time taken in ms
    error_message   TEXT,                                  -- if failed
    -- Access control
    access          VARCHAR(20) NOT NULL DEFAULT 'public', -- public, private, signed
    -- Metadata
    metadata        JSONB DEFAULT '{}',                    -- extensible: alt text, tags, etc.
    uploaded_by     UUID REFERENCES api_keys(id),          -- which key uploaded this
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ                            -- soft delete
);

CREATE INDEX idx_files_project_id ON files(project_id);
CREATE INDEX idx_files_storage_key ON files(storage_key);
CREATE INDEX idx_files_project_folder ON files(project_id, folder);
CREATE INDEX idx_files_project_type ON files(project_id, type);
CREATE INDEX idx_files_status ON files(status);
CREATE INDEX idx_files_created_at ON files(project_id, created_at DESC);
CREATE INDEX idx_files_deleted_at ON files(deleted_at) WHERE deleted_at IS NULL;

-- ── Updated_at trigger ──────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_api_keys_updated_at BEFORE UPDATE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_files_updated_at BEFORE UPDATE ON files
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### Migration 002: Usage Tracking

**File: `worker/migrations/002_usage_tracking.sql`**

```sql
-- ═══════════════════════════════════════════════════════════
--  Usage Tracking
-- ═══════════════════════════════════════════════════════════

-- Daily usage aggregation per project
CREATE TABLE usage_daily (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    date            DATE NOT NULL,
    -- Counters
    uploads         INTEGER NOT NULL DEFAULT 0,
    upload_bytes    BIGINT NOT NULL DEFAULT 0,             -- total bytes uploaded (original)
    downloads       INTEGER NOT NULL DEFAULT 0,
    download_bytes  BIGINT NOT NULL DEFAULT 0,             -- total bytes served
    transforms      INTEGER NOT NULL DEFAULT 0,            -- imgproxy resize requests
    deletes         INTEGER NOT NULL DEFAULT 0,
    api_requests    INTEGER NOT NULL DEFAULT 0,            -- total API calls
    -- Snapshot
    storage_bytes   BIGINT NOT NULL DEFAULT 0,             -- storage snapshot at end of day
    file_count      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_usage_daily_project_date ON usage_daily(project_id, date);
CREATE INDEX idx_usage_daily_date ON usage_daily(date);

-- Bandwidth log — individual serve events for accurate bandwidth tracking
-- This table is append-only, partitioned by month in production
CREATE TABLE bandwidth_log (
    id              BIGSERIAL PRIMARY KEY,
    project_id      UUID NOT NULL,
    file_id         UUID,
    bytes_served    BIGINT NOT NULL,
    is_transform    BOOLEAN NOT NULL DEFAULT FALSE,        -- was this an imgproxy resize?
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bandwidth_log_project_created ON bandwidth_log(project_id, created_at);

-- Plan limits reference table
CREATE TABLE plans (
    id              VARCHAR(50) PRIMARY KEY,               -- free, pro, business, enterprise
    name            VARCHAR(100) NOT NULL,
    max_projects    INTEGER NOT NULL DEFAULT 1,
    max_storage     BIGINT NOT NULL DEFAULT 1073741824,    -- bytes (default 1GB)
    max_bandwidth   BIGINT NOT NULL DEFAULT 5368709120,    -- bytes/month (default 5GB)
    max_file_size   INTEGER NOT NULL DEFAULT 10485760,     -- bytes per file (default 10MB)
    rate_limit      INTEGER NOT NULL DEFAULT 100,          -- requests/min per key
    max_keys        INTEGER NOT NULL DEFAULT 2,            -- API keys per project
    features        JSONB DEFAULT '{}',                    -- webhooks, signed_urls, bulk_upload, etc.
    price_monthly   INTEGER NOT NULL DEFAULT 0,            -- cents
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default plans
INSERT INTO plans (id, name, max_projects, max_storage, max_bandwidth, max_file_size, rate_limit, max_keys, features, price_monthly) VALUES
    ('free',       'Free',       1,   1073741824,    5368709120,    10485760,   60,   2,   '{"webhooks": false, "signed_urls": false, "bulk_upload": false}', 0),
    ('pro',        'Pro',        5,   53687091200,   107374182400,  104857600,  200,  10,  '{"webhooks": true, "signed_urls": true, "bulk_upload": true}',    1900),
    ('business',   'Business',   -1,  268435456000,  536870912000,  524288000,  500,  50,  '{"webhooks": true, "signed_urls": true, "bulk_upload": true}',    4900),
    ('enterprise', 'Enterprise', -1,  -1,            -1,            -1,         -1,   -1,  '{"webhooks": true, "signed_urls": true, "bulk_upload": true}',    0);
-- Note: -1 means unlimited
```

### Migration 003: Webhooks

**File: `worker/migrations/003_webhooks.sql`**

```sql
-- ═══════════════════════════════════════════════════════════
--  Webhooks
-- ═══════════════════════════════════════════════════════════

CREATE TABLE webhooks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url             VARCHAR(2000) NOT NULL,
    secret          VARCHAR(64) NOT NULL,                  -- for HMAC-SHA256 signing
    events          TEXT[] NOT NULL DEFAULT '{file.uploaded,file.processed,file.failed,file.deleted}',
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active, paused, disabled
    -- Delivery stats
    last_triggered  TIMESTAMPTZ,
    last_status     INTEGER,                               -- HTTP status of last delivery
    success_count   INTEGER NOT NULL DEFAULT 0,
    failure_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_project_id ON webhooks(project_id);
CREATE INDEX idx_webhooks_status ON webhooks(status);

-- Webhook delivery log — for debugging and retry
CREATE TABLE webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id      UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event           VARCHAR(50) NOT NULL,
    payload         JSONB NOT NULL,
    -- Delivery attempt info
    attempt         INTEGER NOT NULL DEFAULT 1,
    status_code     INTEGER,
    response_body   TEXT,
    response_ms     INTEGER,
    error           TEXT,
    -- Status
    delivered       BOOLEAN NOT NULL DEFAULT FALSE,
    next_retry_at   TIMESTAMPTZ,                           -- null if delivered or max retries reached
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at)
    WHERE delivered = FALSE AND next_retry_at IS NOT NULL;

CREATE TRIGGER trg_webhooks_updated_at BEFORE UPDATE ON webhooks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### Migration Runner

**File: `worker/migrations/migrate.js`**

```javascript
/**
 * Simple migration runner.
 * Reads SQL files in order from migrations/ directory.
 * Tracks applied migrations in a `_migrations` table.
 *
 * Usage: node migrations/migrate.js
 * Called automatically on worker startup.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function migrate(pool) {
  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Get applied migrations
  const { rows: applied } = await pool.query(
    "SELECT name FROM _migrations ORDER BY id"
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  // Read migration files
  const dir = path.join(__dirname);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    console.log(`⬆️  Applying migration: ${file}`);
    const sql = fs.readFileSync(path.join(dir, file), "utf8");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`✅ Applied: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`❌ Migration failed: ${file}`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log("✅ All migrations applied");
}

module.exports = { migrate };
```

---

## 5. API Worker — Module Architecture

### config.js

```javascript
/**
 * Central configuration. All env vars read here, nowhere else.
 * Validates required vars on startup and exports frozen config object.
 */
module.exports = {
  port: parseInt(process.env.PORT || "3000"),
  nodeEnv: process.env.NODE_ENV || "development",

  pg: {
    host: process.env.PG_HOST || "localhost",
    port: parseInt(process.env.PG_PORT || "5432"),
    database: process.env.PG_DATABASE || "mediaos",
    user: process.env.PG_USER || "mediaos",
    password: process.env.PG_PASSWORD || "",
  },

  minio: {
    endPoint: process.env.MINIO_ENDPOINT || "localhost",
    port: parseInt(process.env.MINIO_PORT || "9000"),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY || "mvadmin",
    secretKey: process.env.MINIO_SECRET_KEY || "",
  },
  bucket: process.env.MINIO_BUCKET || "mediaos",

  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },

  imgproxyUrl: process.env.IMGPROXY_URL || "http://localhost:8080",
  publicUrl: (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, ""),
  masterKey: process.env.MASTER_KEY || "",

  // Processing
  webpQuality: parseInt(process.env.WEBP_QUALITY || "80"),
  maxWidth: parseInt(process.env.MAX_WIDTH || "1600"),
  maxHeight: parseInt(process.env.MAX_HEIGHT || "1600"),
  videoCrf: process.env.VIDEO_CRF || "20",
  videoMaxHeight: parseInt(process.env.VIDEO_MAX_HEIGHT || "1080"),
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || "104857600"),
  concurrency: parseInt(process.env.CONCURRENCY || "3"),
};
```

### index.js (entry point)

```javascript
/**
 * Entry point. Boots in this order:
 * 1. Validate config
 * 2. Connect to PostgreSQL
 * 3. Run migrations
 * 4. Connect to MinIO, ensure bucket exists
 * 5. Connect to Redis (optional, graceful fallback)
 * 6. Create Express app
 * 7. Start listening
 */
```

### Middleware: auth.js

```javascript
/**
 * Project API key authentication middleware.
 *
 * Reads key from:
 *   - X-API-Key header
 *   - Authorization: Bearer <key>
 *
 * Flow:
 * 1. Extract key from request
 * 2. Parse prefix (first 12 chars)
 * 3. Look up api_keys row by prefix WHERE status = 'active'
 * 4. SHA-256 hash the provided key
 * 5. Constant-time compare with stored hash
 * 6. Check expiry
 * 7. Check scopes against required scope (passed as middleware param)
 * 8. Load project from projects table
 * 9. Set req.apiKey = { id, scopes, ... }
 * 10. Set req.project = { id, slug, settings, ... }
 * 11. Update last_used_at (fire-and-forget, no await)
 *
 * Usage in routes:
 *   router.post("/upload", auth("upload"), uploadHandler);
 *   router.get("/files", auth("read"), listHandler);
 *   router.delete("/files/:id", auth("delete"), deleteHandler);
 */
```

### Middleware: adminAuth.js

```javascript
/**
 * Master key authentication for admin endpoints.
 *
 * Reads MASTER_KEY from config.
 * Validates X-API-Key or Authorization: Bearer against MASTER_KEY.
 * Constant-time comparison.
 * Used for: account creation, project management, key management.
 *
 * If MASTER_KEY is not set, returns 503 (not configured).
 */
```

### Service: keyService.js

```javascript
/**
 * API Key Service
 *
 * Key format: mv_live_<32 random hex chars>
 *   - Prefix "mv_live_" (8 chars) for production keys
 *   - Prefix "mv_test_" (8 chars) for test keys
 *   - Total: 8 + 32 = 40 chars
 *
 * Storage strategy:
 *   - key_prefix: first 12 chars (e.g., "mv_live_a1b2") — for lookup
 *   - key_hash: SHA-256 of full key — for validation
 *   - The full key is shown ONCE to the user at creation, never stored
 *
 * Functions:
 *   generateKey(mode = "live")       → { fullKey, prefix, hash }
 *   validateKey(providedKey)         → apiKeyRow | null
 *   createKey(projectId, name, scopes) → { key: "mv_live_...", id, name, scopes }
 *   revokeKey(keyId)                 → boolean
 *   listKeys(projectId)             → [{ id, name, prefix, scopes, lastUsed, status }]
 */
```

### Service: fileService.js

```javascript
/**
 * File Service — orchestrates uploads from request to storage + DB.
 *
 * uploadFile(req.file, project, options):
 *   1. Determine file type from extension
 *   2. Generate storage key: {project.id}/{folder?}/{slug}-{nanoid}.{ext}
 *   3. Process based on type:
 *      - image → processImage() → WebP buffer → putBuffer to MinIO
 *      - animated gif → FFmpeg → looping MP4 → putFile to MinIO
 *      - video → store temp, return processing status, enqueue transcoding
 *      - video_passthrough (mp4) → store directly, enqueue thumbnail
 *      - file → store as-is
 *   4. Insert row into `files` table
 *   5. Update project.storage_used and project.file_count (increment)
 *   6. Fire webhook: file.uploaded (or file.processed after async)
 *   7. Return file metadata JSON
 *
 * deleteFile(fileId, project):
 *   1. Soft delete: SET deleted_at = NOW()
 *   2. Remove from MinIO (file + thumbnail if video)
 *   3. Decrement project.storage_used and project.file_count
 *   4. Fire webhook: file.deleted
 *
 * listFiles(project, { folder, type, search, page, limit, sort }):
 *   1. Query files table WHERE project_id AND deleted_at IS NULL
 *   2. Apply filters
 *   3. Return paginated results with total count
 *
 * getFile(fileId, project):
 *   1. Query files table by id WHERE project_id matches
 *   2. Return full metadata
 */
```

### Service: queue.js

```javascript
/**
 * Bounded concurrency job queue.
 * Same pattern as existing CDN project but with:
 * - Redis persistence for job status (optional, falls back to Map)
 * - Webhook dispatch on completion/failure
 * - File status updates in PG
 *
 * enqueue(key, fn):
 *   - Adds job to queue
 *   - Updates file status to "processing" in PG
 *   - Drains queue respecting concurrency limit
 *   - On success: update file status to "done", fire webhook
 *   - On failure: update file status to "failed", preserve original, fire webhook
 */
```

---

## 6. API Contracts — Full Endpoint Spec

### Admin Endpoints (Master Key Auth)

#### POST /api/v1/accounts
Create a new account.

```
Headers: X-API-Key: <MASTER_KEY>
Body: {
  "name": "Arni's Company",
  "email": "arni@example.com",
  "password": "optional-for-dashboard-login",  // bcrypt hashed before storage
  "plan": "pro"                                // default: "free"
}
Response 201: {
  "id": "uuid",
  "name": "Arni's Company",
  "email": "arni@example.com",
  "plan": "pro",
  "status": "active",
  "created_at": "2026-03-05T..."
}
```

#### GET /api/v1/accounts
List all accounts (admin).

```
Headers: X-API-Key: <MASTER_KEY>
Query: ?page=1&limit=20&status=active
Response 200: {
  "data": [...],
  "total": 42,
  "page": 1,
  "limit": 20
}
```

#### POST /api/v1/projects
Create a new project under an account.

```
Headers: X-API-Key: <MASTER_KEY>
Body: {
  "account_id": "uuid",
  "name": "RestaurantBoost CDN",
  "slug": "restaurantboost",            // auto-generated if omitted
  "description": "Media for RB platform",
  "settings": {                          // optional, merged with defaults
    "max_file_size": 52428800,
    "webp_quality": 85
  }
}
Response 201: {
  "id": "uuid",
  "account_id": "uuid",
  "name": "RestaurantBoost CDN",
  "slug": "restaurantboost",
  "signing_secret": "hex_string_64_chars",  // auto-generated
  "settings": { ... },
  "storage_used": 0,
  "file_count": 0,
  "created_at": "..."
}
```

#### GET /api/v1/projects
List projects (optionally filter by account).

```
Headers: X-API-Key: <MASTER_KEY>
Query: ?account_id=uuid&status=active
Response 200: {
  "data": [...],
  "total": 5
}
```

#### GET /api/v1/projects/:id
Get project details.

```
Headers: X-API-Key: <MASTER_KEY>
Response 200: { full project object with usage summary }
```

#### DELETE /api/v1/projects/:id
Delete a project (soft delete, marks all files for garbage collection).

```
Headers: X-API-Key: <MASTER_KEY>
Response 200: { "deleted": true, "id": "uuid" }
```

#### POST /api/v1/projects/:id/keys
Create an API key for a project.

```
Headers: X-API-Key: <MASTER_KEY>
Body: {
  "name": "Production Upload Key",
  "scopes": ["upload", "read"],        // default: ["upload", "read"]
  "rate_limit": 200,                   // requests/min, default from plan
  "expires_at": "2027-01-01T00:00:00Z" // optional
}
Response 201: {
  "id": "uuid",
  "name": "Production Upload Key",
  "key": "mv_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",  // SHOWN ONCE
  "key_prefix": "mv_live_a1b2",
  "scopes": ["upload", "read"],
  "rate_limit": 200,
  "expires_at": null,
  "created_at": "..."
}
```

**CRITICAL:** The full `key` value is returned ONLY in this response. It is never stored in plaintext and cannot be retrieved again. The dashboard must show a "copy now" UI.

#### GET /api/v1/projects/:id/keys
List keys for a project (returns prefix, never full key).

```
Headers: X-API-Key: <MASTER_KEY>
Response 200: {
  "data": [
    {
      "id": "uuid",
      "name": "Production Upload Key",
      "key_prefix": "mv_live_a1b2",
      "scopes": ["upload", "read"],
      "status": "active",
      "last_used_at": "2026-03-05T...",
      "created_at": "..."
    }
  ]
}
```

#### DELETE /api/v1/projects/:id/keys/:keyId
Revoke an API key (sets status to "revoked").

```
Headers: X-API-Key: <MASTER_KEY>
Response 200: { "revoked": true, "id": "uuid" }
```

---

### File Endpoints (Project Key Auth)

#### POST /api/v1/upload
Upload a single file.

```
Headers: X-API-Key: mv_live_xxxx (scope: upload)
Body: multipart/form-data, field "file"
Query: ?folder=avatars&name=custom-name&access=public

Response 200 (image):
{
  "id": "uuid",
  "filename": "hero-banner-a8x3k2.webp",
  "url": "https://cdn.example.com/f/{project_id}/hero-banner-a8x3k2.webp",
  "storage_key": "{project_id}/hero-banner-a8x3k2.webp",
  "urls": {
    "original": "https://cdn.example.com/f/{project_id}/hero-banner-a8x3k2.webp",
    "thumb": "https://cdn.example.com/img/fit/200/200/f/{project_id}/hero-banner-a8x3k2.webp",
    "sm": "https://cdn.example.com/img/fit/400/0/f/{project_id}/hero-banner-a8x3k2.webp",
    "md": "https://cdn.example.com/img/fit/800/0/f/{project_id}/hero-banner-a8x3k2.webp",
    "lg": "https://cdn.example.com/img/fit/1200/0/f/{project_id}/hero-banner-a8x3k2.webp"
  },
  "type": "image",
  "mime_type": "image/webp",
  "size": 94200,
  "original_size": 2840000,
  "width": 1600,
  "height": 1067,
  "access": "public",
  "status": "done",
  "processing_ms": 480,
  "created_at": "..."
}

Response 202 (video — async):
{
  "id": "uuid",
  "filename": "promo-clip-m4p9z1.mp4",
  "url": "https://cdn.example.com/f/{project_id}/promo-clip-m4p9z1.mp4",
  "storage_key": "{project_id}/promo-clip-m4p9z1.mp4",
  "thumbnail_url": "https://cdn.example.com/f/{project_id}/promo-clip-m4p9z1_thumb.webp",
  "urls": { ... },
  "type": "video",
  "mime_type": "video/mp4",
  "original_size": 52428800,
  "access": "public",
  "status": "processing",
  "processing_ms": 120,
  "created_at": "..."
}
```

#### POST /api/v1/upload/bulk
Upload multiple files in one request. Max 20 files per request.

```
Headers: X-API-Key: mv_live_xxxx (scope: upload)
Body: multipart/form-data, fields "files" (multiple)
Query: ?folder=gallery&access=public

Response 200:
{
  "uploaded": 5,
  "failed": 0,
  "files": [ ...array of individual upload responses... ],
  "errors": []
}
```

#### GET /api/v1/files
List files in the authenticated project.

```
Headers: X-API-Key: mv_live_xxxx (scope: read)
Query:
  ?page=1
  &limit=50               (max 100)
  &folder=avatars          (filter by folder)
  &type=image              (image, video, file)
  &search=hero             (search filename, original_name)
  &sort=created_at         (created_at, size, filename)
  &order=desc              (asc, desc)
  &status=done             (done, processing, failed)

Response 200:
{
  "data": [ ...file objects... ],
  "total": 342,
  "page": 1,
  "limit": 50
}
```

#### GET /api/v1/files/:id
Get single file metadata.

```
Headers: X-API-Key: mv_live_xxxx (scope: read)
Response 200: { ...full file object... }
```

#### DELETE /api/v1/files/:id
Soft delete a file.

```
Headers: X-API-Key: mv_live_xxxx (scope: delete)
Response 200: {
  "deleted": true,
  "id": "uuid",
  "storage_key": "...",
  "freed_bytes": 94200
}
```

---

### Serving Endpoints (Public or Signed)

#### GET /f/:projectId/*key
Serve a file directly from MinIO.

```
No auth required for public files.
Private files require signed URL: ?token=xxx&expires=xxx

Behavior:
- Streams from MinIO with zero buffering
- Cache-Control: public, max-age=31536000, immutable
- Supports HTTP Range requests (206) for video seeking
- Sets ETag, Content-Type, Content-Length, CORS headers
- If file is processing: returns 202 with auto-refreshing HTML page
- If file not found: returns 404 JSON
- If private and no valid signature: returns 403 JSON

Implementation detail:
- Look up file in PG by storage_key to check access level
- If access = "private" or "signed", validate token
- Log bandwidth to bandwidth_log table (fire-and-forget)
```

#### GET /img/:type/:width/:height/f/:projectId/*key
Serve dynamically resized image via imgproxy.

```
No auth for public images. Signed URL validation for private.

Parameters:
  type: fit, fill, auto, force
  width: pixels (0 = auto)
  height: pixels (0 = auto)

Proxies to imgproxy: /insecure/resize:{type}:{w}:{h}/plain/s3://{bucket}/{project_id}/{key}

Headers on response:
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: from imgproxy response
  CORS: Access-Control-Allow-Origin: *

Log transform to bandwidth_log with is_transform=true
```

---

### Webhook Endpoints (Project Key Auth, scope: admin)

#### POST /api/v1/webhooks
```
Headers: X-API-Key: mv_live_xxxx (scope: admin)
Body: {
  "url": "https://myapp.com/webhook/cdn",
  "events": ["file.uploaded", "file.processed", "file.failed"]
}
Response 201: {
  "id": "uuid",
  "url": "https://myapp.com/webhook/cdn",
  "secret": "whsec_xxxxxxxx",   // for verifying signatures, SHOWN ONCE
  "events": ["file.uploaded", "file.processed", "file.failed"],
  "status": "active",
  "created_at": "..."
}
```

#### GET /api/v1/webhooks
List webhooks for authenticated project.

#### DELETE /api/v1/webhooks/:id
Delete a webhook.

---

### Usage Endpoints (Project Key Auth, scope: read)

#### GET /api/v1/usage
Current period usage for authenticated project.

```
Headers: X-API-Key: mv_live_xxxx (scope: read)
Response 200: {
  "project_id": "uuid",
  "period": "2026-03",
  "storage": {
    "used": 1073741824,    // bytes
    "limit": 53687091200,  // from plan
    "percent": 2.0
  },
  "bandwidth": {
    "used": 5368709120,
    "limit": 107374182400,
    "percent": 5.0
  },
  "uploads": 1234,
  "downloads": 56789,
  "transforms": 12345,
  "files": {
    "total": 342,
    "images": 280,
    "videos": 42,
    "other": 20
  }
}
```

#### GET /api/v1/usage/history
Daily usage for the last N days.

```
Query: ?days=30
Response 200: {
  "data": [
    { "date": "2026-03-05", "uploads": 12, "upload_bytes": ..., "downloads": 450, ... },
    ...
  ]
}
```

---

### Utility Endpoints

#### GET /health
```
No auth.
Response 200: {
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "queue": { "pending": 2, "active": 1 },
  "services": {
    "postgres": "ok",
    "minio": "ok",
    "redis": "ok",
    "imgproxy": "ok"
  }
}
```

---

## 7. Auth System

### API Key Format & Lifecycle

```
Format: mv_{mode}_{32 hex chars}
  mv_live_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
  mv_test_f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5

Storage:
  key_prefix  = first 12 chars → "mv_live_a1b2"  (plaintext, indexed for fast lookup)
  key_hash    = SHA-256(full_key)                 (stored for validation)

Lookup flow:
  1. Extract key from header
  2. Take first 12 chars as prefix
  3. SELECT * FROM api_keys WHERE key_prefix = $1 AND status = 'active'
  4. SHA-256 hash the provided key
  5. Constant-time compare hash with stored key_hash
  6. Check expires_at
  7. Load project by project_id
  8. Validate required scope
```

### Master Key

```
Format: mv_master_{48 hex chars}
Configured via MASTER_KEY env var.
Used ONLY for admin endpoints (account/project/key management).
NOT stored in database — compared directly against env var.
```

### Signed URLs

```
For private/expiring file access.

Format: /f/{project_id}/{key}?token={signature}&expires={unix_timestamp}

Signature generation:
  payload = "{project_id}/{key}:{expires_timestamp}"
  signature = HMAC-SHA256(project.signing_secret, payload)
  token = hex(signature)

Validation:
  1. Parse token and expires from query string
  2. Check expires > now
  3. Load project, get signing_secret
  4. Recompute HMAC
  5. Constant-time compare
```

---

## 8. File Processing Pipeline

### Type Detection

```
Extension → Type mapping:

IMAGE:    .jpg .jpeg .png .gif .bmp .tiff .tif .heic .heif .avif .webp
VIDEO:    .mov .avi .mkv .wmv .flv .webm .m4v .3gp
VIDEO_PT: .mp4 (passthrough — already optimized format)
AUDIO:    .mp3 .wav .flac .aac .ogg .m4a .wma
FILE:     everything else (pdf, svg, fonts, docs, zip, etc.)
```

### Image Processing (synchronous)

```
1. Read buffer
2. Check if animated GIF → route to video pipeline if yes
3. sharp(buffer)
     .resize(maxWidth, maxHeight, { fit: "inside", withoutEnlargement: true })
     .webp({ quality: project.settings.webp_quality || config.webpQuality })
     .toBuffer()
4. Upload to MinIO: {project_id}/{folder?}/{slug}-{uid}.webp
5. Insert into files table with width, height, size, original_size
6. Return metadata
```

### Video Processing (asynchronous)

```
1. Accept upload, store temp original in MinIO as _processing_{uid}{ext}
2. Insert file row with status = "processing"
3. Return 202 with final URLs immediately
4. Enqueue background job:
   a. Download temp from MinIO to local tmpdir
   b. FFmpeg transcode:
      -c:v libx264 -preset medium -crf {videoCrf}
      -vf scale=min({maxH},iw):min({maxH},ih):force_original_aspect_ratio=decrease:force_divisible_by=2
      -c:a aac -b:a 128k
      -movflags +faststart -pix_fmt yuv420p
   c. Extract WebP thumbnail at 1s (fallback to 0s)
   d. Upload MP4 + thumbnail to MinIO at final keys
   e. Delete temp original
   f. Update files row: status="done", size, duration, thumbnail_key
   g. Update project storage_used
   h. Fire webhook: file.processed
5. On failure:
   a. Copy temp to final key (preserve something accessible)
   b. Update files row: status="failed", error_message
   c. Fire webhook: file.failed
```

### Audio Processing

```
Audio files are stored as-is (no transcoding in v1).
Metadata extraction: duration (via ffprobe).
Future: normalize, transcode to MP3/AAC.
```

### Storage Key Format

```
{project_id}/{folder}/{slug}-{nanoid6}.{ext}

Examples:
  a1b2c3d4-e5f6-7890/avatars/john-doe-x8k2m1.webp
  a1b2c3d4-e5f6-7890/hero-banner-p3n7v2.webp
  a1b2c3d4-e5f6-7890/videos/promo-q9w2e1.mp4
  a1b2c3d4-e5f6-7890/videos/promo-q9w2e1_thumb.webp
  a1b2c3d4-e5f6-7890/docs/contract-m8k3n2.pdf
```

---

## 9. File Serving & Signed URLs

### Public Files

```
GET /f/{project_id}/{storage_key_remainder}

Flow:
1. Reconstruct full storage_key = "{project_id}/{remainder}"
2. Look up file in PG by storage_key WHERE deleted_at IS NULL
3. If file.access = "public": serve directly from MinIO
4. If file.access = "private" or "signed": check token
5. Stream from MinIO → response (zero buffering)
6. Log to bandwidth_log (fire-and-forget INSERT)
7. Set headers: Cache-Control, Content-Type, Content-Length, ETag, CORS, Accept-Ranges
8. Handle Range requests for video seeking (206 Partial Content)
```

### Signed URL Generation (SDK/API)

```
GET /api/v1/files/:id/signed-url?expires=3600

Headers: X-API-Key: mv_live_xxxx (scope: read)
Query: expires = seconds until expiry (default 3600, max 86400)

Response 200: {
  "url": "https://cdn.example.com/f/{pid}/{key}?token=abc123&expires=1709654400",
  "expires_at": "2026-03-05T12:00:00Z"
}
```

---

## 10. Webhook System

### Event Types

```
file.uploaded   — any file upload completes (sync or accepted for processing)
file.processed  — async processing (video transcoding) completes successfully
file.failed     — async processing failed
file.deleted    — file deleted
```

### Payload Format

```json
{
  "event": "file.processed",
  "timestamp": "2026-03-05T10:30:00Z",
  "project_id": "uuid",
  "data": {
    "id": "uuid",
    "filename": "promo-clip-m4p9z1.mp4",
    "url": "https://cdn.example.com/f/{pid}/promo-clip-m4p9z1.mp4",
    "type": "video",
    "mime_type": "video/mp4",
    "size": 12345678,
    "status": "done",
    "processing_ms": 45000,
    "thumbnail_url": "https://cdn.example.com/f/{pid}/promo-clip-m4p9z1_thumb.webp"
  }
}
```

### Delivery

```
POST to webhook.url
Headers:
  Content-Type: application/json
  X-MV-Signature: HMAC-SHA256(webhook.secret, JSON.stringify(payload))
  X-MV-Event: file.processed
  X-MV-Delivery-Id: uuid
  X-MV-Timestamp: unix_timestamp
  User-Agent: MediaOS/1.0

Retry policy:
  Attempt 1: immediate
  Attempt 2: after 10 seconds
  Attempt 3: after 60 seconds
  After 3 failures: log, increment failure_count, stop retrying for this delivery

Success: HTTP 2xx response
Failure: anything else (timeout 10s, non-2xx, network error)

Implementation:
  - Use webhook_deliveries table to track each attempt
  - Retry via setTimeout (or Redis delayed queue if available)
  - Update webhook.last_triggered, last_status, success/failure counts
```

---

## 11. Usage Tracking

### What Gets Tracked

```
On upload:
  - Increment usage_daily.uploads
  - Add original file size to usage_daily.upload_bytes
  - Update project.storage_used += file.size
  - Update project.file_count += 1

On serve (GET /f/*):
  - Increment usage_daily.downloads
  - Add bytes_served to usage_daily.download_bytes
  - Insert into bandwidth_log

On resize (GET /img/*):
  - Increment usage_daily.transforms
  - Insert into bandwidth_log with is_transform=true

On delete:
  - Increment usage_daily.deletes
  - Update project.storage_used -= file.size
  - Update project.file_count -= 1

Every API request:
  - Increment usage_daily.api_requests
```

### Implementation Strategy

```
Use fire-and-forget async updates (don't block the response):
  - UPDATE usage_daily ... ON CONFLICT (project_id, date) DO UPDATE
  - INSERT INTO bandwidth_log (no conflict handling needed)
  - UPDATE projects SET storage_used = storage_used + $1

For high-traffic: batch bandwidth_log inserts via in-memory buffer
that flushes every 5 seconds or every 100 entries (whichever first).
```

---

## 12. Rate Limiting

### Strategy

```
Per API key, configurable rate (api_keys.rate_limit).

Algorithm: sliding window counter using Redis.
Key: ratelimit:{api_key_id}:{minute_bucket}
TTL: 120 seconds

Fallback (no Redis): in-memory Map with periodic cleanup.

Response headers on every request:
  X-RateLimit-Limit: 100
  X-RateLimit-Remaining: 87
  X-RateLimit-Reset: 1709654460  (unix timestamp)

When exceeded:
  HTTP 429 Too Many Requests
  { "error": "Rate limit exceeded", "retry_after": 23 }
```

---

## 13. Dashboard (Next.js)

### Auth

```
NextAuth.js with credentials provider.
Login: email + password validated against accounts.password_hash (bcrypt).
Session: JWT stored in httpOnly cookie.
All dashboard API calls go to worker's admin endpoints using MASTER_KEY.
```

### Pages

```
/login
  - Email + password form
  - Redirect to /dashboard on success

/dashboard
  - Overview cards: total storage, bandwidth this month, total files, projects count
  - Recent uploads list (last 10 across all projects)
  - Quick actions: create project, upload file

/dashboard/projects
  - Grid of project cards
  - Each card: name, file count, storage used, status badge
  - "New Project" button → modal

/dashboard/projects/[id]
  - Tabs or sub-nav: Files | Keys | Webhooks | Usage | Settings
  - Header: project name, slug, creation date, quick stats

/dashboard/projects/[id]/files
  - Toggle: grid view (thumbnails) / list view (table)
  - Search bar, folder filter, type filter
  - Click file → slide-over panel with preview + metadata + URLs + actions
  - Drag-and-drop upload zone at top
  - Pagination

/dashboard/projects/[id]/keys
  - Table: name, prefix (masked), scopes as badges, last used, status
  - "Create Key" → modal with name + scope checkboxes
  - Show full key ONCE in success modal with copy button
  - Revoke button with confirmation

/dashboard/projects/[id]/webhooks
  - List: URL, events as badges, last triggered, success/fail counts
  - "Add Webhook" → form with URL + event checkboxes
  - Show secret ONCE on creation
  - Test webhook button (sends a test event)

/dashboard/projects/[id]/usage
  - Line chart: uploads per day (last 30 days)
  - Line chart: bandwidth per day
  - Bar chart: storage breakdown by type
  - Numbers: current month totals
  - Plan limits comparison bars

/dashboard/projects/[id]/settings
  - Edit: name, description
  - Processing settings: webp quality, max dimensions
  - Default access: public/private
  - Danger zone: delete project (confirmation modal)

/dashboard/account
  - Account info: name, email
  - Change password
  - Current plan + upgrade CTA
```

### Design Direction

```
- Clean, minimal, dark-mode first (like Vercel/Linear aesthetic)
- Tailwind CSS
- shadcn/ui components as base
- Monospace for code/keys/URLs
- Responsive but desktop-primary (this is a dev tool)
```

---

## 14. TypeScript SDK

### Package: `@mediaos/sdk`

```typescript
// src/index.ts — Main export

export class MediaOS {
  constructor(config: {
    url: string;        // "https://cdn.example.com"
    apiKey: string;     // "mv_live_xxxx"
    timeout?: number;   // default 30000ms
  });

  // Upload
  async upload(
    file: File | Buffer | ReadableStream,
    options?: {
      folder?: string;
      name?: string;
      access?: "public" | "private";
    }
  ): Promise<UploadResult>;

  async uploadBulk(
    files: Array<File | Buffer>,
    options?: { folder?: string; access?: string }
  ): Promise<BulkUploadResult>;

  // Files
  files: {
    list(options?: {
      page?: number;
      limit?: number;
      folder?: string;
      type?: "image" | "video" | "file";
      search?: string;
      sort?: string;
      order?: "asc" | "desc";
    }): Promise<FileListResult>;

    get(id: string): Promise<FileMetadata>;
    delete(id: string): Promise<DeleteResult>;
    signedUrl(id: string, expiresIn?: number): Promise<SignedUrlResult>;
  };

  // URL helpers (no API call, just builds URLs)
  url(key: string, options?: {
    width?: number;
    height?: number;
    fit?: "fit" | "fill" | "auto" | "force";
  }): string;

  thumbnailUrl(key: string, size?: number): string;

  // Usage
  usage: {
    current(): Promise<UsageResult>;
    history(days?: number): Promise<UsageHistoryResult>;
  };

  // Webhooks
  webhooks: {
    list(): Promise<WebhookListResult>;
    create(url: string, events: string[]): Promise<WebhookResult>;
    delete(id: string): Promise<void>;
    verify(payload: string, signature: string, secret: string): boolean;
  };
}

// Types
export interface UploadResult {
  id: string;
  filename: string;
  url: string;
  storage_key: string;
  urls: {
    original: string;
    thumb?: string;
    sm?: string;
    md?: string;
    lg?: string;
    thumbnail?: string;
  };
  type: "image" | "video" | "file";
  mime_type: string;
  size: number;
  original_size: number;
  width?: number;
  height?: number;
  access: string;
  status: "done" | "processing";
  processing_ms: number;
  created_at: string;
}

export interface FileMetadata extends UploadResult {
  original_name: string;
  folder: string | null;
  duration?: number;
  thumbnail_key?: string;
  metadata: Record<string, any>;
}
```

---

## 15. Agent Task Breakdown

Each task below is an independent unit of work that can be assigned to a Claude Code agent. Tasks are ordered by dependency — earlier tasks must complete before later ones that depend on them.

### Track 1: Infrastructure & Database (do first)

```
TASK 1.1 — Docker Compose + Dockerfiles
  Create: docker-compose.yml, .env.example, .gitignore, worker/Dockerfile, dashboard/Dockerfile
  Worker Dockerfile: Node.js 20 Alpine + FFmpeg
  Dashboard Dockerfile: Node.js 20 Alpine + Next.js standalone output
  Test: docker compose up -d → all 5 services healthy

TASK 1.2 — PostgreSQL Schema + Migrations
  Create: All 3 migration SQL files + migrate.js runner
  Test: Run migrations against fresh PG, verify all tables/indexes/triggers exist
  Depends on: 1.1

TASK 1.3 — Worker Scaffold + Config + DB/MinIO Clients
  Create: package.json, src/config.js, src/db.js, src/minio.js, src/index.js (bootstrap)
  The index.js should: validate config, connect PG, run migrations, ensure MinIO bucket, start Express
  Test: Worker starts, connects to PG and MinIO, runs migrations
  Depends on: 1.1, 1.2
```

### Track 2: Auth & Admin API (needs Track 1)

```
TASK 2.1 — Key Service + Crypto Utils
  Create: src/services/keyService.js, src/utils/crypto.js
  Implement: generateKey, hashKey, validateKey, constantTimeCompare
  Test: Generate key, hash it, validate it, reject wrong key

TASK 2.2 — Auth Middleware
  Create: src/middleware/auth.js, src/middleware/adminAuth.js
  Implement: project key auth → req.project, master key auth
  Test: Valid key → 200, invalid → 403, missing → 401, wrong scope → 403
  Depends on: 2.1

TASK 2.3 — Account + Project + Key Admin Routes
  Create: src/routes/accounts.js, src/routes/projects.js, src/routes/apiKeys.js
  Implement: All admin CRUD endpoints per API spec above
  Test: Create account, create project, create key, list/delete
  Depends on: 2.2
```

### Track 3: File Processing & Upload (needs Track 1, 2)

```
TASK 3.1 — Image + Video Processors
  Create: src/services/imageProcessor.js, src/services/videoProcessor.js
  Port from existing CDN project: Sharp WebP conversion, FFmpeg transcoding, animated GIF detection
  Create: src/services/queue.js (bounded concurrency)
  Test: Process test image → WebP, process test video → MP4 + thumbnail

TASK 3.2 — File Service + Upload Route
  Create: src/services/fileService.js, src/routes/upload.js
  Create: src/utils/slugify.js, src/utils/mimeTypes.js, src/utils/fileTypes.js
  Implement: Full upload flow per pipeline spec — image/video/audio/file handling
  Insert into files table, update project counters
  Test: Upload image → WebP + DB row, upload video → async processing + DB row
  Depends on: 3.1, 2.2

TASK 3.3 — File Listing/Search/Delete Routes
  Create: src/routes/files.js
  Implement: GET /api/v1/files (list with pagination, filters, search)
  Implement: GET /api/v1/files/:id (single file metadata)
  Implement: DELETE /api/v1/files/:id (soft delete + MinIO removal)
  Test: Upload 3 files, list them, filter by type, search by name, delete one
  Depends on: 3.2

TASK 3.4 — File Serving Route
  Create: src/routes/serve.js
  Implement: GET /f/:projectId/* (direct serve from MinIO)
  Implement: GET /img/:type/:w/:h/f/:projectId/* (imgproxy proxy)
  Handle: Range requests, processing status page, 404, cache headers
  Test: Upload image, serve it, serve resized version, test video range request
  Depends on: 3.2
```

### Track 4: SaaS Features (needs Track 2, 3)

```
TASK 4.1 — Signed URLs
  Create: src/services/signedUrl.js
  Implement: generate(project, storageKey, expiresIn) → signed URL
  Implement: validate(project, storageKey, token, expires) → boolean
  Add: GET /api/v1/files/:id/signed-url endpoint
  Update: serve.js to check signatures for private files
  Test: Generate signed URL, access file, expired URL returns 403
  Depends on: 3.4

TASK 4.2 — Webhook System
  Create: src/services/webhookService.js, src/routes/webhooks.js
  Implement: CRUD for webhook endpoints
  Implement: dispatch(projectId, event, data) with HMAC signing
  Implement: Retry logic (3 attempts, exponential backoff)
  Implement: webhook_deliveries logging
  Hook into: fileService.js upload/process/delete flows
  Test: Register webhook, upload file, verify webhook received with correct signature

TASK 4.3 — Usage Tracking
  Create: src/services/usageService.js, src/routes/usage.js
  Implement: trackUpload, trackDownload, trackTransform, trackDelete
  Implement: Buffered bandwidth_log inserts (batch every 5s)
  Implement: GET /api/v1/usage and GET /api/v1/usage/history
  Hook into: upload, serve, resize, delete flows
  Test: Upload files, serve them, check usage numbers match

TASK 4.4 — Rate Limiting
  Create: src/middleware/rateLimit.js
  Implement: Sliding window per API key using Redis (fallback to in-memory Map)
  Implement: X-RateLimit-* response headers
  Implement: 429 response when exceeded
  Test: Hit endpoint 101 times with rate_limit=100, verify 429 on 101st

TASK 4.5 — Bulk Upload
  Update: src/routes/upload.js
  Add: POST /api/v1/upload/bulk (multer.array("files", 20))
  Implement: Process each file, collect results, return aggregate response
  Test: Upload 5 images in one request, verify all processed
```

### Track 5: Dashboard (can start after Track 2 API works)

```
TASK 5.1 — Dashboard Scaffold + Auth
  Create: Next.js 15 app with Tailwind + shadcn/ui
  Implement: /login page, NextAuth credentials provider
  Implement: Auth middleware, session management
  Implement: src/lib/api.ts (fetch wrapper for worker API)
  Test: Login with account credentials, get session

TASK 5.2 — Layout + Navigation
  Create: Sidebar, Header, ProjectSwitcher components
  Implement: /dashboard layout with sidebar nav
  Implement: Project switching dropdown
  Test: Navigate between pages, switch projects

TASK 5.3 — Project Management Pages
  Create: /dashboard/projects (list), /dashboard/projects/[id] (detail)
  Create: CreateProjectModal, ProjectCard, ProjectSettings components
  Implement: Create project, view project, delete project
  Test: Full project lifecycle through UI

TASK 5.4 — File Browser
  Create: /dashboard/projects/[id]/files
  Create: FileGrid, FileList, FilePreview, UploadDropzone, FileActions
  Implement: Grid/list toggle, search, folder filter, type filter
  Implement: Drag-and-drop upload
  Implement: File preview slide-over with metadata + copy URL buttons
  Test: Upload via dropzone, browse files, search, preview, delete

TASK 5.5 — API Key Management
  Create: /dashboard/projects/[id]/keys
  Create: KeyList, CreateKeyModal
  Implement: Create key with scope selection, show key once, copy button
  Implement: Revoke key with confirmation
  Test: Create key, copy it, revoke it

TASK 5.6 — Webhook Management
  Create: /dashboard/projects/[id]/webhooks
  Create: WebhookList, WebhookForm
  Implement: Add webhook with URL + event selection
  Implement: Show secret once, delivery stats
  Test: Create webhook, verify event checkboxes

TASK 5.7 — Usage Dashboard
  Create: /dashboard/projects/[id]/usage
  Create: UsageChart, StorageBar, BandwidthChart (using recharts)
  Implement: Current period stats cards
  Implement: 30-day line charts for uploads + bandwidth
  Implement: Plan limits comparison bars
  Test: Verify charts render with usage data

TASK 5.8 — Account Settings
  Create: /dashboard/account
  Implement: Edit name/email, change password
  Implement: Plan info display
```

### Track 6: SDK (can start after Track 3 API works)

```
TASK 6.1 — TypeScript SDK
  Create: sdk/ directory with full package structure
  Implement: MediaOS class per spec above
  Implement: All methods: upload, uploadBulk, files.list/get/delete, url helpers, usage, webhooks
  Implement: Webhook signature verification helper
  Create: README.md with usage examples
  Test: Write test script that uploads, lists, serves, deletes via SDK
```

---

## 16. Conventions & Rules

### Code Style (Worker — JavaScript)

```
- Node.js 20, CommonJS (require/module.exports) — no TypeScript in worker for simplicity
- ESLint with standard config
- 2-space indentation
- Semicolons: yes
- Single quotes for strings
- No var — const by default, let when needed
- Async/await everywhere (no callbacks, no .then chains)
- Error handling: try/catch with specific error types, never swallow errors silently
- Logging: console.log with emoji prefixes (✅ ❌ ⬆️ 🎬 🖼️ 🗑️)
```

### Code Style (Dashboard — TypeScript)

```
- Next.js 15 App Router
- TypeScript strict mode
- Tailwind CSS (no CSS modules, no styled-components)
- shadcn/ui as component base
- Server components by default, "use client" only when needed
- React Server Actions for mutations where appropriate
- Fetch with revalidation for data loading
```

### API Response Format

```
Success:
  { "data": ..., "total": N, "page": N, "limit": N }  // for lists
  { ...object }                                         // for single items

Error:
  {
    "error": "Human readable message",
    "code": "VALIDATION_ERROR",           // machine-readable code
    "details": { "field": "message" }     // optional field-level errors
  }

HTTP Status Codes:
  200 — Success
  201 — Created
  202 — Accepted (async processing started)
  400 — Bad request / validation error
  401 — Missing auth
  403 — Invalid auth / insufficient scope / expired key
  404 — Not found
  409 — Conflict (duplicate slug, etc.)
  413 — File too large
  429 — Rate limited
  500 — Internal error
  503 — Service unavailable (dependency down)
```

### Database Conventions

```
- All tables use UUID primary keys (gen_random_uuid())
- All tables have created_at and updated_at (with trigger)
- Soft deletes via deleted_at column (nullable TIMESTAMPTZ)
- Indexes on all foreign keys and commonly queried columns
- JSONB for extensible metadata fields
- Text arrays for scopes and events (PostgreSQL native arrays)
```

### Security Rules

```
- API keys never stored in plaintext — SHA-256 hash only
- Passwords never stored in plaintext — bcrypt only
- Webhook secrets never stored in plaintext — shown once at creation
- Signing secrets auto-generated per project (crypto.randomBytes(32).toString('hex'))
- All comparisons use constant-time functions
- File keys sanitized: no path traversal, no special chars
- Folder names: alphanumeric + dash + underscore + slash only
- Rate limiting on all authenticated endpoints
- Master key required for admin operations
- CORS: configurable, default wildcard (restrict in production via reverse proxy)
- Helmet middleware for security headers
- No query string in signed URL tokens leaks to referrer (use POST for sensitive ops)
```

### MinIO Conventions

```
- Single bucket: name from MINIO_BUCKET env var
- All files under {project_id}/ prefix
- Public read policy on bucket (access control at app level for private files)
- Content-Type set on all objects

- Cache-Control: public, max-age=31536000, immutable on all objects
- Temp files during processing: _processing_{uid}{ext} prefix, cleaned up after
```

---

## Quick Reference: Key Technical Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Worker language | JavaScript (CommonJS) | Matches existing project, Sharp/FFmpeg ecosystem, no build step |
| Dashboard language | TypeScript | Type safety for complex UI, Next.js standard |
| Database | PostgreSQL | Multi-tenant data, relational queries, JSON flexibility |
| Key storage | SHA-256 hash | Fast lookup by prefix, secure validation |
| File isolation | Prefix-based ({project_id}/) | Simpler than multi-bucket, MinIO handles efficiently |
| Queue | In-memory with optional Redis | Works immediately, scales later |
| Migrations | Raw SQL + simple runner | No ORM overhead, full control, portable |
| Image resize | imgproxy (not Sharp) | Dedicated service, caching, no worker CPU load |
| Video processing | FFmpeg in worker | Already proven in existing project |
| Dashboard auth | NextAuth credentials | Simple, no external deps, account table in PG |
| Rate limiting | Redis sliding window | Accurate, distributed-ready, with in-memory fallback |
| Webhooks | Direct HTTP POST + retry table | Simple, reliable, auditable |

---

*This document is the single source of truth. When in doubt, reference the relevant section. If a section conflicts with another, the more specific section wins (e.g., API contract details override general descriptions).*