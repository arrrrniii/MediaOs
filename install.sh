#!/bin/bash
# MediaOS Installer v1.1.1
# Usage: curl -fsSL https://raw.githubusercontent.com/arrrrniii/MediaOs/main/install.sh | bash

set -eo pipefail

# Colors
R='\033[0;31m'
G='\033[0;32m'
B='\033[0;34m'
Y='\033[1;33m'
M='\033[0;35m'
C='\033[0;36m'
W='\033[1;37m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

API_PORT=3000
DASHBOARD_PORT=3001
ENABLE_DASHBOARD="ask"
DIR="mediaos"

# Portable in-place sed (avoids sed -i quoting issues across macOS/Linux)
sedi() {
  local expr="$1"
  local file="$2"
  local tmp="${file}.sedtmp"
  sed "$expr" "$file" > "$tmp" && mv "$tmp" "$file"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --api-port) API_PORT="$2"; shift 2 ;;
    --dashboard-port) DASHBOARD_PORT="$2"; shift 2 ;;
    --no-dashboard) ENABLE_DASHBOARD="no"; shift ;;
    --with-dashboard) ENABLE_DASHBOARD="yes"; shift ;;
    --help|-h)
      echo "MediaOS Installer"
      echo ""
      echo "Usage: install.sh [OPTIONS] [DIRECTORY]"
      echo ""
      echo "Options:"
      echo "  --api-port PORT        API port (default: 3000)"
      echo "  --dashboard-port PORT  Dashboard port (default: 3001)"
      echo "  --no-dashboard         Install without the admin dashboard"
      echo "  --with-dashboard       Install with the admin dashboard (skip prompt)"
      echo "  -h, --help             Show this help"
      exit 0
      ;;
    -*) echo "Unknown option: $1"; exit 1 ;;
    *) DIR="$1"; shift ;;
  esac
done

# Clear screen
clear 2>/dev/null || true

# Animated banner
sleep 0.1
echo ""
echo -e "${M}  ╔══════════════════════════════════════════════════════════╗${NC}"
sleep 0.05
echo -e "${M}  ║${NC}                                                          ${M}║${NC}"
sleep 0.05
echo -e "${M}  ║${NC}   ${W}${BOLD}███╗   ███╗███████╗██████╗ ██╗ █████╗  ██████╗ ███████╗${NC} ${M}║${NC}"
sleep 0.05
echo -e "${M}  ║${NC}   ${W}${BOLD}████╗ ████║██╔════╝██╔══██╗██║██╔══██╗██╔═══██╗██╔════╝${NC} ${M}║${NC}"
sleep 0.05
echo -e "${M}  ║${NC}   ${W}${BOLD}██╔████╔██║█████╗  ██║  ██║██║███████║██║   ██║███████╗${NC} ${M}║${NC}"
sleep 0.05
echo -e "${M}  ║${NC}   ${W}${BOLD}██║╚██╔╝██║██╔══╝  ██║  ██║██║██╔══██║██║   ██║╚════██║${NC} ${M}║${NC}"
sleep 0.05
echo -e "${M}  ║${NC}   ${W}${BOLD}██║ ╚═╝ ██║███████╗██████╔╝██║██║  ██║╚██████╔╝███████║${NC} ${M}║${NC}"
sleep 0.05
echo -e "${M}  ║${NC}   ${W}${BOLD}╚═╝     ╚═╝╚══════╝╚═════╝ ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝${NC} ${M}║${NC}"
sleep 0.05
echo -e "${M}  ║${NC}                                                          ${M}║${NC}"
sleep 0.05
echo -e "${M}  ║${NC}   ${C}Self-hosted media infrastructure${NC}                        ${M}║${NC}"
sleep 0.05
echo -e "${M}  ║${NC}   ${DIM}Upload, process, and serve files at scale${NC}               ${M}║${NC}"
sleep 0.05
echo -e "${M}  ║${NC}                                                          ${M}║${NC}"
sleep 0.05
echo -e "${M}  ╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
sleep 0.2

# Ask about dashboard if not specified via flag
if [ "$ENABLE_DASHBOARD" = "ask" ]; then
  echo -e "  ${W}Install the admin dashboard?${NC} ${DIM}(not required, API works standalone)${NC}"
  echo -ne "  ${BOLD}[Y/n]:${NC} "
  read -r DASH_ANSWER < /dev/tty 2>/dev/null || DASH_ANSWER="y"
  case "$DASH_ANSWER" in
    [nN]*) ENABLE_DASHBOARD="no" ;;
    *) ENABLE_DASHBOARD="yes" ;;
  esac
  echo ""
fi

# Step indicator
step() {
  local num=$1
  local total=$2
  local label=$3
  echo ""
  echo -e "  ${M}[$num/$total]${NC} ${BOLD}$label${NC}"
  echo -e "  ${DIM}──────────────────────────────────────${NC}"
}

