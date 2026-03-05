import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { adminFetch } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/utils';
import type { Project, PaginatedResponse } from '@/lib/types';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import CreateProjectModal from '@/components/projects/CreateProjectModal';
import Link from 'next/link';

export default async function ProjectsPage() {
  const session = await getServerSession(authOptions);
  const accountId = (session?.user as { id?: string })?.id || '';

  let projects: Project[] = [];
  try {
    const res = await adminFetch<PaginatedResponse<Project>>(
      `/api/v1/projects?account_id=${accountId}`,
    );
    projects = res.data;
  } catch {
    // API may not be available yet
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Projects</h2>
          <p className="text-muted-foreground">
            Manage your media projects
          </p>
        </div>
        <CreateProjectModal accountId={accountId} />
      </div>

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
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/dashboard/projects/${project.id}`}
            >
              <Card className="overflow-hidden transition-all hover:border-primary/30 hover:shadow-md">
                <div className="h-1 bg-gradient-to-r from-indigo-500 to-purple-500" />
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{project.name}</CardTitle>
                    <Badge
                      variant={
                        project.status === 'active' ? 'default' : 'secondary'
                      }
                    >
                      {project.status}
                    </Badge>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">
                    {project.slug}
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>{project.file_count} files</span>
                    <span>{formatBytes(project.storage_used)}</span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Created {formatDate(project.created_at)}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
