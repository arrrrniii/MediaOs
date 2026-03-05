<p align="center">
  <h1 align="center">MediaOS</h1>
  <p align="center">
    Self-hosted media CDN platform. Upload, process, and serve images, videos, and files at scale.
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> &middot;
    <a href="#features">Features</a> &middot;
    <a href="#api-reference">API Reference</a> &middot;
    <a href="#sdk">SDK</a> &middot;
    <a href="#dashboard">Dashboard</a> &middot;
    <a href="#deployment">Deployment</a>
  </p>
  <p align="center">
    <a href="https://hub.docker.com/r/arrrrniii/mediaos"><img src="https://img.shields.io/docker/pulls/arrrrniii/mediaos?style=flat&logo=docker&label=Docker%20Pulls" alt="Docker Pulls" /></a>
    <a href="https://hub.docker.com/r/arrrrniii/mediaos"><img src="https://img.shields.io/docker/image-size/arrrrniii/mediaos/worker?style=flat&logo=docker&label=Worker" alt="Worker Size" /></a>
    <a href="https://hub.docker.com/r/arrrrniii/mediaos"><img src="https://img.shields.io/docker/image-size/arrrrniii/mediaos/dashboard?style=flat&logo=docker&label=Dashboard" alt="Dashboard Size" /></a>
    <a href="https://www.npmjs.com/package/@mediavault/sdk"><img src="https://img.shields.io/npm/v/@mediavault/sdk?style=flat&logo=npm&label=SDK" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/arrrrniii/MediaOs?style=flat" alt="License" /></a>
  </p>
</p>

---

https://github.com/user-attachments/assets/0b464899-e7e7-4de3-8c76-b6383be56338

---

**MediaOS** is an open-source, self-hosted media CDN built for developers. It handles the full lifecycle of media files — upload, process, store, transform, and serve — so you don't have to stitch together S3, image resizers, video transcoders, and CDN configs yourself.

Upload an image and get back an optimized WebP with instant resize URLs. Upload a video and get an H.264 MP4 with a thumbnail. Everything is served with proper caching headers, range requests, and CORS — ready for production.

## Quick Start

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/arrrrniii/MediaOs/main/install.sh | bash
```

This pulls the pre-built Docker images, generates secure secrets, and starts everything. Done in under a minute.

- **Dashboard:** `http://localhost:3001` (setup wizard creates your admin account)
- **API:** `http://localhost:3000`
- **MinIO Console:** `http://localhost:9001`

### Manual setup (Docker Hub)

```bash
curl -O https://raw.githubusercontent.com/arrrrniii/MediaOs/main/docker-compose.hub.yml
curl -O https://raw.githubusercontent.com/arrrrniii/MediaOs/main/.env.example
cp .env.example .env

# Generate a master key and add to .env
node -e "console.log('mv_master_' + require('crypto').randomBytes(24).toString('hex'))"

docker compose -f docker-compose.hub.yml up -d
```

### Build from source

```bash
git clone https://github.com/arrrrniii/MediaOs.git
cd MediaOs
cp .env.example .env
```

Generate your master key:

```bash
node -e "console.log('mv_master_' + require('crypto').randomBytes(24).toString('hex'))"
```

Paste the output into `.env` as the `MASTER_KEY` value.

Start everything:

```bash
docker compose up -d
```

This starts 6 services:

| Service | Port | Description |
|---------|------|-------------|
| **Worker API** | `3000` | Express API — upload, serve, manage |
| **Dashboard** | `3001` | Next.js admin panel |
| **PostgreSQL** | `5432` | Database |
| **MinIO** | `9000` / `9001` | S3-compatible object storage |
| **Redis** | `6379` | Rate limiting and caching |
| **imgproxy** | (internal) | On-the-fly image resizing |

### 4. Create your admin account

Open the dashboard at `http://localhost:3001`. On first launch, a **setup wizard** will guide you through creating your admin account.

Alternatively, create an account via environment variables (headless):

```bash
# Add to .env before starting
ADMIN_EMAIL=admin@yoursite.com
ADMIN_PASSWORD=your_secure_password
```

Or via the API:

```bash
curl -X POST http://localhost:3000/api/v1/accounts \
  -H "X-API-Key: YOUR_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Admin", "email": "admin@yoursite.com", "password": "your_password"}'
```

