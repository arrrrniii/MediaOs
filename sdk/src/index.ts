import { createHmac } from 'crypto';
import type {
  MediaOSConfig,
  UploadOptions,
  UploadResult,
  BulkUploadResult,
  FileListOptions,
  FileListResult,
  FileMetadata,
  DeleteResult,
  SignedUrlResult,
  UsageResult,
  UsageHistoryResult,
  WebhookResult,
  WebhookListResult,
  UrlOptions,
  MediaOSError,
  Variant,
  VariantInput,
  VariantListResult,
  VariantUrlOptions,
  SrcsetResult,
  DirectUploadGrant,
  DirectUploadOptions,
  MultipartStartOptions,
  MultipartSession,
  MultipartPartResult,
  MultipartCompleteResult,
  PurgeCacheResult,
} from './types';

export * from './types';

export class MediaOSApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'MediaOSApiError';
    this.code = code;
    this.status = status;
  }
}

export class MediaOS {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

  files: MediaOS['_files'];
  usage: MediaOS['_usage'];
  webhooks: MediaOS['_webhooks'];
  variants: MediaOS['_variants'];

  constructor(config: MediaOSConfig) {
    if (!config.url) throw new Error('MediaOS: url is required');
    if (!config.apiKey) throw new Error('MediaOS: apiKey is required');

    this.baseUrl = config.url.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30000;

    this.files = this._files;
    this.usage = this._usage;
    this.webhooks = this._webhooks;
    this.variants = this._variants;
  }

