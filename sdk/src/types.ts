export interface MediaOSConfig {
  url: string;
  apiKey: string;
  timeout?: number;
}

export interface UploadOptions {
  folder?: string;
  name?: string;
  access?: 'public' | 'private';
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
  type: 'image' | 'video' | 'file';
  mime_type: string;
  size: number;
  original_size: number;
  width?: number;
  height?: number;
  access: string;
  status: 'done' | 'processing';
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