# Spinner animation
spin() {
  local pid=$1
  local msg=$2
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    echo -ne "\r  ${C}${frames[$i]}${NC} $msg"
    i=$(( (i + 1) % ${#frames[@]} ))
    sleep 0.1
  done
  local exit_code=0
  wait "$pid" 2>/dev/null || exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    echo -e "\r  ${G}✓${NC} $msg"
  else
    echo -e "\r  ${R}✗${NC} $msg ${DIM}(exit code $exit_code)${NC}"
  fi
  return $exit_code
}

TOTAL_STEPS=7

# ─── Step 1: Check Docker ────────────────────────────────────
step "1" "$TOTAL_STEPS" "Checking requirements"

if ! command -v docker &> /dev/null; then
  echo -e "  ${R}✗${NC} Docker is not installed"
  echo ""
  echo -e "  Install Docker: ${W}https://docs.docker.com/get-docker/${NC}"
  exit 1
fi
echo -e "  ${G}✓${NC} Docker installed"

if ! docker info &> /dev/null; then
  echo -e "  ${R}✗${NC} Docker is not running"
  echo ""
  echo -e "  Start Docker and try again."
  exit 1
fi
echo -e "  ${G}✓${NC} Docker running"

# ─── Step 2: Check ports ─────────────────────────────────────
step "2" "$TOTAL_STEPS" "Checking ports"

port_in_use() {
  if command -v ss &>/dev/null; then
    local count
    count=$(ss -tln "sport = :$1" 2>/dev/null | grep -c LISTEN || true)
    [ "$count" -gt 0 ] && return 0
  fi
  if command -v lsof &>/dev/null; then
    lsof -iTCP:"$1" -sTCP:LISTEN -P -n &>/dev/null && return 0
  fi
  if command -v netstat &>/dev/null; then
    netstat -tlnp 2>/dev/null | grep -q ":$1 " && return 0
  fi
  return 1
}

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
}

if port_in_use "$API_PORT"; then
  API_PORT=$(find_free_port "$((API_PORT + 1))")
  echo -e "  ${Y}~${NC} Port 3000 busy → using ${BOLD}$API_PORT${NC}"
else
  echo -e "  ${G}✓${NC} API port ${BOLD}$API_PORT${NC}"
fi

if [ "$ENABLE_DASHBOARD" = "yes" ]; then
  if port_in_use "$DASHBOARD_PORT"; then
    DASHBOARD_PORT=$(find_free_port "$((DASHBOARD_PORT + 1))")
    echo -e "  ${Y}~${NC} Port 3001 busy → using ${BOLD}$DASHBOARD_PORT${NC}"
  else
    echo -e "  ${G}✓${NC} Dashboard port ${BOLD}$DASHBOARD_PORT${NC}"
  fi
else
  echo -e "  ${DIM}  Dashboard disabled — skipping port check${NC}"
fi

# ─── Step 3: Setup directory ─────────────────────────────────
step "3" "$TOTAL_STEPS" "Setting up project"

if [ -d "$DIR" ]; then
  echo -e "  ${Y}~${NC} Directory ${BOLD}$DIR/${NC} exists, using it"
  cd "$DIR"
  # Always stop old containers to avoid port conflicts
  if [ -f docker-compose.yml ]; then
    echo -e "  ${DIM}  Stopping old containers...${NC}"
    docker compose down --remove-orphans > /dev/null 2>&1 || true
    echo -e "  ${G}✓${NC} Old containers stopped"
  fi
else
  mkdir -p "$DIR"
  echo -e "  ${G}✓${NC} Created ${BOLD}$DIR/${NC}"
  cd "$DIR"
fi

(curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/arrrrniii/MediaOs/main/docker-compose.hub.yml) &
spin $! "Downloading docker-compose.yml"

(curl -fsSL -o .env.example https://raw.githubusercontent.com/arrrrniii/MediaOs/main/.env.example) &
spin $! "Downloading .env.example"

# ─── Step 4: Generate secrets ─────────────────────────────────
step "4" "$TOTAL_STEPS" "Generating secrets"

if [ ! -f .env ]; then
  cp .env.example .env

  MASTER_KEY="mv_master_$(openssl rand -hex 24)"
  NEXTAUTH_SECRET="$(openssl rand -hex 32)"
  PG_PASSWORD="$(openssl rand -hex 16)"
  MINIO_PASSWORD="$(openssl rand -hex 16)"
  REDIS_PASSWORD="$(openssl rand -hex 16)"

  sedi "s|^MASTER_KEY=.*|MASTER_KEY=$MASTER_KEY|" .env
  sedi "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$NEXTAUTH_SECRET|" .env
  sedi "s|^PG_PASSWORD=.*|PG_PASSWORD=$PG_PASSWORD|" .env
  sedi "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$MINIO_PASSWORD|" .env
  sedi "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$REDIS_PASSWORD|" .env

  echo -e "  ${G}✓${NC} Master key generated"
  echo -e "  ${G}✓${NC} Database password generated"
  echo -e "  ${G}✓${NC} Redis password generated"
  echo -e "  ${G}✓${NC} MinIO password generated"
  echo -e "  ${G}✓${NC} NextAuth secret generated"
else
  echo -e "  ${Y}~${NC} .env already exists, keeping existing secrets"
  MASTER_KEY=$(grep '^MASTER_KEY=' .env | cut -d= -f2)
fi

# Always update ports and profiles (handles re-runs where ports changed)
sedi "s|^API_PORT=.*|API_PORT=$API_PORT|" .env
sedi "s|^PUBLIC_URL=.*|PUBLIC_URL=http://localhost:$API_PORT|" .env
sedi "s|^DASHBOARD_PORT=.*|DASHBOARD_PORT=$DASHBOARD_PORT|" .env
sedi "s|^DASHBOARD_URL=.*|DASHBOARD_URL=http://localhost:$DASHBOARD_PORT|" .env
if [ "$ENABLE_DASHBOARD" = "yes" ]; then
  sedi "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=dashboard|" .env
else
  sedi "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=|" .env
fi
echo -e "  ${G}✓${NC} Ports configured (API: $API_PORT)"

# ─── Step 5: Create admin account ─────────────────────────────
step "5" "$TOTAL_STEPS" "Admin account"

echo -e "  ${W}Create your admin account${NC}"
echo ""

echo -ne "  ${BOLD}Name:${NC} "
read -r ADMIN_NAME < /dev/tty 2>/dev/null || ADMIN_NAME="Admin"
ADMIN_NAME="${ADMIN_NAME:-Admin}"

echo -ne "  ${BOLD}Email:${NC} "
read -r ADMIN_EMAIL < /dev/tty 2>/dev/null || ADMIN_EMAIL=""

while [ -z "$ADMIN_EMAIL" ]; do
  echo -e "  ${R}Email is required${NC}"
  echo -ne "  ${BOLD}Email:${NC} "
  read -r ADMIN_EMAIL < /dev/tty 2>/dev/null || ADMIN_EMAIL=""
done

echo ""
echo -e "  ${BOLD}Password:${NC}"
echo -e "    ${DIM}1)${NC} Auto-generate secure password"
echo -e "    ${DIM}2)${NC} Enter manually"
echo -ne "  ${BOLD}[1/2]:${NC} "
read -r PASS_CHOICE < /dev/tty 2>/dev/null || PASS_CHOICE="1"

if [ "$PASS_CHOICE" = "2" ]; then
  echo -ne "  ${BOLD}Password (min 8 chars):${NC} "
  read -rs ADMIN_PASSWORD < /dev/tty 2>/dev/null || ADMIN_PASSWORD=""
  echo ""
  while [ ${#ADMIN_PASSWORD} -lt 8 ]; do
    echo -e "  ${R}Password must be at least 8 characters${NC}"
    echo -ne "  ${BOLD}Password (min 8 chars):${NC} "
    read -rs ADMIN_PASSWORD < /dev/tty 2>/dev/null || ADMIN_PASSWORD=""
    echo ""
  done
  PASS_DISPLAY="${DIM}(hidden)${NC}"
else
  ADMIN_PASSWORD="$(openssl rand -base64 16 | tr -d '=/+' | head -c 20)"
  PASS_DISPLAY="${BOLD}$ADMIN_PASSWORD${NC}"
fi

grep -q '^ADMIN_NAME=' .env && sedi "s|^ADMIN_NAME=.*|ADMIN_NAME=$ADMIN_NAME|" .env || echo "ADMIN_NAME=$ADMIN_NAME" >> .env
grep -q '^ADMIN_EMAIL=' .env && sedi "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=$ADMIN_EMAIL|" .env || echo "ADMIN_EMAIL=$ADMIN_EMAIL" >> .env
grep -q '^ADMIN_PASSWORD=' .env && sedi "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PASSWORD|" .env || echo "ADMIN_PASSWORD=$ADMIN_PASSWORD" >> .env

echo ""
echo -e "  ${G}✓${NC} Account: ${BOLD}$ADMIN_NAME${NC} <$ADMIN_EMAIL>"

# ─── Step 6: Pull images ─────────────────────────────────────
step "6" "$TOTAL_STEPS" "Pulling Docker images"

(docker pull arrrrniii/mediaos:worker -q > /dev/null 2>&1) &
spin $! "arrrrniii/mediaos:worker" || true

if [ "$ENABLE_DASHBOARD" = "yes" ]; then
  (docker pull arrrrniii/mediaos:dashboard -q > /dev/null 2>&1) &
  spin $! "arrrrniii/mediaos:dashboard" || true
fi

echo -e "  ${G}✓${NC} postgres:16-alpine ${DIM}(pulled on start)${NC}"
echo -e "  ${G}✓${NC} redis:7-alpine ${DIM}(pulled on start)${NC}"
echo -e "  ${G}✓${NC} minio/minio:latest ${DIM}(pulled on start)${NC}"
echo -e "  ${G}✓${NC} darthsim/imgproxy:latest ${DIM}(pulled on start)${NC}"

# ─── Step 7: Start ───────────────────────────────────────────
if [ "$ENABLE_DASHBOARD" = "yes" ]; then
  SVC_COUNT=6
else
  SVC_COUNT=5
fi

step "7" "$TOTAL_STEPS" "Starting MediaOS"

echo -e "  ${DIM}Pulling remaining images and starting services...${NC}"
echo -e "  ${DIM}This may take a few minutes on first install.${NC}"
echo ""

COMPOSE_LOG=$(mktemp)
docker compose up -d > "$COMPOSE_LOG" 2>&1 || true

# Show the output
while IFS= read -r line; do
  echo -e "  ${DIM}  $line${NC}"
done < "$COMPOSE_LOG"
rm -f "$COMPOSE_LOG"

sleep 3

# Check if all expected services are running
RUNNING=$(docker compose ps --status running -q 2>/dev/null | wc -l | tr -d ' ')
if [ "$ENABLE_DASHBOARD" = "yes" ]; then
  EXPECTED=6
else
  EXPECTED=5
fi

if [ "$RUNNING" -lt "$EXPECTED" ]; then
  echo ""
  echo -e "  ${R}✗${NC} Some services failed to start ($RUNNING/$EXPECTED running):"
  echo ""
  docker compose ps --format "table {{.Name}}\t{{.Status}}" 2>/dev/null | while IFS= read -r line; do
    echo -e "    $line"
  done
  echo ""
  echo -e "  ${DIM}Fix the issue and run:${NC} ${BOLD}cd $(pwd) && docker compose up -d${NC}"
  echo -e "  ${DIM}Your secrets are saved in${NC} ${BOLD}$(pwd)/.env${NC}"
  exit 1
fi

echo ""
echo -e "  ${G}✓${NC} All $EXPECTED services running"

# ─── Done! ────────────────────────────────────────────────────
echo ""
echo ""
echo -e "  ${G}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${G}║${NC}                                                              ${G}║${NC}"
echo -e "  ${G}║${NC}   ${G}${BOLD}MediaOS is running!${NC}                                         ${G}║${NC}"
BC=${G}
echo -e "  ${BC}║${NC}                                                              ${BC}║${NC}"
echo -e "  ${BC}║${NC}   ${W}API${NC}         →  ${BOLD}http://localhost:$API_PORT${NC}"
if [ "$ENABLE_DASHBOARD" = "yes" ]; then
echo -e "  ${BC}║${NC}   ${W}Dashboard${NC}   →  ${BOLD}http://localhost:$DASHBOARD_PORT${NC}"
fi
echo -e "  ${BC}║${NC}                                                              ${BC}║${NC}"
echo -e "  ${BC}║${NC}   ${W}Master Key${NC}  →  ${BOLD}$MASTER_KEY${NC}"
echo -e "  ${BC}║${NC}                                                              ${BC}║${NC}"
echo -e "  ${BC}║${NC}   ${W}Admin${NC}       →  ${BOLD}$ADMIN_EMAIL${NC}"
echo -e "  ${BC}║${NC}   ${W}Password${NC}    →  $PASS_DISPLAY"
echo -e "  ${BC}║${NC}                                                              ${BC}║${NC}"
if [ "$ENABLE_DASHBOARD" = "yes" ]; then
echo -e "  ${BC}║${NC}   ${DIM}Open the dashboard to sign in.${NC}                              ${BC}║${NC}"
else
echo -e "  ${BC}║${NC}   ${DIM}Docs: github.com/arrrrniii/MediaOs#api-reference${NC}            ${BC}║${NC}"
fi
echo -e "  ${BC}║${NC}   ${DIM}Save these credentials! Shown only once.${NC}                    ${BC}║${NC}"
echo -e "  ${BC}║${NC}   ${DIM}All secrets saved in${NC} ${BOLD}$(pwd)/.env${NC}"
echo -e "  ${BC}║${NC}                                                              ${BC}║${NC}"
echo -e "  ${BC}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${DIM}Docs:  https://github.com/arrrrniii/MediaOs${NC}"
echo -e "  ${DIM}Star the repo if you like it!${NC}"
echo ""