  // ── HTTP helper ──────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; params?: Record<string, string | number | undefined>; formData?: FormData; headers?: Record<string, string> } = {}
  ): Promise<T> {
    let url = `${this.baseUrl}/api/v1${path}`;

    if (options.params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          searchParams.set(key, String(value));
        }
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      ...(options.headers || {}),
    };

    let body: string | FormData | undefined;
    if (options.formData) {
      body = options.formData;
    } else if (options.body) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorData: MediaOSError;
        try {
          errorData = await response.json() as MediaOSError;
        } catch {
          errorData = { error: response.statusText, code: 'UNKNOWN', status: response.status };
        }
        throw new MediaOSApiError(
          errorData.error || response.statusText,
          errorData.code || 'UNKNOWN',
          response.status
        );
      }

      return await response.json() as T;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof MediaOSApiError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new MediaOSApiError('Request timed out', 'TIMEOUT', 408);
      }
      throw err;
    }
  }

  // ── Upload ─────────────────────────────────────────

  async upload(
    file: Buffer | Blob,
    options: UploadOptions = {}
  ): Promise<UploadResult> {
    const formData = new FormData();

    if (Buffer.isBuffer(file)) {
      formData.append('file', new Blob([file]), options.name || 'upload');
    } else {
      formData.append('file', file, options.name);
    }

    const params: Record<string, string | undefined> = {};
    if (options.folder) params.folder = options.folder;
    if (options.access) params.access = options.access;

    const headers: Record<string, string> = {};
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    return this.request<UploadResult>('POST', '/upload', { formData, params, headers });
  }

  // ── Direct one-time uploads ────────────────────────

  /** Create a one-time presigned upload grant (no bytes transferred yet). */
  async createDirectUpload(options: DirectUploadOptions = {}): Promise<DirectUploadGrant> {
    return this.request<DirectUploadGrant>('POST', '/uploads/direct', {
      body: {
        content_type: options.contentType ?? options.content_type,
        max_bytes: options.maxBytes ?? options.max_bytes,
        access: options.access,
        folder: options.folder,
        idempotency_key: options.idempotencyKey,
        expires_in: options.expiresIn,
      },
    });
  }

  /**
   * One-shot direct upload: create a grant, then PUT the bytes to it. Returns
   * the created file. The PUT goes to the absolute grant URL, not /api/v1.
   */
  async directUpload(file: Buffer | Blob, options: DirectUploadOptions = {}): Promise<UploadResult> {
    const grant = await this.createDirectUpload(options);
    const body = Buffer.isBuffer(file) ? new Blob([file]) : file;
    const res = await fetch(grant.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': options.contentType ?? options.content_type ?? 'application/octet-stream' },
      body,
    });
    if (!res.ok) {
      let data: MediaOSError;
      try { data = await res.json() as MediaOSError; } catch { data = { error: res.statusText, code: 'UNKNOWN', status: res.status }; }
      throw new MediaOSApiError(data.error || res.statusText, data.code || 'UNKNOWN', res.status);
    }
    return await res.json() as UploadResult;
  }

  // ── Resumable multipart uploads ────────────────────

  private _multipart = {
    start: (options: MultipartStartOptions = {}): Promise<MultipartSession> => {
      const headers: Record<string, string> = {};
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
      return this.request<MultipartSession>('POST', '/uploads/multipart/start', {
        body: {
          filename: options.filename, size: options.size, content_type: options.contentType,
          folder: options.folder, access: options.access,
        },
        headers,
      });
    },

    get: (id: string): Promise<MultipartSession> => {
      return this.request<MultipartSession>('GET', `/uploads/multipart/${id}`);
    },

    uploadPart: async (id: string, partNumber: number, chunk: Buffer | Blob): Promise<MultipartPartResult> => {
      const body = Buffer.isBuffer(chunk) ? new Blob([chunk]) : chunk;
      const res = await fetch(`${this.baseUrl}/api/v1/uploads/multipart/${id}/parts/${partNumber}`, {
        method: 'PUT',
        headers: { 'X-API-Key': this.apiKey, 'Content-Type': 'application/octet-stream' },
        body,
      });
      if (!res.ok) {
        let data: MediaOSError;
        try { data = await res.json() as MediaOSError; } catch { data = { error: res.statusText, code: 'UNKNOWN', status: res.status }; }
        throw new MediaOSApiError(data.error || res.statusText, data.code || 'UNKNOWN', res.status);
      }
      return await res.json() as MultipartPartResult;
    },

    complete: (id: string): Promise<MultipartCompleteResult> => {
      return this.request<MultipartCompleteResult>('POST', `/uploads/multipart/${id}/complete`, {});
    },

    abort: (id: string): Promise<{ aborted: boolean; id: string }> => {
      return this.request('POST', `/uploads/multipart/${id}/abort`, {});
    },
  };

  get multipart() {
    return this._multipart;
  }

  /**
   * High-level resumable upload: start a session, upload the buffer in parts,
   * and complete. `partSize` defaults to the server's recommendation.
   */
  async uploadResumable(
    file: Buffer,
    options: MultipartStartOptions & { partSize?: number } = {}
  ): Promise<UploadResult> {
    const session = await this._multipart.start({ ...options, size: file.length });
    if (session.idempotent_replay && session.file) return session.file;

    const partSize = options.partSize || session.part_size || 8 * 1024 * 1024;
    const total = Math.max(1, Math.ceil(file.length / partSize));
    for (let i = 0; i < total; i++) {
      const chunk = file.subarray(i * partSize, Math.min(file.length, (i + 1) * partSize));
      await this._multipart.uploadPart(session.id, i + 1, chunk);
    }
    const done = await this._multipart.complete(session.id);
    return done.file;
  }

  async uploadBulk(
    files: Array<{ data: Buffer | Blob; name?: string }>,
    options: { folder?: string; access?: string } = {}
  ): Promise<BulkUploadResult> {
    const formData = new FormData();

    for (const file of files) {
      if (Buffer.isBuffer(file.data)) {
        formData.append('files', new Blob([file.data]), file.name || 'upload');
      } else {
        formData.append('files', file.data, file.name);
      }
    }

    const params: Record<string, string | undefined> = {};
    if (options.folder) params.folder = options.folder;
    if (options.access) params.access = options.access;

    return this.request<BulkUploadResult>('POST', '/upload/bulk', { formData, params });
  }

  // ── Files ──────────────────────────────────────────

  private _files = {
    list: (options: FileListOptions = {}): Promise<FileListResult> => {
      return this.request<FileListResult>('GET', '/files', {
        params: options as Record<string, string | number | undefined>,
      });
    },

    get: (id: string): Promise<FileMetadata> => {
      return this.request<FileMetadata>('GET', `/files/${id}`);
    },

    delete: (id: string): Promise<DeleteResult> => {
      return this.request<DeleteResult>('DELETE', `/files/${id}`);
    },

    signedUrl: (id: string, expiresIn?: number): Promise<SignedUrlResult> => {
      return this.request<SignedUrlResult>('GET', `/files/${id}/signed-url`, {
        params: expiresIn ? { expires: expiresIn } : undefined,
      });
    },

    srcset: (id: string, options: { widths?: number[]; mode?: string; format?: string; sizes?: string } = {}): Promise<SrcsetResult> => {
      return this.request<SrcsetResult>('GET', `/files/${id}/srcset`, {
        params: {
          widths: options.widths ? options.widths.join(',') : undefined,
          mode: options.mode,
          format: options.format,
          sizes: options.sizes,
        },
      });
    },

    purgeCache: (id: string): Promise<PurgeCacheResult> => {
      return this.request<PurgeCacheResult>('POST', `/files/${id}/purge-cache`, {});
    },
  };

  // ── Named variants ─────────────────────────────────

  private _variants = {
    list: (): Promise<VariantListResult> => {
      return this.request<VariantListResult>('GET', '/variants');
    },

    create: (variant: VariantInput): Promise<Variant> => {
      return this.request<Variant>('POST', '/variants', { body: variant });
    },

    delete: async (name: string): Promise<void> => {
      await this.request('DELETE', `/variants/${encodeURIComponent(name)}`);
    },
  };

  // ── URL Helpers (no API call) ──────────────────────

  url(key: string, options: UrlOptions = {}): string {
    if (options.width || options.height) {
      const fit = options.fit || 'fit';
      const w = options.width || 0;
      const h = options.height || 0;
      return `${this.baseUrl}/img/${fit}/${w}/${h}/f/${key}`;
    }
    return `${this.baseUrl}/f/${key}`;
  }

  thumbnailUrl(key: string, size: number = 200): string {
    return `${this.baseUrl}/img/fit/${size}/${size}/f/${key}`;
  }

  /**
   * URL for a named variant of a file (no API call). Pass token/expires for a
   * signed variant of a private file; pass format to override negotiation.
   */
  variantUrl(key: string, variant: string, options: VariantUrlOptions = {}): string {
    let url = `${this.baseUrl}/img/v/${encodeURIComponent(variant)}/f/${key}`;
    const qs = new URLSearchParams();
    if (options.format) qs.set('format', options.format);
    if (options.token) qs.set('token', options.token);
    if (options.expires) qs.set('expires', String(options.expires));
    const s = qs.toString();
    return s ? `${url}?${s}` : url;
  }

  /**
   * Build a responsive srcset string locally from a key and a set of widths
   * (no API call). For public files only — private files should use
   * files.srcset() so each candidate is signed.
   */
  srcset(key: string, widths: number[] = [320, 640, 960, 1280, 1600], options: { mode?: string; format?: string } = {}): string {
    const mode = options.mode || 'fit';
    return widths
      .map((w) => {
        let u = `${this.baseUrl}/img/${mode}/${w}/0/f/${key}`;
        if (options.format) u += `?format=${options.format}`;
        return `${u} ${w}w`;
      })
      .join(', ');
  }

  // ── Usage ──────────────────────────────────────────

  private _usage = {
    current: (): Promise<UsageResult> => {
      return this.request<UsageResult>('GET', '/usage');
    },

    history: (days?: number): Promise<UsageHistoryResult> => {
      return this.request<UsageHistoryResult>('GET', '/usage/history', {
        params: days ? { days } : undefined,
      });
    },
  };

  // ── Webhooks ───────────────────────────────────────

  private _webhooks = {
    list: (): Promise<WebhookListResult> => {
      return this.request<WebhookListResult>('GET', '/webhooks');
    },

    create: (url: string, events: string[]): Promise<WebhookResult> => {
      return this.request<WebhookResult>('POST', '/webhooks', {
        body: { url, events },
      });
    },

    delete: async (id: string): Promise<void> => {
      await this.request('DELETE', `/webhooks/${id}`);
    },

    verify: (payload: string, signature: string, secret: string): boolean => {
      const expected = createHmac('sha256', secret).update(payload).digest('hex');
      if (expected.length !== signature.length) return false;
      // Constant-time comparison
      let result = 0;
      for (let i = 0; i < expected.length; i++) {
        result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
      }
      return result === 0;
    },
  };
}

export default MediaOS;