Then create a project and API key from the dashboard, or via API:

```bash
# Create a project
curl -X POST http://localhost:3000/api/v1/projects \
  -H "X-API-Key: YOUR_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"account_id": "ACCOUNT_ID", "name": "my-app", "slug": "my-app"}'

# Create an API key
curl -X POST http://localhost:3000/api/v1/projects/PROJECT_ID/keys \
  -H "X-API-Key: YOUR_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Production Key", "scopes": ["upload", "read", "delete"]}'
```

Save the API key from the response — you'll use it for all file operations.

### 5. Upload your first file

```bash
curl -X POST http://localhost:3000/api/v1/upload \
  -H "X-API-Key: mv_live_YOUR_API_KEY" \
  -F "file=@photo.jpg"
```

Response:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "filename": "photo-a8x3k2.webp",
  "url": "http://localhost:3000/f/proj-id/photo-a8x3k2.webp",
  "urls": {
    "original": "http://localhost:3000/f/proj-id/photo-a8x3k2.webp",
    "thumb": "http://localhost:3000/img/fit/200/200/f/proj-id/photo-a8x3k2.webp",
    "sm": "http://localhost:3000/img/fit/400/0/f/proj-id/photo-a8x3k2.webp",
    "md": "http://localhost:3000/img/fit/800/0/f/proj-id/photo-a8x3k2.webp",
    "lg": "http://localhost:3000/img/fit/1200/0/f/proj-id/photo-a8x3k2.webp"
  },
  "type": "image",
  "mime_type": "image/webp",
  "size": 45200,
  "original_size": 182400,
  "width": 1200,
  "height": 800,
  "status": "done",
  "processing_ms": 124
}
```

That's it. Your image is converted to WebP, stored, and ready to serve at multiple sizes.

## Features

### File Processing

- **Images** — Auto-converted to WebP with configurable quality. Respects max dimensions. Animated GIFs are converted to MP4.
- **Videos** — Transcoded to H.264 MP4 with configurable CRF and max resolution. Thumbnails extracted automatically. Async processing (returns `202`, fires webhook on completion).
- **Audio** — Stored as-is with duration extraction.
- **Documents** — Stored as-is with proper MIME types.

### On-the-fly Image Resizing

Every image gets instant resize URLs powered by imgproxy:

```
/f/{key}                              → Original
/img/fit/200/200/f/{key}              → Fit within 200x200
/img/fill/500/500/f/{key}             → Fill 500x500 (crop)
/img/auto/800/0/f/{key}               → Smart resize, 800px wide
/img/force/100/100/f/{key}            → Force exact 100x100
```

Resize modes: `fit` (preserve aspect ratio), `fill` (crop to fill), `auto` (smart), `force` (exact dimensions).

### Multi-tenant Architecture

- **Accounts** — Each account can have multiple projects
- **Projects** — Isolated storage, settings, API keys, and usage tracking
- **API Keys** — Scoped permissions (`upload`, `read`, `delete`, `admin`), rate-limited, revocable
- **Usage Tracking** — Per-project storage, bandwidth, uploads, downloads, transforms

### File Serving

- `Cache-Control: public, max-age=31536000, immutable` on all served files
- HTTP range requests (video seeking)
- `ETag` headers for conditional requests
- Cross-origin resource sharing (CORS)
- Proper `Content-Type` headers

### Security

- **API key hashing** — Keys are SHA-256 hashed in the database. Prefix stored for fast lookup, full key shown once at creation (with optional encrypted reveal later).
- **Signed URLs** — HMAC-SHA256 time-limited URLs for private files
- **Webhook signatures** — HMAC-SHA256 signatures on all webhook deliveries
- **Rate limiting** — Per-key rate limiting via Redis
- **Input sanitization** — File paths sanitized against traversal, parameterized SQL queries
- **Helmet** — Security headers on all API routes (relaxed for CDN serving routes)
- **bcrypt** — Password hashing for dashboard accounts
- **Constant-time comparison** — For all secret comparisons

### Webhooks

Subscribe to events and get HTTP POST notifications:

| Event | Description |
|-------|-------------|
| `file.uploaded` | File uploaded successfully |
| `file.processed` | Async processing completed (video) |
| `file.deleted` | File deleted |
| `file.failed` | Async processing failed |

Payloads are signed with HMAC-SHA256. Failed deliveries retry up to 3 times with backoff (10s, 60s).

### Dashboard

Built-in admin panel (Next.js 15) with:

- Project overview with stats (files, storage, bandwidth)
- File browser with image thumbnails and preview modal
- API key management (create, reveal, revoke)
- Webhook management and testing
- Usage analytics with charts
- Dark/light theme
- Responsive design (mobile sidebar)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Clients / SDK                        │
└───────────────────────────┬─────────────────────────────┘
                            │
                   ┌────────▼────────┐
                   │   Worker API    │  Express 4 (Node.js)
                   │   port 3000     │
                   └──┬───┬───┬───┬──┘
                      │   │   │   │
              ┌───────┘   │   │   └───────┐
              ▼           ▼   ▼           ▼
        ┌──────────┐ ┌──────┐ ┌─────┐ ┌──────────┐
        │PostgreSQL│ │MinIO │ │Redis│ │ imgproxy  │
        │  16      │ │(S3)  │ │  7  │ │          │
        └──────────┘ └──────┘ └─────┘ └──────────┘

        ┌────────────────┐
        │   Dashboard    │  Next.js 15
        │   port 3001    │
        └────────────────┘
```

