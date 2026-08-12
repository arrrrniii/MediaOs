#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Docker Compose smoke test.
#  Brings up the full stack from source, waits for health, then
#  exercises the core path: create account -> project -> key ->
#  upload -> serve -> transform. Exits non-zero on any failure.
#
#  Usage: scripts/smoke-test.sh   (from the repo root)
#  CI sets a throwaway .env; locally it uses the existing one.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE="docker compose -f docker-compose.yml"
API_PORT="${API_PORT:-3000}"
BASE="http://127.0.0.1:${API_PORT}"

cleanup() {
  echo "── tearing down ──"
  $COMPOSE --profile dashboard logs --no-color --tail=40 worker || true
  $COMPOSE --profile dashboard down -v || true
}
trap cleanup EXIT

echo "── building + starting the stack ──"
# minio-setup provisions the least-privilege service accounts and must finish
# before worker/imgproxy; compose handles that via service_completed_successfully.
$COMPOSE up -d --build

echo "── waiting for the worker /health ──"
for i in $(seq 1 60); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    echo "worker healthy after ${i}s"; break
  fi
  [ "$i" = "60" ] && { echo "worker did not become healthy"; exit 1; }
  sleep 2
done

HEALTH="$(curl -fsS "${BASE}/health")"
echo "health: ${HEALTH}"
echo "${HEALTH}" | grep -q '"status":"ok"' || { echo "health status not ok"; exit 1; }

MASTER_KEY="$(grep -E '^MASTER_KEY=' .env | cut -d= -f2)"
INTERNAL_SECRET="$(grep -E '^INTERNAL_API_SECRET=' .env | cut -d= -f2)"
[ -n "$MASTER_KEY" ] || { echo "MASTER_KEY not set in .env"; exit 1; }

jqget() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }

echo "── create account (system admin) ──"
ACC_JSON="$(curl -fsS -X POST "${BASE}/api/v1/accounts" \
  -H "x-api-key: ${MASTER_KEY}" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke","email":"smoke@example.com","password":"smoke-password-123"}')"
ACCOUNT_ID="$(echo "$ACC_JSON" | jqget id)"
echo "account: ${ACCOUNT_ID}"

echo "── resolve the account's owner user ──"
LOGIN_JSON="$(curl -fsS -X POST "${BASE}/api/v1/auth/login" \
  -H "x-internal-secret: ${INTERNAL_SECRET}" -H 'Content-Type: application/json' \
  -d '{"email":"smoke@example.com","password":"smoke-password-123"}')"
USER_ID="$(echo "$LOGIN_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['user']['id'])")"
echo "user: ${USER_ID}"

sess=(-H "x-internal-secret: ${INTERNAL_SECRET}" -H "x-user-id: ${USER_ID}" -H "x-account-id: ${ACCOUNT_ID}" -H 'Content-Type: application/json')

echo "── create project ──"
PROJECT_ID="$(curl -fsS -X POST "${BASE}/api/v1/projects" "${sess[@]}" -d '{"name":"Smoke"}' | jqget id)"
echo "project: ${PROJECT_ID}"

echo "── create upload key ──"
RAW_KEY="$(curl -fsS -X POST "${BASE}/api/v1/projects/${PROJECT_ID}/keys" "${sess[@]}" \
  -d '{"name":"smoke","scopes":["upload","read"]}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('key') or d.get('api_key') or '')")"
[ -n "$RAW_KEY" ] || { echo "no api key returned"; exit 1; }

echo "── upload an image ──"
# Minimal valid PNG (1x1 would be below AVIF min; 32x32 keeps transforms valid).
python3 - <<'PY'
import struct, zlib
w = h = 32
raw = b''.join(b'\x00' + bytes((i * 7) % 256 for _ in range(w * 3)) for i in range(h))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
open('/tmp/smoke.png', 'wb').write(png)
PY
UP_JSON="$(curl -fsS -X POST "${BASE}/api/v1/upload" -H "x-api-key: ${RAW_KEY}" -F 'file=@/tmp/smoke.png')"
STORAGE_KEY="$(echo "$UP_JSON" | jqget storage_key)"
echo "uploaded: ${STORAGE_KEY}"
[ -n "$STORAGE_KEY" ] || { echo "upload failed: ${UP_JSON}"; exit 1; }

echo "── serve the original ──"
curl -fsS -o /dev/null -w 'serve http=%{http_code} type=%{content_type}\n' "${BASE}/f/${STORAGE_KEY}"

echo "── serve a transform (WebP negotiation) ──"
CT="$(curl -fsS -o /dev/null -w '%{content_type}' "${BASE}/img/fit/16/16/f/${STORAGE_KEY}")"
echo "transform content-type: ${CT}"
echo "$CT" | grep -qE 'image/(webp|avif|jpeg)' || { echo "unexpected transform type"; exit 1; }

echo "✅ smoke test passed"
