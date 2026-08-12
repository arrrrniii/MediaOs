# MediaOS Operations Guide

Backup, restore, upgrade, and rollback procedures for a Docker Compose
deployment of MediaOS. All commands run from the repository root on the
host. Values in `${...}` come from your `.env`.

## What must be backed up

| Data | Where it lives | Tool |
|---|---|---|
| Database (accounts, projects, keys, file metadata, usage, webhooks) | `pg_data` volume | `pg_dump` / `pg_restore` |
| Media objects (originals, WebP, thumbnails, video renditions) | `minio_data` volume | `mc mirror` (or volume snapshot) |
| Configuration & secrets | `.env` on the host | file copy to secure storage |

Redis holds only transient state (rate limits, usage counters pending
flush, caches). It does not need backups; losing it loses at most a few
seconds of usage counters.

## Database backup

```bash
# Plain-SQL dump (readable, good for dev)
docker exec mv-postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > backups/pg_$(date +%F_%H%M).sql

# Custom-format dump (compressed, supports parallel & selective restore)
docker exec mv-postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > backups/pg_$(date +%F_%H%M).dump
```

Schedule this (cron/systemd timer) and ship the file off-host. Keep at
least 7 daily and 4 weekly dumps.

## Database restore (into a clean environment)

```bash
# 1. Start only postgres with a fresh volume
docker compose up -d postgres

# 2. Restore
docker exec -i mv-postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  < backups/pg_YYYY-MM-DD_HHMM.sql
# or for custom-format dumps:
docker exec -i mv-postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' \
  < backups/pg_YYYY-MM-DD_HHMM.dump

# 3. Verify migrations match the code you are about to run
cd worker && npm run migrate -- --verify
```

## MinIO (object) backup

```bash
# One-off or scheduled mirror to a local directory (or remote S3 target)
docker run --rm --network mediaos_mediaos \
  -v "$PWD/backups/minio:/backup" \
  --entrypoint sh minio/mc -c '
    mc alias set src http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
    mc mirror --preserve src/mediaos /backup/mediaos'
```

For production, prefer continuous replication to a second S3-compatible
target (`mc mirror --watch`, or bucket replication once cold-storage
backends land) over point-in-time copies.

## MinIO restore

```bash
docker compose up -d minio
docker run --rm --network mediaos_mediaos \
  -v "$PWD/backups/minio:/backup" \
  --entrypoint sh minio/mc -c '
    mc alias set dst http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
    mc mb --ignore-existing dst/mediaos &&
    mc mirror --preserve /backup/mediaos dst/mediaos'
```

After a combined restore, database rows and objects must agree. The
reconciliation job (Phase 7) detects rows whose objects are missing and
orphaned objects without rows; until it exists, spot-check a few recent
files through the API.

## Upgrade procedure

1. Back up the database and `.env` (above). For minor upgrades the MinIO
   mirror can be skipped if replication is running.
2. Read the release notes for the target version. Note new required env
   vars and migration warnings.
3. Pull/build new images:
   `docker compose pull` (hub install) or `docker compose build` (source).
4. Apply: `docker compose up -d`. The worker runs migrations on boot
   under an advisory lock, so multiple replicas are safe.
5. Verify:
   - `curl -s localhost:${API_PORT}/health` → `status: ok`, expected `version`.
   - `cd worker && npm run migrate -- --verify` exits 0.
   - Upload + fetch a test file; open the dashboard.

## Rollback procedure

Rolling back **code** is safe; rolling back **schema** is not attempted —
migrations are forward-only.

1. `docker compose down` (volumes stay).
2. Check out / retag the previous version and `docker compose up -d`.
3. If the failed upgrade's migrations are incompatible with the old code
   (rare — migrations are written to be backward-compatible for one
   release), restore the pre-upgrade database dump taken in step 1 of the
   upgrade, accepting loss of writes made during the failed upgrade
   window.

Supported paths: upgrades from the previous minor release are tested in
CI; skipping releases requires stepping through each minor version.

## Production deployment

MediaOS ships as a Docker Compose stack. Two compose files:

- `docker-compose.yml` — builds the worker/dashboard images from source.
- `docker-compose.hub.yml` — pulls pre-built images from Docker Hub.