### Project Structure

```
mediaos/
├── worker/                    # Express API server
│   ├── src/
│   │   ├── app.js            # Express app setup
│   │   ├── config.js         # Environment config (single source)
│   │   ├── db.js             # PostgreSQL connection
│   │   ├── minio.js          # MinIO/S3 client
│   │   ├── middleware/
│   │   │   ├── auth.js       # API key authentication
│   │   │   ├── adminAuth.js  # Master key authentication
│   │   │   ├── cors.js       # CORS configuration
│   │   │   ├── rateLimit.js  # Redis-based rate limiting
│   │   │   └── errorHandler.js
│   │   ├── routes/
│   │   │   ├── upload.js     # POST /api/v1/upload
│   │   │   ├── files.js      # GET/DELETE /api/v1/files
│   │   │   ├── serve.js      # GET /f/* and /img/*
│   │   │   ├── webhooks.js   # Webhook CRUD
│   │   │   ├── usage.js      # Usage stats
│   │   │   ├── accounts.js   # Admin: account management
│   │   │   ├── projects.js   # Admin: project management
│   │   │   └── apiKeys.js    # Admin: API key management
│   │   ├── services/
│   │   │   ├── fileService.js    # Upload, process, delete logic
│   │   │   ├── imageProcessor.js # Sharp: WebP conversion
│   │   │   ├── videoProcessor.js # FFmpeg: transcode, thumbnail
│   │   │   ├── keyService.js     # API key generation, validation
│   │   │   ├── usageService.js   # Usage tracking
│   │   │   ├── webhookService.js # Webhook dispatch + retry
│   │   │   ├── signedUrl.js      # HMAC signed URL generation
│   │   │   └── queue.js          # Bounded concurrency queue
│   │   └── utils/
│   │       ├── crypto.js     # SHA-256, HMAC, AES encrypt/decrypt
│   │       ├── slugify.js    # Filename sanitization
│   │       ├── mimeTypes.js  # MIME type detection
│   │       └── fileTypes.js  # File type classification
│   ├── migrations/            # Raw SQL migrations
│   └── tests/                 # Jest test suite
│
├── dashboard/                 # Next.js 15 admin panel
│   └── src/
│       ├── app/
│       │   ├── login/         # Login page
│       │   ├── dashboard/     # Dashboard pages
│       │   └── api/           # API proxy routes
│       ├── components/
│       │   ├── ui/            # shadcn/ui components
│       │   ├── layout/        # Sidebar, Header, Nav
│       │   ├── files/         # FileGrid, FilePreview
│       │   └── projects/      # CreateProjectModal
│       └── lib/
│           ├── api.ts         # Admin fetch helper
│           ├── auth.ts        # NextAuth config
│           ├── types.ts       # TypeScript definitions
│           └── utils.ts       # Formatters
│
├── sdk/                       # TypeScript SDK (@mediaos/sdk)
│   └── src/
│       ├── index.ts           # MediaOS class
│       └── types.ts           # All type definitions
│
├── docker-compose.yml         # Full stack deployment
└── .env.example               # Configuration template
```

