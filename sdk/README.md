# @mediaos/sdk

Official TypeScript SDK for **MediaOS** — a self-hosted, multi-tenant media CDN platform.

Upload images, videos, and files. Get back optimized assets with instant resize URLs. No third-party dependencies.

## Install

```bash
npm install @mediaos/sdk
```

## Quick Start

```typescript
import { MediaOS } from '@mediaos/sdk';

const mv = new MediaOS({
  url: 'https://cdn.yoursite.com',
  apiKey: 'mv_live_xxxxxxxxxxxxxxxxxxxx',
});

// Upload an image — returns the URL immediately
const result = await mv.upload(fileBuffer, { name: 'hero.jpg' });

console.log(result.url);       // https://cdn.yoursite.com/f/proj/hero-a8x3k2.webp
console.log(result.urls.thumb); // https://cdn.yoursite.com/img/fit/200/200/f/proj/hero-a8x3k2.webp
console.log(result.urls.md);    // https://cdn.yoursite.com/img/fit/800/0/f/proj/hero-a8x3k2.webp
```

## Features

- **Upload** — Single and bulk file uploads (images, videos, documents)
- **Auto-optimization** — Images are converted to WebP, videos transcoded to H.264 MP4
- **Instant resize URLs** — Get `thumb`, `sm`, `md`, `lg` variants automatically
- **Custom transforms** — Build any resize URL with `fit`, `fill`, `auto`, or `force` modes
- **Signed URLs** — Generate time-limited URLs for private files
- **File management** — List, search, filter, and delete files
- **Usage tracking** — Monitor storage, bandwidth, uploads, and downloads
- **Webhooks** — Get notified on `file.uploaded`, `file.processed`, `file.deleted`, `file.failed`
- **Fully typed** — Complete TypeScript definitions for all methods and responses
- **Zero dependencies** — Uses native `fetch` and `crypto` only

## Configuration

```typescript
const mv = new MediaOS({
  url: 'https://cdn.yoursite.com', // Your MediaOS server URL
  apiKey: 'mv_live_...',           // API key from the dashboard
  timeout: 30000,                  // Request timeout in ms (default: 30000)
});
```

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `url` | `string` | Yes | — | MediaOS server URL |
| `apiKey` | `string` | Yes | — | Project API key |
| `timeout` | `number` | No | `30000` | Request timeout in milliseconds |

## Upload

### Single file

```typescript
import fs from 'fs';

const buffer = fs.readFileSync('./photo.jpg');

const result = await mv.upload(buffer, {
  name: 'photo.jpg',      // Display name (optional)
  folder: 'avatars',      // Organize into folders (optional)
  access: 'public',       // 'public' or 'private' (optional)
});
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "filename": "photo-a8x3k2.webp",
  "url": "https://cdn.yoursite.com/f/proj-id/avatars/photo-a8x3k2.webp",
  "storage_key": "proj-id/avatars/photo-a8x3k2.webp",
  "urls": {
    "original": "https://cdn.yoursite.com/f/proj-id/avatars/photo-a8x3k2.webp",
    "thumb": "https://cdn.yoursite.com/img/fit/200/200/f/proj-id/avatars/photo-a8x3k2.webp",
    "sm": "https://cdn.yoursite.com/img/fit/400/0/f/proj-id/avatars/photo-a8x3k2.webp",
    "md": "https://cdn.yoursite.com/img/fit/800/0/f/proj-id/avatars/photo-a8x3k2.webp",
    "lg": "https://cdn.yoursite.com/img/fit/1200/0/f/proj-id/avatars/photo-a8x3k2.webp"
  },
  "type": "image",
  "mime_type": "image/webp",
  "size": 45200,
  "original_size": 182400,
  "width": 1200,
  "height": 800,
  "access": "public",
  "status": "done",
  "processing_ms": 124,
  "created_at": "2026-03-05T10:30:00.000Z"
}
```

### Bulk upload (up to 20 files)

```typescript
const files = [
  { data: fs.readFileSync('./img1.jpg'), name: 'img1.jpg' },
  { data: fs.readFileSync('./img2.png'), name: 'img2.png' },
  { data: fs.readFileSync('./doc.pdf'),  name: 'doc.pdf' },
];

const result = await mv.uploadBulk(files, {
  folder: 'gallery',
  access: 'public',
});

console.log(result.uploaded); // 3
console.log(result.failed);   // 0
console.log(result.files);    // Array of UploadResult
console.log(result.errors);   // Array of { filename, error }
```

### Browser upload (Blob/File)

```typescript
// Works with File objects from <input type="file">
const input = document.querySelector('input[type="file"]');
const file = input.files[0];

const result = await mv.upload(file, { name: file.name });
```

## File Management

### List files

