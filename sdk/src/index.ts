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

  constructor(config: MediaOSConfig) {
    if (!config.url) throw new Error('MediaOS: url is required');
    if (!config.apiKey) throw new Error('MediaOS: apiKey is required');

    this.baseUrl = config.url.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30000;

    this.files = this._files;
    this.usage = this._usage;
    this.webhooks = this._webhooks;
  }

  // ── HTTP helper ──────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; params?: Record<string, string | number | undefined>; formData?: FormData } = {}
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

    return this.request<UploadResult>('POST', '/upload', { formData, params });
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