## API Reference

### Authentication

All file operations use API keys via the `X-API-Key` header:

```
X-API-Key: mv_live_xxxxxxxxxxxxxxxxxxxx
```

Admin operations (account/project/key management) use the master key via `Authorization: Bearer`:

```
Authorization: Bearer mv_master_xxxxxxxxxxxxxxxxxxxx
```

### Endpoints

#### Upload

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/upload` | API Key (`upload`) | Upload single file |
| `POST` | `/api/v1/upload/bulk` | API Key (`upload`) | Upload up to 20 files |

**Single upload:**

```bash
curl -X POST http://localhost:3000/api/v1/upload \
  -H "X-API-Key: mv_live_..." \
  -F "file=@image.jpg" \
  -F "folder=avatars" \
  -F "access=public"
```

**Bulk upload:**

```bash
curl -X POST http://localhost:3000/api/v1/upload/bulk \
  -H "X-API-Key: mv_live_..." \
  -F "files=@img1.jpg" \
  -F "files=@img2.png" \
  -F "files=@img3.gif" \
  -F "folder=gallery"
```

**Query/form parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `folder` | string | — | Organize files into folders |
| `name` | string | original filename | Custom display name |
| `access` | string | `public` | `public` or `private` |

#### Files

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/files` | API Key (`read`) | List files with filtering |
| `GET` | `/api/v1/files/:id` | API Key (`read`) | Get file metadata |
| `DELETE` | `/api/v1/files/:id` | API Key (`delete`) | Soft-delete file |
| `GET` | `/api/v1/files/:id/signed-url` | API Key (`read`) | Generate signed URL |

**List files with filters:**

```bash
curl "http://localhost:3000/api/v1/files?type=image&folder=avatars&search=hero&sort=created_at&order=desc&page=1&limit=50" \
  -H "X-API-Key: mv_live_..."
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | `1` | Page number |
| `limit` | number | `50` | Items per page (max 100) |
| `folder` | string | — | Filter by folder |
| `type` | string | — | `image`, `video`, or `file` |
| `search` | string | — | Search by filename |
| `sort` | string | `created_at` | `created_at`, `size`, or `filename` |
| `order` | string | `desc` | `asc` or `desc` |
| `status` | string | — | `done`, `processing`, or `failed` |

**Generate signed URL for private files:**

```bash
curl "http://localhost:3000/api/v1/files/FILE_ID/signed-url?expires=3600" \
  -H "X-API-Key: mv_live_..."
```

#### Serving

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/f/:projectId/*` | None (public) | Serve original file |
| `GET` | `/img/:mode/:w/:h/f/:projectId/*` | None (public) | Serve resized image |

Private files require `?token=...&expires=...` query parameters from a signed URL.

#### Usage

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/usage` | API Key (`read`) | Current period usage |
| `GET` | `/api/v1/usage/history` | API Key (`read`) | Daily usage history |

```bash
# Current usage
curl http://localhost:3000/api/v1/usage -H "X-API-Key: mv_live_..."

# Last 7 days history
curl "http://localhost:3000/api/v1/usage/history?days=7" -H "X-API-Key: mv_live_..."
```

#### Webhooks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/webhooks` | API Key (`read`) | List webhooks |
| `POST` | `/api/v1/webhooks` | API Key (`admin`) | Create webhook |
| `DELETE` | `/api/v1/webhooks/:id` | API Key (`admin`) | Delete webhook |

```bash
curl -X POST http://localhost:3000/api/v1/webhooks \
  -H "X-API-Key: mv_live_..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://api.yoursite.com/hooks/mediaos", "events": ["file.uploaded", "file.deleted"]}'
```

#### Admin (Master Key)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/accounts` | Create account |
| `GET` | `/api/v1/accounts` | List accounts |
| `POST` | `/api/v1/projects` | Create project |
| `GET` | `/api/v1/projects` | List projects |
| `PATCH` | `/api/v1/projects/:id` | Update project |
| `DELETE` | `/api/v1/projects/:id` | Delete project |
| `POST` | `/api/v1/projects/:id/keys` | Create API key |
| `GET` | `/api/v1/projects/:id/keys` | List API keys |
| `DELETE` | `/api/v1/projects/:id/keys/:keyId` | Revoke API key |
| `POST` | `/api/v1/projects/:id/keys/:keyId/reveal` | Reveal full API key |

