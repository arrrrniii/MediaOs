#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  MediaOS server deploy / upgrade (GHCR images).
#
#  Run this ON THE SERVER from the repo root. It is safe to re-run.
#  It will:
#    1. ensure .env exists and fill in any NEW required secrets
#       (generated locally — nothing is printed or sent anywhere)
#    2. back up Postgres + the .env before changing anything
#    3. pull the latest images from GHCR
#    4. start/upgrade the stack (migrations run on worker boot)
#    5. wait for /health and report
#
#  Usage:
#    ./scripts/deploy.sh              # with dashboard
#    WITH_DASHBOARD=0 ./scripts/deploy.sh   # API only
# ─────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.hub.yml"
WITH_DASHBOARD="${WITH_DASHBOARD:-1}"
API_PORT="${API_PORT:-3000}"
PROFILE_ARGS=()
[ "$WITH_DASHBOARD" = "1" ] && PROFILE_ARGS=(--profile dashboard)

log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

gen_hex() { openssl rand -hex "$1"; }

command -v docker >/dev/null || die "docker is not installed"
command -v openssl >/dev/null || die "openssl is not installed"

# ── 1. .env: create from example, fill NEW required secrets ──
log "Checking .env"
if [ ! -f .env ]; then
  [ -f .env.example ] || die ".env and .env.example are both missing"
  cp .env.example .env
  echo "Created .env from .env.example — review it after this run."
fi

# ensure_secret KEY [bytes]  → add KEY=<random hex> if missing/placeholder
ensure_secret() {
  local key="$1" bytes="${2:-32}" cur
  cur="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)"
  if [ -z "$cur" ] || case "$cur" in changeme*|*your_secret_here*|"") true;; *) false;; esac; then
    if grep -qE "^${key}=" .env; then
      # portable in-place edit
      tmp="$(mktemp)"; grep -vE "^${key}=" .env > "$tmp"; mv "$tmp" .env
    fi
    echo "${key}=$(gen_hex "$bytes")" >> .env
    echo "  generated ${key}"
  fi
}

# Secrets introduced by the platform rebuild.
ensure_secret INTERNAL_API_SECRET 32
ensure_secret STORAGE_ENCRYPTION_KEY 32
ensure_secret WORKER_MINIO_SECRET_KEY 16
ensure_secret IMGPROXY_MINIO_SECRET_KEY 16
# MASTER_KEY has a distinct prefix; generate if still a placeholder.
if grep -qE '^MASTER_KEY=(mv_master_your_secret_here)?$' .env || ! grep -qE '^MASTER_KEY=' .env; then
  tmp="$(mktemp)"; grep -vE '^MASTER_KEY=' .env > "$tmp" 2>/dev/null || true; mv "$tmp" .env
  echo "MASTER_KEY=mv_master_$(gen_hex 24)" >> .env
  echo "  generated MASTER_KEY"
fi

# Warn (don't fail) on values the operator must set meaningfully.
for k in PUBLIC_URL ADMIN_EMAIL; do
  v="$(grep -E "^${k}=" .env | head -1 | cut -d= -f2- || true)"
  case "$v" in ""|*example.com*|*localhost*) echo "  NOTE: review ${k} in .env (currently: '${v:-unset}')";; esac
done

# ── 2. Back up before changing anything ─────────────────────
log "Backup"
mkdir -p backups
STAMP="$(date +%F_%H%M%S)"
cp .env "backups/.env.${STAMP}.bak"
if docker ps --format '{{.Names}}' | grep -qx mv-postgres; then
  echo "  dumping Postgres -> backups/pg_${STAMP}.sql.gz"
  docker exec mv-postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "backups/pg_${STAMP}.sql.gz" \
    || echo "  (pg_dump skipped — is this the first deploy?)"
else
  echo "  no running mv-postgres yet (first deploy) — skipping DB dump"
fi
echo "  NOTE: object storage (MinIO) is not dumped here; see docs/OPERATIONS.md for mc mirror."

# ── 3. Pull images ──────────────────────────────────────────
log "Pulling images from GHCR"
if ! docker compose -f "$COMPOSE_FILE" "${PROFILE_ARGS[@]}" pull; then
  die "pull failed — if the GHCR packages are private, run: docker login ghcr.io -u <github-user>   (PAT with read:packages), or make the packages public. See scripts note."
fi

# ── 4. Up (migrations run on worker boot) ───────────────────
log "Starting stack"
docker compose -f "$COMPOSE_FILE" "${PROFILE_ARGS[@]}" up -d

# ── 5. Health check ─────────────────────────────────────────
log "Waiting for worker /health"
ok=0
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" = "1" ]; then
  curl -fsS "http://127.0.0.1:${API_PORT}/health" || true
  echo
  printf '\n\033[1;32m✅ Deploy complete and healthy.\033[0m\n'
else
  echo "worker did not become healthy in time — recent logs:"
  docker compose -f "$COMPOSE_FILE" logs --tail=60 worker || true
  die "health check failed"
fi
