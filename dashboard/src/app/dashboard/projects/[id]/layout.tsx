import { adminFetch } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/utils';
import type { Project } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { notFound } from 'next/navigation';
import ProjectNav from '@/components/layout/ProjectNav';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let project: Project;
  try {
    project = await adminFetch<Project>(`/api/v1/projects/${id}`);
  } catch {
    notFound();
  }

  const tabs = [
    { href: `/dashboard/projects/${id}`, label: 'Overview', exact: true },
    { href: `/dashboard/projects/${id}/files`, label: 'Files', icon: 'Files' },
    { href: `/dashboard/projects/${id}/keys`, label: 'API Keys', icon: 'Key' },
    { href: `/dashboard/projects/${id}/webhooks`, label: 'Webhooks', icon: 'Webhook' },
    { href: `/dashboard/projects/${id}/usage`, label: 'Usage', icon: 'BarChart3' },
    { href: `/dashboard/projects/${id}/settings`, label: 'Settings', icon: 'Settings' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold tracking-tight">{project.name}</h2>
          <Badge variant={project.status === 'active' ? 'default' : 'secondary'}>
            {project.status}
          </Badge>
        </div>
        <p className="font-mono text-sm text-muted-foreground">{project.slug}</p>
        {project.description && (
          <p className="mt-1 text-sm text-muted-foreground">{project.description}</p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Files
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{project.file_count}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Storage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatBytes(project.storage_used)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Created
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDate(project.created_at)}</div>
          </CardContent>
        </Card>
      </div>

      <ProjectNav tabs={tabs} />

      {children}
    </div>
  );
}
