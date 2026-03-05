# MediaOS Roadmap

MediaOS is evolving from a media CDN into a complete open-source media infrastructure platform. Here's where we're going.

## v1 — Media CDN (Current)

- [x] Image upload + WebP conversion
- [x] Video upload + H.264 transcoding
- [x] Audio/document storage
- [x] On-the-fly image resizing (imgproxy)
- [x] Multi-tenant projects with API keys
- [x] Signed URLs for private files
- [x] Webhooks with HMAC signatures
- [x] Usage tracking and analytics
- [x] Admin dashboard (Next.js)
- [x] TypeScript SDK
- [x] Docker Compose deployment
- [x] Setup wizard for first-time install

## v2 — Streaming

The next major milestone. Turn MediaOS into a self-hosted video streaming platform.

- [ ] **HLS adaptive streaming** — Transcode videos to multiple quality levels (240p, 480p, 720p, 1080p, 4K)
- [ ] **DASH support** — Alternative adaptive format for broader compatibility
- [ ] **Live transcoding** — On-the-fly quality switching without pre-processing all variants
- [ ] **Video player SDK** — Embeddable JavaScript player with:
  - Adaptive bitrate switching
  - Quality selector
  - Playback speed control
  - Subtitle/caption support
  - Thumbnail preview on seek (sprite sheets)
  - Chromecast/AirPlay support
- [ ] **Playlist/series support** — Group videos into ordered playlists
- [ ] **Resume playback** — Track watch progress per viewer
- [ ] **Thumbnail sprites** — Generate sprite sheets for video scrubbing preview
- [ ] **Audio streaming** — HLS audio for podcast/music use cases

## v3 — Security & Access Control

- [ ] **DRM integration** — Widevine/FairPlay for content protection
- [ ] **Token-based playback** — Short-lived playback tokens for video access
- [ ] **Geo-restrictions** — Allow/block playback by country
- [ ] **Domain whitelisting** — Restrict embedding to specific domains
- [ ] **Watermarking** — Dynamic visible/invisible watermarks on video playback
- [ ] **Rate limiting per viewer** — Prevent scraping and abuse
- [ ] **IP-based access control** — Whitelist/blacklist IP ranges

## v4 — Scale & Distribution

- [ ] **Multi-node deployment** — Distribute storage across multiple servers
- [ ] **Edge caching** — Cache popular files at edge locations
- [ ] **S3-compatible backends** — Support AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces
- [ ] **CDN integration** — Native Cloudflare, Bunny CDN, and Fastly integration
- [ ] **Horizontal scaling** — Run multiple worker instances behind a load balancer
- [ ] **Background job queue** — Redis/BullMQ for reliable async processing
- [ ] **Storage tiering** — Hot/warm/cold storage with automatic migration

## v5 — Intelligence

- [ ] **Auto-thumbnails** — AI-powered best frame selection for video thumbnails
- [ ] **Content moderation** — NSFW detection, violence detection
- [ ] **AI tagging** — Automatic tags/labels from image/video content
- [ ] **Face detection** — Smart crop centered on faces
- [ ] **OCR** — Extract text from images
- [ ] **Search** — Full-text search across all file metadata and AI-generated tags
- [ ] **Color extraction** — Dominant color palette from images
- [ ] **Duplicate detection** — Perceptual hash to find duplicate/similar files

## v6 — Platform

- [ ] **Multi-user dashboard** — Team members with roles (admin, editor, viewer)
- [ ] **Embed codes** — One-click embed for images, videos, audio players
- [ ] **WordPress plugin** — Native media library integration
- [ ] **Shopify app** — Product image/video management
- [ ] **React/Vue components** — Drop-in UI components for upload and display
- [ ] **REST + GraphQL API** — GraphQL alternative for flexible queries
- [ ] **Webhooks v2** — Filtering, retry policies, delivery logs
- [ ] **Audit log** — Track all actions for compliance

---

Want to help build any of these? See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.
