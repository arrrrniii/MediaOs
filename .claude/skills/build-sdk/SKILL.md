---
name: build-sdk
description: Build MediaVault Track 6 — TypeScript SDK. npm package with upload, file operations, URL helpers, usage, and webhook verification.
disable-model-invocation: true
context: fork
---

# Track 6: TypeScript SDK

Read `info.md` section 14 for complete specifications. Track 3 API must be working.

## Task

### TASK 6.1 — TypeScript SDK
Create the `sdk/` directory with full package structure:

- `sdk/package.json` — Name: `@mediavault/sdk`, TypeScript build, ESM + CJS output
- `sdk/tsconfig.json` — Strict mode, declaration files, ESM target
- `sdk/src/index.ts` — Main export: `MediaVault` class
- `sdk/src/client.ts` — HTTP client with API key auth, timeout, error handling
- `sdk/src/upload.ts` — `upload(file, options)` and `uploadBulk(files, options)`
- `sdk/src/files.ts` — `list(options)`, `get(id)`, `delete(id)`, `signedUrl(id, expiresIn)`
- `sdk/src/url.ts` — URL builder helpers: `url(key, options)`, `thumbnailUrl(key, size)`
- `sdk/src/types.ts` — All TypeScript interfaces: UploadResult, FileMetadata, FileListResult, etc.
- `sdk/README.md` — Usage examples for all methods

## MediaVault Class API

```typescript
class MediaVault {
  constructor(config: { url: string; apiKey: string; timeout?: number });

  // Upload
  upload(file, options?): Promise<UploadResult>;
  uploadBulk(files, options?): Promise<BulkUploadResult>;

  // Files
  files: {
    list(options?): Promise<FileListResult>;
    get(id): Promise<FileMetadata>;
    delete(id): Promise<DeleteResult>;
    signedUrl(id, expiresIn?): Promise<SignedUrlResult>;
  };

  // URL helpers (no API call)
  url(key, options?): string;
  thumbnailUrl(key, size?): string;

  // Usage
  usage: {
    current(): Promise<UsageResult>;
    history(days?): Promise<UsageHistoryResult>;
  };

  // Webhooks
  webhooks: {
    list(): Promise<WebhookListResult>;
    create(url, events): Promise<WebhookResult>;
    delete(id): Promise<void>;
    verify(payload, signature, secret): boolean;
  };
}
```

## URL Helper Logic
- `url(key)` → `{baseUrl}/f/{key}`
- `url(key, { width: 800 })` → `{baseUrl}/img/fit/800/0/f/{key}`
- `url(key, { width: 200, height: 200, fit: 'fill' })` → `{baseUrl}/img/fill/200/200/f/{key}`
- `thumbnailUrl(key, 200)` → `{baseUrl}/img/fit/200/200/f/{key}`

## Webhook Verification
```typescript
verify(payload: string, signature: string, secret: string): boolean
// Recompute HMAC-SHA256(secret, payload), constant-time compare with signature
```

## Rules
- TypeScript strict mode
- Support both ESM and CJS consumers
- Zero runtime dependencies (use native fetch, crypto)
- All methods async except url() and thumbnailUrl()
- Proper error types with status codes