## SDK

Install the TypeScript SDK:

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
console.log(file.url);
console.log(file.urls.thumb);

// List
const files = await media.files.list({ type: 'image', limit: 20 });

// Delete
await media.files.delete(file.id);

// Signed URL for private files
const { url } = await media.files.signedUrl(file.id, 3600);

// Custom resize URL (no API call)
const thumb = media.url(file.storage_key, { width: 300, height: 300, fit: 'fill' });

// Usage
const usage = await media.usage.current();

// Webhooks
const webhook = await media.webhooks.create('https://api.yoursite.com/hooks', ['file.uploaded']);
```

Full SDK documentation: [`sdk/README.md`](./sdk/README.md)

## Dashboard

The built-in admin dashboard runs at `http://localhost:3001` and provides:

- **Overview** — Project stats, recent uploads with image previews, quick actions
- **Projects** — Create and manage projects, view per-project details
- **Files** — Browse files in a grid, search/filter, preview images, copy URLs
- **API Keys** — Create keys with scoped permissions, reveal/copy keys, revoke
- **Webhooks** — Create webhooks, select events, test deliveries, view stats
- **Usage** — Storage/bandwidth gauges, upload/download charts, file type breakdown
- **Settings** — Project configuration (max dimensions, quality, allowed types)

### Login

The dashboard uses NextAuth with credential-based authentication. On first launch, a setup wizard creates your admin account. After that, log in with your email and password.

## Configuration

All configuration is done via environment variables in `.env`:

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `MASTER_KEY` | — | **Required.** Admin key for account/project management |
| `PUBLIC_URL` | `http://localhost:3000` | Public-facing URL of the API |
| `API_PORT` | `3000` | Worker API port |
| `NODE_ENV` | `production` | `development` or `production` |

### PostgreSQL

| Variable | Default | Description |
|----------|---------|-------------|
| `PG_DATABASE` | `mediaos` | Database name |
| `PG_USER` | `mediaos` | Database user |
| `PG_PASSWORD` | — | Database password |
| `PG_PORT` | `5432` | Database port |

### MinIO (S3 Storage)

| Variable | Default | Description |
|----------|---------|-------------|
| `MINIO_ROOT_USER` | `mvadmin` | MinIO access key |
| `MINIO_ROOT_PASSWORD` | — | MinIO secret key |
| `MINIO_BUCKET` | `mediaos` | Storage bucket name |
| `MINIO_CONSOLE_PORT` | `9001` | MinIO web console port |

### Image Processing

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBP_QUALITY` | `80` | WebP output quality (1-100) |
| `MAX_WIDTH` | `1600` | Max image width in pixels |
| `MAX_HEIGHT` | `1600` | Max image height in pixels |

### Video Processing

| Variable | Default | Description |
|----------|---------|-------------|
| `VIDEO_CRF` | `20` | H.264 CRF quality (lower = better, 18-28 recommended) |
| `VIDEO_MAX_HEIGHT` | `1080` | Max video height in pixels |
| `CONCURRENCY` | `3` | Max concurrent video processing jobs |

### Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_FILE_SIZE` | `104857600` | Max upload size in bytes (default: 100MB) |

### Redis

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_PASSWORD` | — | Redis password |
| `REDIS_PORT` | `6379` | Redis port |

### Dashboard

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3001` | Dashboard port |
| `DASHBOARD_URL` | `http://localhost:3001` | Dashboard public URL |
| `NEXTAUTH_SECRET` | — | NextAuth encryption secret |

## Development

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- FFmpeg (for local video processing without Docker)

### Local development

Start infrastructure services:

```bash
docker compose up postgres minio redis imgproxy -d
```

Run the worker:

```bash
cd worker
npm install
npm run dev
```

Run the dashboard:

```bash
cd dashboard
npm install
npm run dev -- -p 3001
```

### Running tests

```bash
cd worker
npm test
```

### Database migrations