```typescript
const files = await mv.files.list({
  page: 1,
  limit: 50,
  folder: 'avatars',          // Filter by folder
  type: 'image',              // 'image' | 'video' | 'file'
  search: 'hero',             // Search by filename
  sort: 'created_at',         // 'created_at' | 'size' | 'filename'
  order: 'desc',              // 'asc' | 'desc'
});

console.log(files.total);     // Total matching files
console.log(files.data);      // Array of file objects
```

### Get file details

```typescript
const file = await mv.files.get('550e8400-e29b-41d4-a716-446655440000');

console.log(file.url);
console.log(file.width, file.height);
console.log(file.original_name);
```

### Delete file

```typescript
const result = await mv.files.delete('550e8400-e29b-41d4-a716-446655440000');

console.log(result.deleted);     // true
console.log(result.freed_bytes); // 45200
```

## Image Resizing

Images are resized on-the-fly via URL. No API call needed — just build the URL.

### Pre-generated URLs

Every image upload returns ready-to-use resize URLs:

```typescript
const result = await mv.upload(imageBuffer, { name: 'photo.jpg' });

result.urls.original; // Full size
result.urls.thumb;    // 200x200 fit
result.urls.sm;       // 400px wide
result.urls.md;       // 800px wide
result.urls.lg;       // 1200px wide
```

### Custom resize URLs

```typescript
// Fit within 300x300, preserving aspect ratio
mv.url(storageKey, { width: 300, height: 300, fit: 'fit' });

// Fill 500x500 (crop to fill)
mv.url(storageKey, { width: 500, height: 500, fit: 'fill' });

// Resize width only, auto height
mv.url(storageKey, { width: 600 });

// Square thumbnail shorthand
mv.thumbnailUrl(storageKey, 150);
```

### Resize modes

| Mode | Description |
|------|-------------|
| `fit` | Resize to fit within dimensions, preserving aspect ratio (default) |
| `fill` | Resize and crop to fill exact dimensions |
| `auto` | Smart resize based on image content |
| `force` | Force exact dimensions (may distort) |

## Signed URLs

Generate time-limited URLs for private files:

```typescript
// Default expiry (from server config)
const { url, expires_at } = await mv.files.signedUrl('file-id');

// Custom expiry: 1 hour (3600 seconds)
const { url, expires_at } = await mv.files.signedUrl('file-id', 3600);

// Use the signed URL — works until expires_at
// https://cdn.yoursite.com/f/proj/file.webp?token=abc123&expires=1709654400
```

## Usage & Analytics

### Current usage

```typescript
const usage = await mv.usage.current();

console.log(usage.storage);    // { used: 52428800, limit: 1073741824, percent: 4.9 }
console.log(usage.bandwidth);  // { used: 104857600, limit: 10737418240, percent: 1.0 }
console.log(usage.uploads);    // 150
console.log(usage.downloads);  // 3200
console.log(usage.transforms); // 890
console.log(usage.files);      // { total: 150, images: 120, videos: 20, other: 10 }
```

### Usage history (daily breakdown)

```typescript
// Last 30 days (default)
const history = await mv.usage.history();

// Last 7 days
const history = await mv.usage.history(7);

for (const day of history.data) {
  console.log(day.date);           // "2026-03-05"
  console.log(day.uploads);        // 12
  console.log(day.download_bytes); // 5242880
  console.log(day.transforms);     // 45
}
```

## Webhooks

Get notified when events occur in your project.

### Events

| Event | Description |
|-------|-------------|
| `file.uploaded` | A file was uploaded successfully |
| `file.processed` | Async processing (video transcode) completed |
| `file.deleted` | A file was deleted |
| `file.failed` | Async processing failed |

### Create a webhook

```typescript
const webhook = await mv.webhooks.create(
  'https://api.yoursite.com/webhooks/mediaos',
  ['file.uploaded', 'file.deleted']
);

console.log(webhook.id);     // Webhook ID
console.log(webhook.secret); // "whsec_..." — save this for verification
```

### List webhooks

```typescript
const { data: webhooks } = await mv.webhooks.list();

for (const wh of webhooks) {
  console.log(wh.url, wh.events, wh.success_count, wh.failure_count);
}
```

### Delete a webhook

```typescript
await mv.webhooks.delete('webhook-id');
```

### Verify webhook signatures

When your server receives a webhook, verify it's from MediaOS:

```typescript
import express from 'express';
import { MediaOS } from '@mediaos/sdk';

const app = express();
const mv = new MediaOS({ url: '...', apiKey: '...' });

app.post('/webhooks/mediaos', express.text({ type: '*/*' }), (req, res) => {
  const signature = req.headers['x-mv-signature'] as string;
  const webhookSecret = 'whsec_...'; // From webhook creation

  const valid = mv.webhooks.verify(req.body, signature, webhookSecret);

  if (!valid) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(req.body);
  console.log(event.event); // "file.uploaded"
  console.log(event.data);  // File data

  res.sendStatus(200);
});
```

**Webhook payload format:**

