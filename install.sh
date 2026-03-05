#!/bin/bash
# MediaOS Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/arrrrniii/MediaOs/main/install.sh | bash

set -e

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
DIR="mediaos"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --api-port) API_PORT="$2"; shift 2 ;;
    --dashboard-port) DASHBOARD_PORT="$2"; shift 2 ;;
    --help|-h)
      echo "MediaOS Installer"
      echo ""
      echo "Usage: install.sh [OPTIONS] [DIRECTORY]"
      echo ""
      echo "Options:"
      echo "  --api-port PORT        API port (default: 3000)"
      echo "  --dashboard-port PORT  Dashboard port (default: 3001)"
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

# Step indicator
step() {
  local num=$1
  local label=$2
  echo ""
  echo -e "  ${M}[$num/6]${NC} ${BOLD}$label${NC}"
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
  wait "$pid" 2>/dev/null
  echo -e "\r  ${G}✓${NC} $msg"
}

# ─── Step 1: Check Docker ────────────────────────────────────
step "1" "Checking requirements"

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
step "2" "Checking ports"

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

if port_in_use "$DASHBOARD_PORT"; then
  DASHBOARD_PORT=$(find_free_port "$((DASHBOARD_PORT + 1))")
  echo -e "  ${Y}~${NC} Port 3001 busy → using ${BOLD}$DASHBOARD_PORT${NC}"
else
  echo -e "  ${G}✓${NC} Dashboard port ${BOLD}$DASHBOARD_PORT${NC}"
fi

# ─── Step 3: Setup directory ─────────────────────────────────
step "3" "Setting up project"

if [ -d "$DIR" ]; then
  echo -e "  ${Y}~${NC} Directory ${BOLD}$DIR/${NC} exists, using it"
else
  mkdir -p "$DIR"
  echo -e "  ${G}✓${NC} Created ${BOLD}$DIR/${NC}"
fi
cd "$DIR"

(curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/arrrrniii/MediaOs/main/docker-compose.hub.yml) &
spin $! "Downloading docker-compose.yml"

(curl -fsSL -o .env.example https://raw.githubusercontent.com/arrrrniii/MediaOs/main/.env.example) &
spin $! "Downloading .env.example"

# ─── Step 4: Generate secrets ─────────────────────────────────
step "4" "Generating secrets"

if [ ! -f .env ]; then
  cp .env.example .env

  MASTER_KEY="mv_master_$(openssl rand -hex 24)"
  NEXTAUTH_SECRET="$(openssl rand -hex 32)"
  PG_PASSWORD="$(openssl rand -hex 16)"
  MINIO_PASSWORD="$(openssl rand -hex 16)"
  REDIS_PASSWORD="$(openssl rand -hex 16)"

  if [[ "$OSTYPE" == "darwin"* ]]; then
    SED_CMD="sed -i ''"
  else
    SED_CMD="sed -i"
  fi

  $SED_CMD "s|^MASTER_KEY=.*|MASTER_KEY=$MASTER_KEY|" .env
  $SED_CMD "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$NEXTAUTH_SECRET|" .env
  $SED_CMD "s|^PG_PASSWORD=.*|PG_PASSWORD=$PG_PASSWORD|" .env
  $SED_CMD "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$MINIO_PASSWORD|" .env
  $SED_CMD "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$REDIS_PASSWORD|" .env
  $SED_CMD "s|^API_PORT=.*|API_PORT=$API_PORT|" .env
  $SED_CMD "s|^DASHBOARD_PORT=.*|DASHBOARD_PORT=$DASHBOARD_PORT|" .env
  $SED_CMD "s|^PUBLIC_URL=.*|PUBLIC_URL=http://localhost:$API_PORT|" .env
  $SED_CMD "s|^DASHBOARD_URL=.*|DASHBOARD_URL=http://localhost:$DASHBOARD_PORT|" .env
  # Ensure dashboard profile is enabled
  grep -q '^COMPOSE_PROFILES' .env || echo "COMPOSE_PROFILES=dashboard" >> .env

  rm -f .env''

  echo -e "  ${G}✓${NC} Master key generated"
  echo -e "  ${G}✓${NC} Database password generated"
  echo -e "  ${G}✓${NC} Redis password generated"
  echo -e "  ${G}✓${NC} MinIO password generated"
  echo -e "  ${G}✓${NC} NextAuth secret generated"
else
  echo -e "  ${Y}~${NC} .env already exists, keeping existing secrets"
fi

# ─── Step 5: Pull images ─────────────────────────────────────
step "5" "Pulling Docker images"

(docker pull arrrrniii/mediaos:worker -q > /dev/null 2>&1) &
spin $! "arrrrniii/mediaos:worker"

(docker pull arrrrniii/mediaos:dashboard -q > /dev/null 2>&1) &
spin $! "arrrrniii/mediaos:dashboard"

echo -e "  ${G}✓${NC} postgres:16-alpine ${DIM}(pulled on start)${NC}"
echo -e "  ${G}✓${NC} redis:7-alpine ${DIM}(pulled on start)${NC}"
echo -e "  ${G}✓${NC} minio/minio:latest ${DIM}(pulled on start)${NC}"
echo -e "  ${G}✓${NC} darthsim/imgproxy:latest ${DIM}(pulled on start)${NC}"

# ─── Step 6: Start ───────────────────────────────────────────
step "6" "Starting MediaOS"

(docker compose up -d > /dev/null 2>&1) &
spin $! "Starting 6 services"

sleep 1

# ─── Done! ────────────────────────────────────────────────────
echo ""
echo ""
echo -e "  ${G}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "  ${G}║${NC}                                                      ${G}║${NC}"
echo -e "  ${G}║${NC}   ${G}${BOLD}MediaOS is running!${NC}                                 ${G}║${NC}"
echo -e "  ${G}║${NC}                                                      ${G}║${NC}"
echo -e "  ${G}║${NC}   ${W}Dashboard${NC}  →  ${BOLD}http://localhost:$DASHBOARD_PORT${NC}"
echo -e "  ${G}║${NC}   ${W}API${NC}        →  ${BOLD}http://localhost:$API_PORT${NC}"
echo -e "  ${G}║${NC}                                                      ${G}║${NC}"
echo -e "  ${G}║${NC}   ${DIM}Open the dashboard to create your admin account.${NC}   ${G}║${NC}"
echo -e "  ${G}║${NC}   ${DIM}Secrets saved in${NC} ${BOLD}$(pwd)/.env${NC}"
echo -e "  ${G}║${NC}                                                      ${G}║${NC}"
echo -e "  ${G}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${DIM}Docs:  https://github.com/arrrrniii/MediaOs${NC}"
echo -e "  ${DIM}Star the repo if you like it!${NC}"
echo ""
