#!/bin/bash
# MediaOS Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/arrrrniii/MediaOs/main/install.sh | bash
#
# Custom ports:
#   curl -fsSL https://raw.githubusercontent.com/arrrrniii/MediaOs/main/install.sh | bash -s -- --api-port 4000 --dashboard-port 4001
#
# Custom directory:
#   curl -fsSL https://raw.githubusercontent.com/arrrrniii/MediaOs/main/install.sh | bash -s -- myproject

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'
BOLD='\033[1m'

# Default ports
API_PORT=3000
DASHBOARD_PORT=3001
PG_PORT=5432
REDIS_PORT=6379
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001
DIR="mediaos"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --api-port) API_PORT="$2"; shift 2 ;;
    --dashboard-port) DASHBOARD_PORT="$2"; shift 2 ;;
    --pg-port) PG_PORT="$2"; shift 2 ;;
    --redis-port) REDIS_PORT="$2"; shift 2 ;;
    --minio-port) MINIO_PORT="$2"; shift 2 ;;
    --minio-console-port) MINIO_CONSOLE_PORT="$2"; shift 2 ;;
    --help|-h)
      echo "MediaOS Installer"
      echo ""
      echo "Usage: install.sh [OPTIONS] [DIRECTORY]"
      echo ""
      echo "Options:"
      echo "  --api-port PORT            Worker API port (default: 3000)"
      echo "  --dashboard-port PORT      Dashboard port (default: 3001)"
      echo "  --pg-port PORT             PostgreSQL port (default: 5432)"
      echo "  --redis-port PORT          Redis port (default: 6379)"
      echo "  --minio-port PORT          MinIO S3 port (default: 9000)"
      echo "  --minio-console-port PORT  MinIO console port (default: 9001)"
      echo "  -h, --help                 Show this help"
      exit 0
      ;;
    -*) echo "Unknown option: $1"; exit 1 ;;
    *) DIR="$1"; shift ;;
  esac
done

echo ""
echo -e "${BLUE}${BOLD}  MediaOS${NC}"
echo -e "  Self-hosted media infrastructure"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
  echo -e "${RED}  Docker is required but not installed.${NC}"
  echo "  Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker info &> /dev/null; then
  echo -e "${RED}  Docker is not running. Please start Docker first.${NC}"
  exit 1
fi

# Check if a port is in use
port_in_use() {
  if command -v lsof &>/dev/null; then
    lsof -i :"$1" -sTCP:LISTEN &>/dev/null 2>&1
  elif command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep -q ":$1 "
  elif command -v netstat &>/dev/null; then
    netstat -tlnp 2>/dev/null | grep -q ":$1 "
  else
    return 1
  fi
}

# Find the next available port starting from a given port
find_free_port() {
  local port=$1
  local max=$((port + 100))
  while [ "$port" -lt "$max" ]; do
    if ! port_in_use "$port"; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done
  echo "$1"
  return 1
}

# Auto-resolve port conflicts
resolve_port() {
  local port=$1
  local name=$2
  local default=$3
  if port_in_use "$port"; then
    local new_port
    new_port=$(find_free_port "$((port + 1))")
    echo -e "  ${YELLOW}Port $port ($name) is busy${NC} → using ${BOLD}$new_port${NC}"
    echo "$new_port"
  else
    echo "$port"
  fi
}

# Resolve all ports (capture just the port number from last line)
API_PORT_RESULT=$(resolve_port "$API_PORT" "API" 3000)
API_PORT=$(echo "$API_PORT_RESULT" | tail -1)

DASHBOARD_PORT_RESULT=$(resolve_port "$DASHBOARD_PORT" "Dashboard" 3001)
DASHBOARD_PORT=$(echo "$DASHBOARD_PORT_RESULT" | tail -1)

PG_PORT_RESULT=$(resolve_port "$PG_PORT" "PostgreSQL" 5432)
PG_PORT=$(echo "$PG_PORT_RESULT" | tail -1)

REDIS_PORT_RESULT=$(resolve_port "$REDIS_PORT" "Redis" 6379)
REDIS_PORT=$(echo "$REDIS_PORT_RESULT" | tail -1)

MINIO_PORT_RESULT=$(resolve_port "$MINIO_PORT" "MinIO" 9000)
MINIO_PORT=$(echo "$MINIO_PORT_RESULT" | tail -1)

MINIO_CONSOLE_PORT_RESULT=$(resolve_port "$MINIO_CONSOLE_PORT" "MinIO Console" 9001)
MINIO_CONSOLE_PORT=$(echo "$MINIO_CONSOLE_PORT_RESULT" | tail -1)

