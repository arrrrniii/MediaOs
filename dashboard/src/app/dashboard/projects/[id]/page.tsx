import { adminFetch } from '@/lib/api';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import type { Project, FileRecord, PaginatedResponse } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Upload, ExternalLink, FileIcon } from 'lucide-react';
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {recentFiles.map((file) => {
              const isImage = file.type === 'image';
              const thumbUrl = file.urls?.fit_400 || file.urls?.original || file.url;
              return (
                <a
                  key={file.id}
                  href={file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group overflow-hidden rounded-lg border border-border/50 bg-card transition-all hover:border-primary/30 hover:shadow-md"
                >
                  <div className="aspect-[4/3] overflow-hidden bg-muted/30">
                    {isImage && thumbUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={thumbUrl}
                        alt={file.filename}
                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <FileIcon className="h-8 w-8 text-muted-foreground/40" />
                      </div>
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="truncate text-xs font-medium">{file.original_name || file.filename}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {formatBytes(file.size)} &middot; {formatRelativeTime(file.created_at)}
                    </p>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
