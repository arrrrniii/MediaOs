import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { adminFetch } from '@/lib/api';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import type { Project, FileRecord, PaginatedResponse } from '@/lib/types';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FolderKanban, Files, HardDrive, Wifi, Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import RecentUploadsGrid from '@/components/files/RecentUploadsGrid';

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const accountId = (session?.user as { id?: string })?.id;

  let projects: Project[] = [];
  try {
    const res = await adminFetch<PaginatedResponse<Project>>(
      `/api/v1/projects?account_id=${accountId}&status=active`,
    );
    projects = res.data;
  } catch {
    // API may not be available yet
  }

  const totalFiles = projects.reduce((sum, p) => sum + p.file_count, 0);
  const totalStorage = projects.reduce((sum, p) => sum + p.storage_used, 0);

  // Fetch bandwidth across all projects
  let totalBandwidth = 0;
  for (const project of projects) {
    try {
      const usage = await adminFetch<{ bandwidth_bytes?: number; download_bytes?: number }>(
        `/api/v1/projects/${project.id}/usage`,
      );
      totalBandwidth += usage.bandwidth_bytes || usage.download_bytes || 0;
    } catch {
      // skip
    }
  }

  // Fetch recent uploads from the first few projects
  let recentUploads: (FileRecord & { project_name: string })[] = [];
  for (const project of projects.slice(0, 5)) {
    try {
      const res = await adminFetch<PaginatedResponse<FileRecord>>(
        `/api/v1/projects/${project.id}/files?limit=12&sort=created_at&order=desc`,
      );
      for (const file of res.data) {
        recentUploads.push({ ...file, project_id: project.id, project_name: project.name });
      }
    } catch {
      // skip
    }
  }
  recentUploads.sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  ).splice(12);

  const stats = [
    {
      label: 'Projects',
      value: projects.length.toString(),
      icon: FolderKanban,
      color: 'text-indigo-500',
      bg: 'bg-indigo-500/10',
    },
    {
      label: 'Total Files',
      value: totalFiles.toLocaleString(),
      icon: Files,
      color: 'text-emerald-500',
      bg: 'bg-emerald-500/10',
    },
    {
      label: 'Storage Used',
      value: formatBytes(totalStorage),
      icon: HardDrive,
      color: 'text-amber-500',
      bg: 'bg-amber-500/10',
    },
    {
      label: 'Bandwidth',
      value: formatBytes(totalBandwidth),
      icon: Wifi,
      color: 'text-cyan-500',
      bg: 'bg-cyan-500/10',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Overview</h2>
          <p className="text-muted-foreground">
            Welcome back, {session?.user?.name}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild>
            <Link href="/dashboard/projects">
              <Plus className="mr-2 h-4 w-4" />
              New Project
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.label}
              </CardTitle>
              <div className={`rounded-md p-1.5 ${stat.bg}`}>
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {recentUploads.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold">Recent Uploads</h3>
          <RecentUploadsGrid files={recentUploads} />
        </div>
      )}

      {projects.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold">Quick Actions</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {projects.slice(0, 3).map((project) => (
              <Link
                key={project.id}
                href={`/dashboard/projects/${project.id}/files`}
                className="flex items-center gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50"
              >
                <Upload className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    Upload to {project.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {project.file_count} files &middot; {formatBytes(project.storage_used)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {projects.length > 0 && (
        <div>
          <h3 className="mb-4 text-lg font-semibold">Your Projects</h3>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/dashboard/projects/${project.id}`}
              >
                <Card className="transition-colors hover:bg-accent/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{project.name}</CardTitle>
                    <p className="font-mono text-xs text-muted-foreground">
                      {project.slug}
                    </p>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-4 text-sm text-muted-foreground">
                      <span>{project.file_count} files</span>
                      <span>{formatBytes(project.storage_used)}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