# Print any conflict messages (lines before the port number)
for result in "$API_PORT_RESULT" "$DASHBOARD_PORT_RESULT" "$PG_PORT_RESULT" "$REDIS_PORT_RESULT" "$MINIO_PORT_RESULT" "$MINIO_CONSOLE_PORT_RESULT"; do
  lines=$(echo "$result" | wc -l)
  if [ "$lines" -gt 1 ]; then
    echo "$result" | head -n -1
  fi
done

echo ""
echo -e "  ${DIM}Ports:${NC} API=${BOLD}$API_PORT${NC}  Dashboard=${BOLD}$DASHBOARD_PORT${NC}  PG=${BOLD}$PG_PORT${NC}  Redis=${BOLD}$REDIS_PORT${NC}  MinIO=${BOLD}$MINIO_PORT${NC}/${BOLD}$MINIO_CONSOLE_PORT${NC}"

# Create directory
if [ -d "$DIR" ]; then
  echo -e "  ${YELLOW}Directory '$DIR' already exists. Using it.${NC}"
else
  mkdir -p "$DIR"
  echo -e "  Created ${BOLD}$DIR/${NC}"
fi
cd "$DIR"

# Download files
echo -e "  Downloading configuration..."
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/arrrrniii/MediaOs/main/docker-compose.hub.yml
curl -fsSL -o .env.example https://raw.githubusercontent.com/arrrrniii/MediaOs/main/.env.example

# Generate .env if it doesn't exist
if [ ! -f .env ]; then
  cp .env.example .env

  # Generate secrets
  MASTER_KEY="mv_master_$(openssl rand -hex 24)"
  NEXTAUTH_SECRET="$(openssl rand -hex 32)"
  PG_PASSWORD="$(openssl rand -hex 16)"
  MINIO_PASSWORD="$(openssl rand -hex 16)"
  REDIS_PASSWORD="$(openssl rand -hex 16)"

  # Detect OS for sed compatibility
  if [[ "$OSTYPE" == "darwin"* ]]; then
    SED_CMD="sed -i ''"
  else
    SED_CMD="sed -i"
  fi

  # Replace secrets
  $SED_CMD "s|^MASTER_KEY=.*|MASTER_KEY=$MASTER_KEY|" .env
  $SED_CMD "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$NEXTAUTH_SECRET|" .env
  $SED_CMD "s|^PG_PASSWORD=.*|PG_PASSWORD=$PG_PASSWORD|" .env
  $SED_CMD "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$MINIO_PASSWORD|" .env
  $SED_CMD "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$REDIS_PASSWORD|" .env

  # Set ports
  $SED_CMD "s|^API_PORT=.*|API_PORT=$API_PORT|" .env
  $SED_CMD "s|^DASHBOARD_PORT=.*|DASHBOARD_PORT=$DASHBOARD_PORT|" .env
  $SED_CMD "s|^PG_PORT=.*|PG_PORT=$PG_PORT|" .env
  $SED_CMD "s|^REDIS_PORT=.*|REDIS_PORT=$REDIS_PORT|" .env
  $SED_CMD "s|^MINIO_CONSOLE_PORT=.*|MINIO_CONSOLE_PORT=$MINIO_CONSOLE_PORT|" .env

  # Set URLs with correct ports
  $SED_CMD "s|^PUBLIC_URL=.*|PUBLIC_URL=http://localhost:$API_PORT|" .env
  $SED_CMD "s|^DASHBOARD_URL=.*|DASHBOARD_URL=http://localhost:$DASHBOARD_PORT|" .env

  # Clean up macOS sed backup files
  rm -f .env''

  echo -e "  Generated ${BOLD}.env${NC} with secure random secrets"
else
  echo -e "  ${YELLOW}.env already exists, skipping${NC}"
fi

# Pull images
echo ""
echo -e "  Pulling Docker images..."
docker pull arrrrniii/mediaos:worker
docker pull arrrrniii/mediaos:dashboard

# Start
echo ""
echo -e "  Starting MediaOS..."
docker compose up -d

echo ""
echo -e "${GREEN}${BOLD}  MediaOS is running!${NC}"
echo ""
echo -e "  Dashboard:     ${BOLD}http://localhost:$DASHBOARD_PORT${NC}"
echo -e "  API:           ${BOLD}http://localhost:$API_PORT${NC}"
echo -e "  MinIO Console: ${BOLD}http://localhost:$MINIO_CONSOLE_PORT${NC}"
echo ""
echo -e "  Open the dashboard to create your admin account."
echo -e "  Your master key and all secrets are saved in ${BOLD}$(pwd)/.env${NC}"
echo ""
