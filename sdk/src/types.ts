export interface MediaOSConfig {
  url: string;
  apiKey: string;
  timeout?: number;
}

export interface UploadOptions {
  folder?: string;
  name?: string;
  access?: 'public' | 'private' | 'signed';
  /** Repeating an upload with the same key returns the original file. */
  idempotencyKey?: string;
}

export type VariantMode = 'fit' | 'fill' | 'auto' | 'force';
export type VariantFormat = 'auto' | 'webp' | 'avif' | 'jpeg' | 'png';

export interface VariantInput {
  name: string;
  mode: VariantMode;
  width: number;
  height: number;
  format?: VariantFormat;
  quality?: number | null;
}

export interface Variant extends VariantInput {
  id?: string;
  project_id?: string;
  quality: number | null;
  format: VariantFormat;
  builtin?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface VariantListResult {
  data: Variant[];
  builtins: Variant[];
}

export interface VariantUrlOptions {
  format?: VariantFormat;
  token?: string;
  expires?: number;
}

export interface SrcsetResult {
  widths: number[];
  sizes: string;
  srcset: string;
  urls: Array<{ width: number; url: string }>;
}

export interface DirectUploadGrant {
  id: string;
  upload_url: string;
  method: 'PUT';
  max_bytes: number | null;
  content_type: string | null;
  access: string | null;
  folder: string | null;
  expires_at: string;
  created_at: string;
}

export interface DirectUploadOptions {
  contentType?: string;
  content_type?: string;
  maxBytes?: number;
  max_bytes?: number;
  access?: 'public' | 'private' | 'signed';
  folder?: string;
  idempotencyKey?: string;
  expiresIn?: number;
}

export interface MultipartStartOptions {
  filename?: string;
  size?: number;
  contentType?: string;
  folder?: string;
  access?: 'public' | 'private' | 'signed';
  idempotencyKey?: string;
}

export interface MultipartSession {
  id: string;
  project_id?: string;
  filename?: string;
  content_type?: string | null;
  access?: string | null;
  folder?: string | null;
  status: 'active' | 'completed' | 'aborted' | 'expired';
  total_bytes: number | null;
  received_bytes: number;
  parts: Array<{ part_number: number; size: number }>;
  part_size: number;
  file_id: string | null;
  created_at?: string;
  expires_at?: string;
  idempotent_replay?: boolean;
  file?: UploadResult;
}

export interface MultipartPartResult {
  part_number: number;
  size: number;
  received_bytes: number;
}

export interface MultipartCompleteResult {
  file: UploadResult;
  already_completed?: boolean;
}

export interface PurgeCacheResult {
  cache_version: number | null;
  objects_removed: number;
  purged: boolean;
}

export interface FileListOptions {
  page?: number;
  limit?: number;
  folder?: string;
  type?: 'image' | 'video' | 'file';
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface UrlOptions {
  width?: number;
  height?: number;
  fit?: 'fit' | 'fill' | 'auto' | 'force';
}

export interface FileUrls {
  original: string;
  thumb?: string;
  sm?: string;
  md?: string;
  lg?: string;
  thumbnail?: string;
}

export interface UploadResult {
  id: string;
  filename: string;
  url: string;
  storage_key: string;
  urls: FileUrls;
  type: 'image' | 'video' | 'audio' | 'document' | 'file';
  mime_type: string;
  size: number;
  original_size: number;
  width?: number;
  height?: number;
  access: string;
  status: 'done' | 'processing';
  /** True once adaptive HLS derivatives are available (streaming uploads only). */
  has_hls?: boolean;
  video_status?: 'processing' | 'ready' | 'failed';
  hls_url?: string;
  poster_url?: string;
  processing_ms: number;
  created_at: string;
}

export interface FileMetadata extends UploadResult {
  original_name: string;
  folder: string | null;
  duration?: number;
  thumbnail_key?: string;
  metadata: Record<string, unknown>;
}

export interface FileListResult {
  data: UploadResult[];
  total: number;
  page: number;
  limit: number;
}

export interface BulkUploadResult {
  uploaded: number;
  failed: number;
  files: UploadResult[];
  errors: Array<{ filename: string; error: string }>;
}

export interface DeleteResult {
  deleted: boolean;
  id: string;
  storage_key: string;
  freed_bytes: number;
}

export interface SignedUrlResult {
  url: string;
  expires_at: string;
}

export interface UsageResult {
  project_id: string;
  period: string;
  storage: { used: number; limit: number; percent: number };
  bandwidth: { used: number; limit: number; percent: number };
  uploads: number;
  downloads: number;
  transforms: number;
  files: { total: number; images: number; videos: number; other: number };
}

export interface UsageHistoryResult {
  data: Array<{
    date: string;
    uploads: number;
    upload_bytes: number;
    downloads: number;
    download_bytes: number;
    transforms: number;
    deletes: number;
    api_requests: number;
    storage_bytes: number;
    file_count: number;
  }>;
}

export interface WebhookResult {
  id: string;
  project_id: string;
  url: string;
  secret: string;
  events: string[];
  status: string;
  created_at: string;
}

export interface WebhookListResult {
  data: Array<{
    id: string;
    project_id: string;
    url: string;
    events: string[];
    status: string;
    last_triggered: string | null;
    last_status: number | null;
    success_count: number;
    failure_count: number;
    created_at: string;
  }>;
}

export interface MediaOSError {
  error: string;
  code: string;
  status: number;
}
