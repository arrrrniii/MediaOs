import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';
import { formatBytes, formatDateTime, formatRelativeTime } from '@/lib/utils';
import type { Project, PaginatedResponse } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import CreateProjectModal from '@/components/projects/CreateProjectModal';
import Link from 'next/link';
import { ArrowUpRight, Clock3, Files, FolderKanban, HardDrive } from 'lucide-react';

export default async function ProjectsPage() {
  const ctx = await getAccountContext();

  let projects: Project[] = [];
  if (ctx) {
    try {
      const res = await accountFetch<PaginatedResponse<Project>>(ctx, '/api/v1/projects');
      projects = res.data;
    } catch {
      // API may not be available yet
    }
  }

  const totalFiles = projects.reduce((sum, project) => sum + Number(project.file_count || 0), 0);
  const totalStorage = projects.reduce((sum, project) => sum + Number(project.storage_used || 0), 0);
  const lastUpdated = projects.reduce<string | null>((latest, project) => {
    if (!latest) return project.updated_at;
    return new Date(project.updated_at) > new Date(latest) ? project.updated_at : latest;
  }, null);

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Media library</p>
          <h2 className="text-3xl font-semibold tracking-tight">Projects</h2>
          <p className="mt-1 text-sm text-muted-foreground">Storage, delivery and access boundaries for your media.</p>
        </div>
        <CreateProjectModal />
      </div>

      {projects.length > 0 && (
        <div className="grid overflow-hidden rounded-xl border border-border/70 bg-border/70 sm:grid-cols-3">
          {[
            { label: 'Projects', value: projects.length.toLocaleString(), icon: FolderKanban },
            { label: 'Files', value: totalFiles.toLocaleString(), icon: Files },
            { label: 'Storage', value: formatBytes(totalStorage), icon: HardDrive },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-3 bg-card px-5 py-4">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <item.icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{item.label}</p>
                <p className="text-lg font-semibold tabular-nums">{item.value}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground">No projects yet</p>
            <p className="text-sm text-muted-foreground">
              Create your first project to get started
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/dashboard/projects/${project.id}`}
              className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Card className="group relative h-full overflow-hidden border-border/70 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5">
                <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-blue-500 via-primary to-fuchsia-500 opacity-70 transition-opacity group-hover:opacity-100" />
                <CardContent className="flex h-full flex-col p-5 pl-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-lg font-semibold">{project.name}</p>
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">/{project.slug}</p>
                    </div>
                    <Badge
                      variant={project.status === 'active' ? 'default' : 'secondary'}
                      className="shrink-0 capitalize"
                    >
                      {project.status}
                    </Badge>
                  </div>

                  <p className="mt-4 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
                    {project.description || 'Media storage and delivery project.'}
                  </p>

                  <div className="mt-5 grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-muted/40 px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Files className="h-3.5 w-3.5" /> Files</div>
                      <p className="mt-1 font-semibold tabular-nums">{project.file_count.toLocaleString()}</p>
                    </div>
                    <div className="rounded-lg bg-muted/40 px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><HardDrive className="h-3.5 w-3.5" /> Storage</div>
                      <p className="mt-1 font-semibold tabular-nums">{formatBytes(project.storage_used)}</p>
                    </div>
                  </div>

                  <div className="mt-5 flex items-center justify-between border-t border-border/60 pt-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5" title={formatDateTime(project.updated_at)}>
                      <Clock3 className="h-3.5 w-3.5" /> Updated {formatRelativeTime(project.updated_at)}
                    </span>
                    <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {lastUpdated && (
        <p className="text-right text-xs text-muted-foreground" title={formatDateTime(lastUpdated)}>
          Project data last changed {formatRelativeTime(lastUpdated)}
        </p>
      )}
    </div>
  );
}