Both pin every third-party image by digest, run the worker as a non-root user,
apply per-service CPU/memory limits and log rotation, and provision two
least-privilege MinIO service accounts (worker read/write, imgproxy read-only)
via a one-shot `minio-setup` container — the MinIO root credentials are used
only for that provisioning.

### First deploy

```bash
cp .env.example .env
# Replace EVERY changeme_* value and set MASTER_KEY, INTERNAL_API_SECRET,
# STORAGE_ENCRYPTION_KEY (32-byte hex), ADMIN_EMAIL/ADMIN_PASSWORD, PUBLIC_URL.
#   openssl rand -hex 32   # for secrets/keys
docker compose --profile dashboard up -d          # or -f docker-compose.hub.yml
```

On first boot the worker runs migrations (advisory-locked, so replicas are
safe), seeds the admin account + owner membership, and starts the BullMQ
workers, outbox poller, lifecycle scanner, reconciler, and health snapshots.
Put a TLS-terminating reverse proxy (see `deploy/nginx.conf` / `deploy/Caddyfile`)
in front; the worker port binds to loopback so all public traffic goes through
the proxy. Serve media from a separate cookie-free domain (`deploy/nginx.conf`
has a template).

### Health, metrics, and self-healing

- `GET /health`, `/health/live`, `/health/ready` — liveness/readiness.
- `GET /metrics` — Prometheus (needs `MASTER_KEY` unless `METRICS_PUBLIC=true`).
- Set `OTEL_EXPORTER_OTLP_ENDPOINT` to ship traces.
- The **System** dashboard page (visible to `ADMIN_EMAIL`) shows healthy/missing/
  orphan/corrupt objects, stuck jobs, failed webhooks, pending restores, and the
  last backup / last restore-test timestamps, plus a "Run now" reconcile button.
- Enable `RESTORE_TEST_ENABLED=true` to schedule an archive→restore self-test.

### CI gates (`.github/workflows/ci.yml`)

Worker unit tests; worker integration against real Postgres/Redis/MinIO
(migrations + the durable-queue, archive/restore, reconciler, HLS, and
essential-failure suites); migrate-from-previous-release; dashboard
lint/type-check/build; dashboard Playwright E2E against the full stack; SDK
build/test; dependency audit (fails on high+); Docker Compose smoke test
(`scripts/smoke-test.sh`); container vulnerability scan (Trivy) + SBOM
generation (SPDX).

## Database roles and pooling

By default the worker connects, migrates, and serves as a single `PG_USER`.
For least privilege you can split DDL from runtime:

```sql
-- Runtime role: DML only, no schema changes
CREATE ROLE mediaos_runtime LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE mediaos TO mediaos_runtime;
GRANT USAGE ON SCHEMA public TO mediaos_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mediaos_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mediaos_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mediaos_runtime;

-- Migration role: owns the schema / runs DDL
CREATE ROLE mediaos_migrator LOGIN PASSWORD '...';
GRANT ALL ON DATABASE mediaos TO mediaos_migrator;
```

Then set `PG_USER=mediaos_runtime` and `PG_MIGRATION_USER=mediaos_migrator`
(+ `PG_MIGRATION_PASSWORD`). Migrations — at boot and via `npm run migrate` —
run under the migration role; all request traffic uses the runtime role.
Concurrent migration runners are serialized by an advisory lock, so multiple
worker replicas can boot safely.

Pool sizing is env-tunable: `PG_POOL_MAX` (default 20),
`PG_POOL_IDLE_TIMEOUT_MS`, `PG_POOL_CONNECTION_TIMEOUT_MS`.

High-volume append-only logs (`bandwidth_log`, `webhook_deliveries`,
`video_playback_events`) are pruned by the cleanup job after `LOG_RETENTION_MS`
(default 90 days); `created_at` indexes keep the delete cheap.

## Development environment

```bash
cp .env.example .env            # then replace every changeme_* value
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres minio redis imgproxy
cd worker && npm install && npm run migrate && npm run dev
cd dashboard && npm install && npm run dev
```

The dev override publishes Postgres on `localhost:5432`, MinIO on
`9000/9001`, Redis on `6380` (6379 is often taken), imgproxy on `8080`.
Set `REDIS_URL=redis://:<REDIS_PASSWORD>@localhost:6380` for the worker
when it runs outside Docker.
