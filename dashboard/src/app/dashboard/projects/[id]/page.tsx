import { adminFetch } from '@/lib/api';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import type { Project, FileRecord, PaginatedResponse } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Upload, ExternalLink } from 'lucide-react';
import Link from 'next/link';

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let project: Project;
  try {
    project = await adminFetch<Project>(`/api/v1/projects/${id}`);
  } catch {
    return null;
  }

  let recentFiles: FileRecord[] = [];
  try {
    const res = await adminFetch<PaginatedResponse<FileRecord>>(
      `/api/v1/projects/${id}/files?limit=5&sort=created_at&order=desc`,
    );
    recentFiles = res.data;
  } catch {
    // files endpoint may not be available
  }

  let bandwidth = 0;
  try {
    const usage = await adminFetch<{ bandwidth_bytes?: number; download_bytes?: number }>(
      `/api/v1/projects/${id}/usage`,
    );
    bandwidth = usage.bandwidth_bytes || usage.download_bytes || 0;
  } catch {
    // usage endpoint may not be available
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Bandwidth
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatBytes(bandwidth)}</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-2">
        <Button asChild>
          <Link href={`/dashboard/projects/${id}/files`}>
            <Upload className="mr-2 h-4 w-4" />
            Upload Files
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href={`/dashboard/projects/${id}/keys`}>
            Manage API Keys
          </Link>
        </Button>
      </div>

      {recentFiles.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Recent Uploads</h3>
            <Button variant="link" size="sm" asChild className="text-xs">
              <Link href={`/dashboard/projects/${id}/files`}>View all</Link>
            </Button>
          </div>
          <div className="space-y-2">
            {recentFiles.map((file) => (
              <div
                key={file.id}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{file.original_name || file.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(file.size)} &middot; {formatRelativeTime(file.created_at)}
                  </p>
                </div>
                {file.url && (
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-2 text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
