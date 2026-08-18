import { getAccountContext } from '@/lib/session';
import { accountFetch } from '@/lib/api';
import { formatBytes, formatDate, formatDateTime, formatRelativeTime } from '@/lib/utils';
import type { Project } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { notFound } from 'next/navigation';
import ProjectNav from '@/components/layout/ProjectNav';
import { CalendarDays, Clock3, Files, HardDrive } from 'lucide-react';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await getAccountContext();
  if (!ctx) notFound();

  let project: Project;
  try {
    project = await accountFetch<Project>(ctx, `/api/v1/projects/${id}`);
  } catch {
    notFound();
  }

  const tabs = [
    { href: `/dashboard/projects/${id}`, label: 'Overview', exact: true },
    { href: `/dashboard/projects/${id}/files`, label: 'Files', icon: 'Files' },
    { href: `/dashboard/projects/${id}/keys`, label: 'API Keys', icon: 'Key' },
    { href: `/dashboard/projects/${id}/webhooks`, label: 'Webhooks', icon: 'Webhook' },
    { href: `/dashboard/projects/${id}/jobs`, label: 'Jobs', icon: 'ListChecks' },
    { href: `/dashboard/projects/${id}/usage`, label: 'Usage', icon: 'BarChart3' },
    { href: `/dashboard/projects/${id}/settings`, label: 'Settings', icon: 'Settings' },
  ];

  const metrics = [
    { label: 'Files', value: project.file_count.toLocaleString(), icon: Files },
    { label: 'Storage', value: formatBytes(project.storage_used), icon: HardDrive },
    { label: 'Created', value: formatDate(project.created_at), icon: CalendarDays },
    { label: 'Last updated', value: formatRelativeTime(project.updated_at), icon: Clock3, title: formatDateTime(project.updated_at) },
  ];

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-card">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/80 to-transparent" />
        <div className="flex flex-col gap-5 p-5 sm:p-6 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <h2 className="truncate text-3xl font-semibold tracking-tight">{project.name}</h2>
              <Badge
                variant={project.status === 'active' ? 'default' : 'secondary'}
                className="gap-1.5 capitalize"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
                {project.status}
              </Badge>
            </div>
            <p className="font-mono text-xs text-muted-foreground">/{project.slug}</p>
            {project.description && (
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{project.description}</p>
            )}
          </div>

          <div className="grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/70 bg-border/70 sm:grid-cols-4 xl:min-w-[620px]">
            {metrics.map((metric) => (
              <div key={metric.label} className="bg-background/80 px-4 py-3.5" title={metric.title}>
                <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  <metric.icon className="h-3.5 w-3.5 text-primary" />
                  {metric.label}
                </div>
                <p className="mt-2 truncate text-base font-semibold tabular-nums">{metric.value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <ProjectNav tabs={tabs} />

      {children}
    </div>
  );
}
