# MediaOS

**Self-hosted open-source media infrastructure platform.**

Upload, process, and serve images, videos, and files at scale. Think self-hosted Cloudinary / Imgix / Mux — with a built-in admin dashboard.

[![GitHub](https://img.shields.io/github/stars/arrrrniii/MediaOs?style=flat&logo=github&label=GitHub)](https://github.com/arrrrniii/MediaOs)
[![License](https://img.shields.io/github/license/arrrrniii/MediaOs?style=flat)](https://github.com/arrrrniii/MediaOs/blob/main/LICENSE)

---

## What is MediaOS?

MediaOS is a complete media backend you can self-host. It replaces the patchwork of S3 + image CDN + video transcoder + dashboard that most teams build from scratch.

**One `docker compose up` gives you:**

- Image upload with automatic WebP conversion
- Video upload with H.264 transcoding + thumbnail extraction
- On-the-fly image resizing (200+ resize URLs per image)
- Multi-tenant projects with scoped API keys
- Signed URLs for private file access
- Webhooks with HMAC signatures
- Per-project usage analytics
- Full admin dashboard (Next.js)
- TypeScript SDK

---

## Quick Start

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/arrrrniii/MediaOs/main/install.sh | bash
```

Pulls images, generates secure secrets, and starts all services. Done in under a minute.

### Manual setup

```bash
curl -O https://raw.githubusercontent.com/arrrrniii/MediaOs/main/docker-compose.hub.yml
curl -O https://raw.githubusercontent.com/arrrrniii/MediaOs/main/.env.example
cp .env.example .env
# Edit .env with your MASTER_KEY (generate with: node -e "console.log('mv_master_' + require('crypto').randomBytes(24).toString('hex'))")
docker compose -f docker-compose.hub.yml up -d
```

### Open the dashboard

- **Dashboard:** http://localhost:3001 (setup wizard on first launch)
- **API:** http://localhost:3000

### API-only mode (no dashboard)

```bash
# In .env, set:
COMPOSE_PROFILES=
```

Run `docker compose up -d` — only the worker API and infrastructure start. Manage everything via API.

---

## Images

| Tag | Description | Size |
|-----|-------------|------|
| `arrrrniii/mediaos:worker` | Express API server (Node.js 20 + FFmpeg + Sharp) | ~230 MB |
| `arrrrniii/mediaos:dashboard` | Next.js 15 admin panel | ~70 MB |

### Supported Architectures

Both images support **linux/amd64** and **linux/arm64** (Apple Silicon, AWS Graviton).

```bash
# Pull the worker
docker pull arrrrniii/mediaos:worker

# Pull the dashboard
docker pull arrrrniii/mediaos:dashboard
```

---

## Services

MediaOS runs as a 6-service stack:

| Service | Image | Port | Role |
|---------|-------|------|------|
| **Worker API** | `arrrrniii/mediaos:worker` | 3000 | Upload, process, serve, API |
| **Dashboard** | `arrrrniii/mediaos:dashboard` | 3001 (optional) | Admin panel, analytics |
| **PostgreSQL** | `postgres:16-alpine` | internal | Metadata, accounts, keys |
| **MinIO** | `minio/minio:latest` | internal | S3-compatible object storage |
| **Redis** | `redis:7-alpine` | internal | Rate limiting, caching |
| **imgproxy** | `darthsim/imgproxy:latest` | internal | On-the-fly image resizing |

Only the Worker API and Dashboard expose ports. All infrastructure communicates over Docker's internal network.

---

## Features

### File Processing

- **Images** — Auto WebP conversion, configurable quality, max dimension enforcement
- **Videos** — H.264 MP4 transcoding, auto thumbnail, async processing with webhooks
- **Audio** — Duration extraction, stored as-is
- **Documents** — Any file type with proper MIME handling

### Image Resizing

Every image gets instant resize URLs powered by imgproxy:

```
/f/{key}                         → Original
/img/fit/200/200/f/{key}         → Fit within 200x200
/img/fill/500/500/f/{key}        → Fill 500x500 (crop)
/img/auto/800/0/f/{key}          → Smart resize, 800px wide
```

### Dashboard

- File browser with image previews and preview modal
- Single file download and bulk ZIP export for backups
- API key management, webhook management, usage analytics
- Auto-update notification when a new release is available
- Dark/light theme, responsive design

### Multi-Tenant

- **Accounts** with multiple projects
- **Projects** with isolated storage, keys, and settings
- **API Keys** with scoped permissions (upload, read, delete, admin)
- **Rate limiting** per key via Redis

### Security

- SHA-256 hashed API keys (prefix lookup, constant-time compare)
- HMAC-SHA256 signed URLs and webhook signatures
- bcrypt password hashing
- Parameterized SQL (no injection)
- Helmet security headers

### Deployment

- One-line installer with smart port detection
- Optional dashboard (API-only mode via `COMPOSE_PROFILES=`)
- Reverse proxy configs for Nginx, Caddy, and Traefik
- One-line updater: `curl -fsSL .../update.sh | bash`
- Zero-downtime updates — data lives in Docker volumes

---

## Configuration

Key environment variables (see `.env.example` for full list):

| Variable | Required | Description |
|----------|----------|-------------|
| `MASTER_KEY` | Yes | Admin key for management API |
| `PG_PASSWORD` | Yes | PostgreSQL password |
| `MINIO_ROOT_PASSWORD` | Yes | MinIO storage password |
| `REDIS_PASSWORD` | Yes | Redis password |
| `NEXTAUTH_SECRET` | Yes | Dashboard session encryption |
| `PUBLIC_URL` | No | Public URL (default: `http://localhost:3000`) |
| `COMPOSE_PROFILES` | No | Set to `dashboard` to enable admin panel (default), empty for API-only |
| `WEBP_QUALITY` | No | Image quality 1-100 (default: `80`) |
| `VIDEO_CRF` | No | Video quality, lower=better (default: `20`) |
| `MAX_FILE_SIZE` | No | Max upload bytes (default: `104857600` / 100MB) |

---

## SDK

```bash
npm install @mediaos/sdk
```

```typescript
import { MediaOS } from '@mediaos/sdk';

const media = new MediaOS({
  url: 'https://cdn.yoursite.com',
  apiKey: 'mv_live_...',
});

// Upload
const file = await media.upload(buffer, { name: 'hero.jpg', folder: 'images' });

// Resize URL (no API call)
const thumb = media.url(file.storage_key, { width: 300, height: 300, fit: 'fill' });

// List files
const files = await media.files.list({ type: 'image', limit: 20 });
```

---

## API Example

```bash
# Upload an image
curl -X POST http://localhost:3000/api/v1/upload \
  -H "X-API-Key: mv_live_..." \
  -F "file=@photo.jpg"

# Response includes optimized WebP + resize URLs
{
  "filename": "photo-a8x3k2.webp",
  "url": "http://localhost:3000/f/proj-id/photo-a8x3k2.webp",
  "urls": {
    "thumb": "http://localhost:3000/img/fit/200/200/f/proj-id/photo-a8x3k2.webp",
    "sm": "http://localhost:3000/img/fit/400/0/f/proj-id/photo-a8x3k2.webp",
    "md": "http://localhost:3000/img/fit/800/0/f/proj-id/photo-a8x3k2.webp",
    "lg": "http://localhost:3000/img/fit/1200/0/f/proj-id/photo-a8x3k2.webp"
  },
  "type": "image",
  "size": 45200,
  "processing_ms": 124
}
```

---

## Updating

```bash
curl -fsSL https://raw.githubusercontent.com/arrrrniii/MediaOs/main/update.sh | bash
```

Or manually: `docker compose pull && docker compose up -d`. Your data is safe — everything lives in Docker volumes.

---

## Roadmap

MediaOS is evolving into a complete open-source media platform:

| Phase | Status | Description |
|-------|--------|-------------|
| **v1 — Media CDN** | Done | Upload, process, serve images/videos/files |
| **v2 — Streaming** | Next | HLS/DASH adaptive streaming, video player SDK |
| **v3 — Security** | Planned | DRM, geo-restrictions, watermarking |
| **v4 — Scale** | Planned | Multi-node, edge caching, S3/R2/B2 backends |
| **v5 — Intelligence** | Planned | AI tagging, moderation, smart thumbnails |

---

## Links

- **GitHub:** [github.com/arrrrniii/MediaOs](https://github.com/arrrrniii/MediaOs)
- **Documentation:** [GitHub README](https://github.com/arrrrniii/MediaOs#readme)
- **Issues:** [Report bugs](https://github.com/arrrrniii/MediaOs/issues)
- **Contributing:** [CONTRIBUTING.md](https://github.com/arrrrniii/MediaOs/blob/main/CONTRIBUTING.md)
- **Roadmap:** [ROADMAP.md](https://github.com/arrrrniii/MediaOs/blob/main/ROADMAP.md)

---

**MIT License** — Free to use for personal and commercial projects.

Built by [ARN](https://github.com/arrrrniii)