Migrations run automatically on worker startup. To run manually:

```bash
cd worker
node migrations/migrate.js
```

Migration files are in `worker/migrations/` as numbered SQL files.

## Deployment

### Docker Compose (recommended)

The included `docker-compose.yml` runs the full stack in production:

```bash
# Configure
cp .env.example .env
# Edit .env with secure passwords and your master key

# Deploy
docker compose up -d

# Check health
curl http://localhost:3000/health
```

### Behind a Reverse Proxy (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name cdn.yoursite.com;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl http2;
    server_name admin.yoursite.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Environment Checklist

Before going to production, make sure to:

- [ ] Set strong `MASTER_KEY`
- [ ] Set strong `PG_PASSWORD`
- [ ] Set strong `MINIO_ROOT_PASSWORD`
- [ ] Set strong `REDIS_PASSWORD`
- [ ] Set strong `NEXTAUTH_SECRET`
- [ ] Set `PUBLIC_URL` to your actual domain
- [ ] Set `DASHBOARD_URL` to your dashboard domain
- [ ] Set `NODE_ENV=production`

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| API | Node.js 20, Express 4 | HTTP server, routing, middleware |
| Dashboard | Next.js 15, TypeScript, Tailwind, shadcn/ui | Admin panel |
| SDK | TypeScript | Client library for npm |
| Database | PostgreSQL 16 | Metadata, accounts, projects, keys, usage |
| Storage | MinIO | S3-compatible object storage |
| Image Resize | imgproxy | On-the-fly image transformation |
| Cache | Redis 7 | Rate limiting, session cache |
| Image Processing | Sharp | WebP conversion, resizing |
| Video Processing | FFmpeg | H.264 transcoding, thumbnail extraction |

## API Key Format

```
mv_live_c18df9a0b3e74c6a2f8d1b5e9a7c0d3f
└──────┘└──────────────────────────────────┘
 prefix           32 hex characters

Prefix (first 12 chars): mv_live_c18d  → stored in plaintext for fast lookup
Full key:                               → SHA-256 hashed for validation
```

Keys are scoped with permissions: `upload`, `read`, `delete`, `admin`.

## Roadmap

MediaOS is evolving from a media CDN into a **complete open-source media infrastructure platform** — self-hosted Netflix/YouTube backend that anyone can run.

| Phase | Status | What's Coming |
|-------|--------|---------------|
| **v1 — Media CDN** | **Done** | Upload, process, serve images/videos/files with resizing |
| **v2 — Streaming** | **Next** | HLS/DASH adaptive streaming, video player SDK, playlists |
| **v3 — Security** | Planned | DRM (Widevine/FairPlay), geo-restrictions, watermarking |
| **v4 — Scale** | Planned | Multi-node, edge caching, S3/R2/B2 backends |
| **v5 — Intelligence** | Planned | AI tagging, content moderation, smart thumbnails, search |

See the full **[Roadmap](ROADMAP.md)** for detailed feature breakdown.

## Contributing

We're looking for contributors to help build the next phases. Whether it's HLS streaming, a video player component, or better S3 backend support — there's a lot to build.

```bash
# Set up dev environment
cp .env.example .env
docker compose up postgres minio redis imgproxy -d
cd worker && npm install && npm run dev
cd dashboard && npm install && npm run dev -- -p 3001
```

Check out **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full guide, code style, and areas we need help with.

**Good first contributions:**
- Bug fixes and documentation
- S3-compatible backend support (AWS S3, R2, B2)
- HLS video streaming pipeline
- Embeddable video player component
- Dashboard improvements

## License

MIT License — see [LICENSE](LICENSE) for details.

Free to use for personal and commercial projects.

## Also by ARN

<table>
  <tr>
    <td width="80" align="center">
      <img src="https://sendmailos.com/favicon.ico" width="48" alt="SendMailOS" />
    </td>
    <td>
      <strong><a href="https://sendmailos.com">SendMailOS</a></strong> — Email marketing platform.<br />
      Send campaigns, automate workflows, manage subscribers. 2,000+ free emails every month.<br />
      <a href="https://sendmailos.com">sendmailos.com</a>
    </td>
  </tr>
</table>

---

Built by [ARN](https://www.instagram.com/arrrrniii/)
