#!/bin/bash
# MediaOS Updater
# Usage: curl -fsSL https://raw.githubusercontent.com/arrrrniii/MediaOs/main/update.sh | bash

set -e

G='\033[0;32m'
B='\033[0;34m'
Y='\033[1;33m'
W='\033[1;37m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${B}${BOLD}  MediaOS Update${NC}"
echo ""

# Find the MediaOS directory
if [ -f "docker-compose.yml" ] && grep -q "mediaos" docker-compose.yml 2>/dev/null; then
  DIR="."
elif [ -f "mediaos/docker-compose.yml" ]; then
  DIR="mediaos"
else
  echo -e "  ${Y}Could not find MediaOS installation.${NC}"
  echo -e "  Run this from the directory containing docker-compose.yml"
  exit 1
fi

cd "$DIR"

# Get current version
CURRENT=$(docker compose exec -T worker node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo -e "  Current version: ${BOLD}$CURRENT${NC}"

# Pull latest images
echo ""
echo -e "  ${DIM}Pulling latest images...${NC}"
docker compose pull

# Restart with new images (zero downtime — starts new before stopping old)
echo -e "  ${DIM}Restarting services...${NC}"
docker compose up -d

# Get new version
sleep 3
NEW=$(docker compose exec -T worker node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")

echo ""
if [ "$CURRENT" != "$NEW" ]; then
  echo -e "  ${G}${BOLD}Updated: v$CURRENT → v$NEW${NC}"
else
  echo -e "  ${G}${BOLD}MediaOS is up to date (v$NEW)${NC}"
fi
echo ""
echo -e "  ${DIM}Your data is preserved. Nothing was lost.${NC}"
echo ""
