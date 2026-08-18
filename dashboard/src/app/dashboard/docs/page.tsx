'use client';

import { useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  ArrowRight, BookOpen, Check, Copy, KeyRound, Link2, ShieldCheck, UploadCloud,
} from 'lucide-react';

const subscribeToOrigin = () => () => {};

function configuredApiUrl() {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  return configured && !configured.includes('localhost')
    ? configured.replace(/\/$/, '')
    : null;
}

function browserApiUrl() {
  const configured = configuredApiUrl();
  if (configured) return configured;

  const origin = window.location.origin;
  if (window.location.hostname.startsWith('cdn-dash.')) {
    return origin.replace('//cdn-dash.', '//cdn.');
  }
  if (window.location.hostname === 'localhost') {
    return origin.replace(/:\d+$/, ':3000');
  }
  return origin;
}

function serverApiUrl() {
  return configuredApiUrl() || 'https://cdn.yourdomain.com';
}

function CopyBlock({ code, lang = 'shell' }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group overflow-hidden rounded-lg border border-border/60 bg-background/70">
      <div className="flex h-9 items-center justify-between border-b border-border/50 px-3">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">{lang}</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          aria-label="Copy code"
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function getSections(API_URL: string) {
  return [
  {
    id: 'authentication',
    title: 'Authentication',
    content: (
      <div className="space-y-3">
        <p>All API requests require an API key sent via the <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">X-API-Key</code> header.</p>
        <p>Create API keys in the dashboard under <strong>Projects &rarr; API Keys</strong>. Keys have scopes: <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">upload</code>, <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">read</code>, <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">delete</code>, or <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">*</code> for full access.</p>
        <CopyBlock code={`curl -H "X-API-Key: mv_live_your_key_here" \\
  ${API_URL}/api/v1/files`} />
      </div>
    ),
  },
  {
    id: 'upload',
    title: 'Upload Files',
    content: (
      <div className="space-y-4">
        <div>
          <h4 className="mb-1 text-sm font-semibold">Standard upload · storage only</h4>
          <p className="mb-2 text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">POST /api/v1/upload</code> — Multipart form-data with a <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">file</code> field.
          </p>
          <CopyBlock code={`curl -X POST ${API_URL}/api/v1/upload \\
  -H "X-API-Key: mv_live_your_key_here" \\
  -F "file=@photo.jpg" \\
  -F "folder=avatars" \\
  -F "access=public"`} />
          <p className="mt-2 text-sm text-muted-foreground">
            Images get an optimized WebP delivery copy. Video and audio are stored without HLS transcoding, so standard uploads are available quickly and do not create streaming derivatives. Audio-only MP4 containers are normalized to <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">audio/mp4</code> and <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">.m4a</code>.
          </p>
        </div>
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">Adaptive video streaming · opt in</h4>
            <Badge variant="outline" className="border-primary/30 text-primary">HLS</Badge>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            Use <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">POST /api/v1/upload/stream</code> only when a video needs adaptive HLS playback. This endpoint queues MP4/HLS processing and can return <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">202</code> while renditions are prepared.
          </p>
          <CopyBlock code={`curl -X POST ${API_URL}/api/v1/upload/stream \\
  -H "X-API-Key: mv_live_your_key_here" \\
  -F "file=@video.mp4" \\
  -F "folder=streaming" \\
  -F "access=public"`} />
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Bulk Upload (up to 20 files)</h4>
          <CopyBlock code={`curl -X POST ${API_URL}/api/v1/upload/bulk \\
  -H "X-API-Key: mv_live_your_key_here" \\
  -F "files=@photo1.jpg" \\
  -F "files=@photo2.png" \\
  -F "folder=gallery"`} />
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Upload Options</h4>
          <div className="overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border/50 bg-muted/30"><th className="px-4 py-2 text-left font-medium">Param</th><th className="px-4 py-2 text-left font-medium">Description</th><th className="px-4 py-2 text-left font-medium">Default</th></tr></thead>
              <tbody>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">folder</td><td className="px-4 py-2 text-muted-foreground">Organize files into folders</td><td className="px-4 py-2 text-muted-foreground">(root)</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">name</td><td className="px-4 py-2 text-muted-foreground">Custom filename slug</td><td className="px-4 py-2 text-muted-foreground">auto-generated</td></tr>
                <tr><td className="px-4 py-2 font-mono text-xs">access</td><td className="px-4 py-2 text-muted-foreground"><code className="rounded bg-muted px-1 text-xs">public</code>, <code className="rounded bg-muted px-1 text-xs">private</code>, or <code className="rounded bg-muted px-1 text-xs">signed</code></td><td className="px-4 py-2 text-muted-foreground">public</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: 'serving',
    title: 'Serving Files (CDN)',
    content: (
      <div className="space-y-4">
        <p>Files are served directly from your MediaOS domain. Use the URLs returned from the upload response.</p>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Direct file delivery</h4>
          <CopyBlock code={`${API_URL}/f/{project_id}/{folder}/{filename}`} />
          <p className="mt-2 text-sm text-muted-foreground">
            Standard video and audio playback uses this direct CDN URL and supports browser byte-range requests. A normal upload does not include a separate streaming URL.
          </p>
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">HLS delivery</h4>
          <CopyBlock lang="typescript" code={`const playbackUrl = file.has_hls && file.hls_url
  ? file.hls_url
  : file.url; // direct MP4 fallback while HLS is processing`} />
          <p className="mt-2 text-sm text-muted-foreground">
            The upload response exposes <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">has_hls</code> and <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">hls_url</code> after an explicit streaming upload finishes. Until then, use the returned <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">url</code> as the source fallback.
          </p>
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Dynamic Image Resizing</h4>
          <p className="mb-2 text-sm text-muted-foreground">
            Resize images on-the-fly via imgproxy. Results are cached with immutable cache headers.
          </p>
          <CopyBlock code={`# Fit within 400x400 (preserves aspect ratio)
${API_URL}/img/fit/400/400/f/{project_id}/{folder}/{filename}.webp

# Fill 200x200 (crop to exact size)
${API_URL}/img/fill/200/200/f/{project_id}/{folder}/{filename}.webp

# Auto width, max height 600
${API_URL}/img/fit/0/600/f/{project_id}/{folder}/{filename}.webp

# Force exact dimensions
${API_URL}/img/force/800/600/f/{project_id}/{folder}/{filename}.webp`} />
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Resize Types</h4>
          <div className="overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border/50 bg-muted/30"><th className="px-4 py-2 text-left font-medium">Type</th><th className="px-4 py-2 text-left font-medium">Behavior</th></tr></thead>
              <tbody>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">fit</td><td className="px-4 py-2 text-muted-foreground">Fit within bounds, preserve aspect ratio</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">fill</td><td className="px-4 py-2 text-muted-foreground">Crop to fill exact dimensions</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">auto</td><td className="px-4 py-2 text-muted-foreground">Same as fit, auto-detect best approach</td></tr>
                <tr><td className="px-4 py-2 font-mono text-xs">force</td><td className="px-4 py-2 text-muted-foreground">Force exact dimensions (may distort)</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Use in HTML</h4>
          <CopyBlock code={`<!-- Responsive image with srcset -->
<img
  src="${API_URL}/img/fit/800/0/f/{project_id}/photos/hero.webp"
  srcset="
    ${API_URL}/img/fit/400/0/f/{project_id}/photos/hero.webp 400w,
    ${API_URL}/img/fit/800/0/f/{project_id}/photos/hero.webp 800w,
    ${API_URL}/img/fit/1200/0/f/{project_id}/photos/hero.webp 1200w
  "
  sizes="(max-width: 600px) 400px, (max-width: 1200px) 800px, 1200px"
  alt="Hero image"
  loading="lazy"
/>`} />
        </div>
      </div>
    ),
  },
  {
    id: 'list-files',
    title: 'List & Get Files',
    content: (
      <div className="space-y-4">
        <div>
          <h4 className="mb-1 text-sm font-semibold">List Files</h4>
          <p className="mb-2 text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">GET /api/v1/files</code> — Paginated file listing with filters.
          </p>
          <CopyBlock code={`curl "${API_URL}/api/v1/files?page=1&limit=20&type=image&folder=avatars" \\
  -H "X-API-Key: mv_live_your_key_here"`} />
          <div className="mt-2 overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border/50 bg-muted/30"><th className="px-4 py-2 text-left font-medium">Param</th><th className="px-4 py-2 text-left font-medium">Description</th></tr></thead>
              <tbody>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">page</td><td className="px-4 py-2 text-muted-foreground">Page number (default: 1)</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">limit</td><td className="px-4 py-2 text-muted-foreground">Items per page (default: 50, max: 100)</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">type</td><td className="px-4 py-2 text-muted-foreground">Filter: image, video, audio, document, file</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">folder</td><td className="px-4 py-2 text-muted-foreground">Filter by folder path</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">search</td><td className="px-4 py-2 text-muted-foreground">Search by filename</td></tr>
                <tr><td className="px-4 py-2 font-mono text-xs">sort</td><td className="px-4 py-2 text-muted-foreground">Sort by: created_at, size, filename</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Get Single File</h4>
          <CopyBlock code={`curl "${API_URL}/api/v1/files/{file_id}" \\
  -H "X-API-Key: mv_live_your_key_here"`} />
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Delete File</h4>
          <CopyBlock code={`curl -X DELETE "${API_URL}/api/v1/files/{file_id}" \\
  -H "X-API-Key: mv_live_your_key_here"`} />
        </div>
      </div>
    ),
  },
  {
    id: 'signed-urls',
    title: 'Signed URLs',
    content: (
      <div className="space-y-4">
        <p>For private or signed-access files, generate time-limited signed URLs.</p>
        <CopyBlock code={`# Generate a signed URL (default: 1 hour expiry)
curl "${API_URL}/api/v1/files/{file_id}/signed-url?expires=3600" \\
  -H "X-API-Key: mv_live_your_key_here"

# Response:
{
  "url": "${API_URL}/f/{project_id}/...?token=abc123&expires=1709654400",
  "expires_at": "2026-03-05T20:00:00Z"
}`} />
        <p className="text-sm text-muted-foreground">
          Max expiry is 86400 seconds (24 hours). Signed URLs work for both original files and resized images.
        </p>
      </div>
    ),
  },
  {
    id: 'usage',
    title: 'Usage & Stats',
    content: (
      <div className="space-y-4">
        <div>
          <h4 className="mb-1 text-sm font-semibold">Current Usage</h4>
          <CopyBlock code={`curl "${API_URL}/api/v1/usage" \\
  -H "X-API-Key: mv_live_your_key_here"`} />
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Usage History (daily)</h4>
          <CopyBlock code={`curl "${API_URL}/api/v1/usage/history?days=30" \\
  -H "X-API-Key: mv_live_your_key_here"`} />
        </div>
      </div>
    ),
  },
  {
    id: 'sdk',
    title: 'JavaScript SDK',
    content: (
      <div className="space-y-4">
        <CopyBlock code="npm install @mediaos/sdk" />
        <CopyBlock lang="typescript" code={`import { MediaOS } from '@mediaos/sdk';

const media = new MediaOS({
  url: '${API_URL}',
  apiKey: 'mv_live_your_key_here',
});

// Fast storage-only upload (video/audio are not transcoded)
const file = await media.upload(buffer, {
  name: 'photo.jpg',
  folder: 'avatars',
});

// Explicit adaptive streaming upload for video
const stream = await media.uploadStream(videoBuffer, {
  name: 'launch.mp4',
  folder: 'streaming',
});

// List files
const files = await media.files.list({ type: 'image', limit: 20 });

// Get file
const asset = await media.files.get('file-id');

// Delete
await media.files.delete('file-id');

// Signed URL
const { url } = await media.files.signedUrl('file-id', { expires: 3600 });`} />
      </div>
    ),
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    content: (
      <div className="space-y-4">
        <p>Configure webhooks in the dashboard under <strong>Projects &rarr; Webhooks</strong>. MediaOS sends POST requests with HMAC-SHA256 signatures.</p>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Events</h4>
          <div className="overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border/50 bg-muted/30"><th className="px-4 py-2 text-left font-medium">Event</th><th className="px-4 py-2 text-left font-medium">Description</th></tr></thead>
              <tbody>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">file.uploaded</td><td className="px-4 py-2 text-muted-foreground">A file was uploaded successfully</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">file.processed</td><td className="px-4 py-2 text-muted-foreground">Async processing completed (video)</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">file.failed</td><td className="px-4 py-2 text-muted-foreground">Processing failed</td></tr>
                <tr><td className="px-4 py-2 font-mono text-xs">file.deleted</td><td className="px-4 py-2 text-muted-foreground">A file was deleted</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Verify Signature</h4>
          <CopyBlock lang="javascript" code={`const crypto = require('crypto');

function verifyWebhook(body, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// In your handler:
const sig = req.headers['x-webhook-signature'];
if (!verifyWebhook(req.body, sig, 'your_webhook_secret')) {
  return res.status(401).send('Invalid signature');
}`} />
        </div>
      </div>
    ),
  },
  {
    id: 'self-hosting',
    title: 'Self-Hosting',
    content: (
      <div className="space-y-4">
        <p>MediaOS runs entirely on your own infrastructure. Point your CDN domain to the worker service.</p>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Docker Compose</h4>
          <CopyBlock code={`# Clone and start
git clone https://github.com/arrrrniii/mediaos.git
cd mediaos
cp .env.example .env   # Edit with your settings
docker compose up -d`} />
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Custom Domain Setup</h4>
          <p className="mb-2 text-sm text-muted-foreground">Point your domain to the worker service (port 3000). Use a reverse proxy like Nginx or Caddy:</p>
          <CopyBlock code={`# Caddyfile
cdn.yourdomain.com {
    reverse_proxy localhost:3000
}

dashboard.yourdomain.com {
    reverse_proxy localhost:3001
}`} />
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Environment Variables</h4>
          <div className="overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border/50 bg-muted/30"><th className="px-4 py-2 text-left font-medium">Variable</th><th className="px-4 py-2 text-left font-medium">Description</th></tr></thead>
              <tbody>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">PUBLIC_URL</td><td className="px-4 py-2 text-muted-foreground">Your CDN domain (e.g. https://cdn.yourdomain.com)</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">DASHBOARD_URL</td><td className="px-4 py-2 text-muted-foreground">Dashboard URL (e.g. https://dashboard.yourdomain.com)</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">MASTER_KEY</td><td className="px-4 py-2 text-muted-foreground">System-admin key for creating and listing accounts</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">INTERNAL_API_SECRET</td><td className="px-4 py-2 text-muted-foreground">Shared secret for dashboard-to-worker auth</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">NEXTAUTH_SECRET</td><td className="px-4 py-2 text-muted-foreground">Random secret for session encryption</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">PG_PASSWORD</td><td className="px-4 py-2 text-muted-foreground">PostgreSQL password</td></tr>
                <tr className="border-b border-border/30"><td className="px-4 py-2 font-mono text-xs">MINIO_ROOT_PASSWORD</td><td className="px-4 py-2 text-muted-foreground">MinIO storage password</td></tr>
                <tr><td className="px-4 py-2 font-mono text-xs">REDIS_PASSWORD</td><td className="px-4 py-2 text-muted-foreground">Redis password</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    ),
  },
  ];
}

export default function DocsPage() {
  const [active, setActive] = useState('authentication');
  const apiUrl = useSyncExternalStore(subscribeToOrigin, browserApiUrl, serverApiUrl);

  const sections = getSections(apiUrl);

  return (
    <div className="space-y-8">
      <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-card p-6 shadow-sm sm:p-8">
        <div className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative max-w-3xl">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="gap-1.5 border-primary/30 bg-primary/5 text-primary">
              <BookOpen className="h-3 w-3" /> API v1
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">{apiUrl}</span>
          </div>
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">From upload to a production URL.</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
            Store ordinary media immediately. Opt into adaptive processing only for videos that truly need HLS streaming.
          </p>
        </div>

        <div className="relative mt-7 grid gap-3 md:grid-cols-3">
          {[
            { icon: KeyRound, step: '1', title: 'Create a scoped key', body: 'Open a project and grant only the upload and read scopes your app needs.' },
            { icon: UploadCloud, step: '2', title: 'Choose the upload path', body: 'Use standard upload for storage, or the streaming endpoint for adaptive video.' },
            { icon: Link2, step: '3', title: 'Deliver the returned URL', body: 'Use the direct file URL immediately and HLS only when it becomes available.' },
          ].map((item, index) => (
            <div key={item.step} className="relative rounded-xl border border-border/60 bg-background/60 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><item.icon className="h-4 w-4" /></div>
                <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Step {item.step}</p><p className="text-sm font-semibold">{item.title}</p></div>
              </div>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">{item.body}</p>
              {index < 2 && <ArrowRight className="absolute -right-5 top-1/2 z-10 hidden h-4 w-4 text-muted-foreground/40 md:block" />}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        {/* Sticky sidebar nav */}
        <nav className="hidden w-52 shrink-0 lg:block">
          <div className="sticky top-6 rounded-xl border border-border/60 bg-card p-2 shadow-sm">
            <p className="px-3 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">On this page</p>
            {sections.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setActive(s.id);
                  document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                className={cn(
                  'block w-full rounded-md px-3 py-2 text-left text-[13px] transition-colors',
                  active === s.id
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {s.title}
              </button>
            ))}
          </div>
        </nav>

        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:hidden">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setActive(s.id);
                document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1.5 text-xs',
                active === s.id ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground',
              )}
            >
              {s.title}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1 space-y-6">
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="scroll-mt-6 rounded-xl border border-border/60 bg-card p-5 shadow-sm sm:p-6">
              <div className="mb-5 flex items-center gap-3 border-b border-border/50 pb-4">
                <div className="h-2 w-2 rounded-full bg-primary" />
                <h3 className="text-lg font-semibold">{s.title}</h3>
              </div>
              <div className="text-sm leading-relaxed">{s.content}</div>
            </section>
          ))}
          <div className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
            <p className="text-muted-foreground"><span className="font-medium text-foreground">Production note.</span> Keep API keys server-side, use signed access for private media, and prefer scoped keys over full access.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
