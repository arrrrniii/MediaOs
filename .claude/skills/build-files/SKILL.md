---
name: build-files
description: Build MediaVault Track 3 — File Processing & Upload. Image/video processors, file service, upload/list/delete/serve routes.
disable-model-invocation: true
context: fork
---

# Track 3: File Processing & Upload

Read `info.md` sections 5-6 and 8-9 for complete specifications. Tracks 1 and 2 must be complete.

## Tasks

### TASK 3.1 — Image + Video Processors + Queue
Create:
- `worker/src/utils/slugify.js` — Filename normalization: lowercase, replace spaces with dashes, strip non-alphanumeric except dash/underscore/dot
- `worker/src/utils/mimeTypes.js` — Extension to MIME mapping
- `worker/src/utils/fileTypes.js` — Extension to type classification (image, video, video_passthrough, audio, file) per info.md section 8

- `worker/src/services/imageProcessor.js`
  - `processImage(buffer, options)` — Sharp resize + WebP conversion
  - Check animated GIF -> route to video pipeline
  - sharp(buffer).resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true }).webp({ quality }).toBuffer()
  - Return { buffer, width, height, size }

- `worker/src/services/videoProcessor.js`
  - `transcodeVideo(inputPath, outputPath, options)` — FFmpeg: libx264, medium preset, CRF, scale, AAC 128k, faststart, yuv420p
  - `extractThumbnail(inputPath, outputPath)` — WebP thumbnail at 1s (fallback 0s)
  - `getVideoInfo(inputPath)` — ffprobe: duration, width, height

- `worker/src/services/queue.js`
  - Bounded concurrency job queue
  - `enqueue(key, fn)` — add job, respect concurrency limit
  - On success: update file status to 'done', fire webhook
  - On failure: update file status to 'failed', preserve original

### TASK 3.2 — File Service + Upload Route
Create:
- `worker/src/services/fileService.js`
  - `uploadFile(file, project, options)` — Full pipeline per info.md section 8: detect type, generate storage key `{project.id}/{folder?}/{slug}-{nanoid6}.{ext}`, process by type, insert files row, update project counters, fire webhook, return metadata
  - `deleteFile(fileId, project)` — Soft delete, remove from MinIO, decrement counters, fire webhook
  - `listFiles(project, filters)` — Paginated query with folder/type/search/sort filters
  - `getFile(fileId, project)` — Single file metadata

- `worker/src/routes/upload.js`
  - POST /api/v1/upload — multer single('file'), auth('upload'), call fileService.uploadFile
  - Return 200 for sync (images), 202 for async (videos)
  - Response format per info.md section 6

### TASK 3.3 — File List/Search/Delete Routes
Create:
- `worker/src/routes/files.js`
  - GET /api/v1/files — auth('read'), pagination, filters (folder, type, search, sort, order, status)
  - GET /api/v1/files/:id — auth('read'), single file
  - DELETE /api/v1/files/:id — auth('delete'), soft delete

### TASK 3.4 — File Serving Route
Create:
- `worker/src/routes/serve.js`
  - GET /f/:projectId/* — Direct serve from MinIO, zero buffering stream
  - GET /img/:type/:width/:height/f/:projectId/* — Proxy to imgproxy
  - Handle: Cache-Control (public, max-age=31536000, immutable), Range requests (206), ETag, CORS, Content-Type
  - Private files: validate signed URL token
  - Processing files: return 202 with auto-refreshing HTML
  - Log bandwidth (fire-and-forget)

## Storage Key Format
`{project_id}/{folder}/{slug}-{nanoid6}.{ext}`

## Rules
- CommonJS, 2-space indent, semicolons, single quotes
- const by default, async/await everywhere
- Fire-and-forget for non-critical writes (bandwidth log, usage tracking)