```json
{
  "event": "file.uploaded",
  "timestamp": "2026-03-05T10:30:00.000Z",
  "project_id": "proj-uuid",
  "data": {
    "id": "file-uuid",
    "filename": "photo-a8x3k2.webp",
    "url": "https://cdn.yoursite.com/f/proj/photo-a8x3k2.webp",
    "type": "image",
    "size": 45200,
    "width": 1200,
    "height": 800
  }
}
```

**Webhook headers:**

| Header | Description |
|--------|-------------|
| `X-MV-Signature` | HMAC-SHA256 hex signature of the body |
| `X-MV-Event` | Event name (e.g., `file.uploaded`) |
| `X-MV-Delivery-Id` | Unique delivery ID |
| `X-MV-Timestamp` | Unix timestamp of the delivery |

## Error Handling

All API errors throw `MediaOSApiError` with `code`, `status`, and `message`:

```typescript
import { MediaOS, MediaOSApiError } from '@mediaos/sdk';

try {
  await mv.files.get('nonexistent-id');
} catch (err) {
  if (err instanceof MediaOSApiError) {
    console.log(err.message); // "File not found"
    console.log(err.code);    // "NOT_FOUND"
    console.log(err.status);  // 404
  }
}
```

### Error codes

| Code | Status | Description |
|------|--------|-------------|
| `AUTH_REQUIRED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | Key doesn't have required scope |
| `NOT_FOUND` | 404 | Resource not found |
| `INVALID_SCOPES` | 400 | Invalid scope in request |
| `NO_FILE` | 400 | No file in upload request |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `ACCESS_DENIED` | 403 | File is private, signed URL required |
| `URL_EXPIRED` | 403 | Signed URL has expired |
| `TIMEOUT` | 408 | Request timed out (client-side) |

## TypeScript Types

All types are exported and available for use:

```typescript
import type {
  MediaOSConfig,
  UploadOptions,
  UploadResult,
  BulkUploadResult,
  FileListOptions,
  FileListResult,
  FileMetadata,
  FileUrls,
  DeleteResult,
  SignedUrlResult,
  UrlOptions,
  UsageResult,
  UsageHistoryResult,
  WebhookResult,
  WebhookListResult,
} from '@mediaos/sdk';
```

## Examples

### Next.js / React — Upload with preview

```typescript
'use client';
import { useState } from 'react';
import { MediaOS } from '@mediaos/sdk';

const mv = new MediaOS({
  url: process.env.NEXT_PUBLIC_CDN_URL!,
  apiKey: process.env.NEXT_PUBLIC_CDN_KEY!,
});

export default function ImageUploader() {
  const [url, setUrl] = useState('');

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const result = await mv.upload(file, {
      name: file.name,
      folder: 'uploads',
    });

    setUrl(result.urls.md || result.url);
  }

  return (
    <div>
      <input type="file" accept="image/*" onChange={handleUpload} />
      {url && <img src={url} alt="Uploaded" />}
    </div>
  );
}
```

### Express — Avatar upload endpoint

```typescript
import express from 'express';
import multer from 'multer';
import { MediaOS } from '@mediaos/sdk';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const mv = new MediaOS({
  url: 'https://cdn.yoursite.com',
  apiKey: process.env.CDN_API_KEY!,
});

app.post('/api/avatar', upload.single('avatar'), async (req, res) => {
  const result = await mv.upload(req.file.buffer, {
    name: `avatar-${req.user.id}.jpg`,
    folder: 'avatars',
  });

  // Save the URL to your database
  await db.users.update(req.user.id, {
    avatar_url: result.urls.md,
    avatar_thumb: result.urls.thumb,
  });

  res.json({ avatar: result.urls.md });
});
```

### Node.js — Batch import from directory

```typescript
import fs from 'fs';
import path from 'path';
import { MediaOS } from '@mediaos/sdk';

const mv = new MediaOS({
  url: 'https://cdn.yoursite.com',
  apiKey: 'mv_live_...',
});

const dir = './images';
const files = fs.readdirSync(dir)
  .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
  .map(f => ({
    data: fs.readFileSync(path.join(dir, f)),
    name: f,
  }));

// Upload in batches of 20
for (let i = 0; i < files.length; i += 20) {
  const batch = files.slice(i, i + 20);
  const result = await mv.uploadBulk(batch, { folder: 'import' });
  console.log(`Batch ${i / 20 + 1}: ${result.uploaded} uploaded, ${result.failed} failed`);
}
```

## Self-Hosting MediaOS

This SDK connects to a MediaOS server. To run your own:

```bash
git clone https://github.com/arrrrniii/MediaOs.git
cd mediaos
cp .env.example .env    # Configure your settings
docker compose up -d    # Start all services
```

Then create a project and API key via the dashboard at `http://localhost:3001`.

## Requirements

- Node.js 18+ (uses native `fetch`)
- MediaOS server v1.0+

## License

MIT
