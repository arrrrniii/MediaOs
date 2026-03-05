#!/bin/bash
# MediaOS Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/arrrrniii/MediaOs/main/install.sh | bash

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${BLUE}${BOLD}  MediaOS${NC}"
echo -e "  Self-hosted media infrastructure"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
  echo -e "${YELLOW}Docker is required but not installed.${NC}"
  echo "Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

# Create directory
DIR="${1:-mediaos}"
if [ -d "$DIR" ]; then
  echo -e "${YELLOW}Directory '$DIR' already exists. Using it.${NC}"
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

  # Replace defaults in .env
  $SED_CMD "s|^MASTER_KEY=.*|MASTER_KEY=$MASTER_KEY|" .env
  $SED_CMD "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$NEXTAUTH_SECRET|" .env
  $SED_CMD "s|^PG_PASSWORD=.*|PG_PASSWORD=$PG_PASSWORD|" .env
  $SED_CMD "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$MINIO_PASSWORD|" .env
  $SED_CMD "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$REDIS_PASSWORD|" .env

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
echo -e "  Dashboard:     ${BOLD}http://localhost:3001${NC}"
echo -e "  API:           ${BOLD}http://localhost:3000${NC}"
echo -e "  MinIO Console: ${BOLD}http://localhost:9001${NC}"
echo ""
echo -e "  Open the dashboard to create your admin account."
echo -e "  Your master key is saved in ${BOLD}.env${NC}"
echo ""
