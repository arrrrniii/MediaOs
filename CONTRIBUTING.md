# Contributing to MediaOS

Thanks for your interest in contributing to MediaOS! We're building an open-source media platform that anyone can self-host — and we want to take it further into streaming, adaptive delivery, and beyond.

## Vision

MediaOS started as a media CDN. The long-term vision is to become a **complete open-source media infrastructure platform** — think self-hosted Netflix/YouTube backend that anyone can run on their own servers.

### Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| **v1 — Media CDN** | Done | Upload, process, store, and serve images/videos/files |
| **v2 — Streaming** | Next | HLS/DASH adaptive streaming, live transcoding, video player SDK |
| **v3 — Security** | Planned | DRM integration, token-based playback, geo-restrictions |
| **v4 — Scale** | Planned | Multi-node distribution, edge caching, P2P delivery |
| **v5 — Intelligence** | Planned | Auto-thumbnails, content moderation, AI tagging, search |

See the [Roadmap](ROADMAP.md) for detailed feature breakdown.

## How to Contribute

### Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Set up** the dev environment:

```bash
cp .env.example .env
docker compose up postgres minio redis imgproxy -d
cd worker && npm install && npm run dev
# In another terminal:
cd dashboard && npm install && npm run dev -- -p 3001
```

### What to Work On

- Check [Issues](https://github.com/arrrrniii/MediaOs/issues) for open tasks
- Look for `good first issue` labels if you're new
- Look for `help wanted` labels for bigger features
- Check the [Roadmap](ROADMAP.md) for the next milestone

### Branch Strategy

We use a multi-branch workflow:

```
development  ← PRs go here (active work)
    ↓
staging      ← testing & QA before release
    ↓
production   ← stable releases, Docker Hub builds
```

- **`development`** — All PRs and feature branches target this branch
- **`staging`** — Merged from development for testing before release
- **`production`** — Stable, production-ready code. Docker Hub images are built from here
- **`main`** — Mirror of production (do not PR directly to main)

### Pull Request Process

1. Fork the repository
2. Create a feature branch from `development`
3. Make your changes
4. Test locally with Docker Compose
5. Submit a PR targeting the **`development`** branch
6. Include a clear description of what and why

### Code Style

**Worker (JavaScript)**
- CommonJS (`require`/`module.exports`)
- 2-space indent, semicolons, single quotes
- async/await, no callbacks
- Parameterized SQL queries (`$1, $2`) — never string interpolation

**Dashboard (TypeScript)**
- Next.js 15 App Router
- Tailwind CSS + shadcn/ui
- Server components by default
- Dark-mode first

### Architecture Decisions

Before making major architectural changes, open an issue to discuss. This includes:
- New database tables or schema changes
- New external service dependencies
- Changes to the API contract
- New processing pipelines

## Areas We Need Help With

### High Priority
- **HLS streaming** — Transcode videos to HLS segments for adaptive bitrate streaming
- **Video player component** — Embeddable player with quality switching
- **S3-compatible backends** — Support AWS S3, Cloudflare R2, Backblaze B2 (not just MinIO)

### Medium Priority
- **Thumbnail generation** — Sprite sheets for video scrubbing, smart crop for images
- **Batch operations** — Bulk delete, bulk move, bulk access change
- **Search** — Full-text search across file metadata
- **Folder management** — Create, rename, move folders in the dashboard

### Always Welcome
- Bug fixes
- Documentation improvements
- Test coverage
- Performance optimizations
- Accessibility improvements
- Translations/i18n

## Community

- **Issues** — Bug reports and feature requests
- **Pull Requests** — Code contributions
- **Discussions** — Architecture decisions and ideas

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
