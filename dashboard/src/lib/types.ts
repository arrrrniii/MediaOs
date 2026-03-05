export interface Account {
  id: string;
  name: string;
  email: string;
  plan: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  account_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  signing_secret?: string;
  settings: ProjectSettings;
  storage_used: number;
  file_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectSettings {
  max_file_size: number;
  allowed_types: string[];
  webp_quality: number;
  max_width: number;
  max_height: number;
  default_access: 'public' | 'private';
}

export interface ApiKey {
  id: string;
  project_id: string;
  name: string;
  key?: string;
  key_prefix: string;
  scopes: string[];
  rate_limit: number;
  status: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface FileRecord {
  id: string;
  project_id: string;
  filename: string;
  original_name: string;
  storage_key: string;
  folder: string | null;
  type: 'image' | 'video' | 'audio' | 'document' | 'file';
  mime_type: string;
  size: number;
  original_size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  access: string;
  status: string;
  thumbnail_key: string | null;
  metadata: Record<string, unknown>;
  url: string;
  urls: Record<string, string>;
  processing_ms: number;
  created_at: string;
  updated_at: string;
}

export interface Webhook {
  id: string;
  project_id: string;
  url: string;
  secret?: string;
  events: string[];
  status: string;
  success_count: number;
  failure_count: number;
  last_triggered_at: string | null;
  created_at: string;
}

export interface UsageData {
  project_id: string;
  period: string;
  storage: {
    used: number;
    limit: number;
    percent: number;
  };
  bandwidth: {
    used: number;
    limit: number;
    percent: number;
  };
  uploads: number;
  downloads: number;
  transforms: number;
  files: {
    total: number;
    images: number;
    videos: number;
    other: number;
  };
}

export interface UsageHistoryEntry {
  date: string;
  uploads: number;
  upload_bytes: number;
  downloads: number;
  download_bytes: number;
  transforms: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page?: number;
  limit?: number;
}
