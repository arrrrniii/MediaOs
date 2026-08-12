'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { formatRelativeTime } from '@/lib/utils';

interface JobAttempt {
  id: string;
  queue: string;
  job_id: string;
  file_id: string | null;
  status: 'active' | 'completed' | 'failed' | 'stalled' | 'dead';
  attempt: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  filename: string | null;
  type: string | null;
  file_status: string | null;
}

const STATUS_FILTERS = ['failed', 'dead', 'active', 'completed', 'stalled'] as const;

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' {
  if (status === 'completed') return 'default';
  if (status === 'failed' || status === 'dead') return 'destructive';
  return 'secondary';
}

export default function JobsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [jobs, setJobs] = useState<JobAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('failed');
  const [retrying, setRetrying] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filter ? `?status=${filter}` : '';
      const res = await fetch(`/api/projects/${projectId}/jobs${qs}`);
      if (res.ok) {
        const data = await res.json();
        setJobs(data.data || []);
      }
    } catch {
      // handled by empty state
    } finally {
      setLoading(false);
    }
  }, [projectId, filter]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  async function handleRetry(jobId: string) {
    setRetrying(jobId);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
        method: 'POST',
      });
      if (res.ok) {
        toast.success('Job re-enqueued');
        fetchJobs();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Failed to retry job');
      }
    } catch {
      toast.error('Failed to retry job');
    } finally {
      setRetrying(null);
    }
  }

  const canRetry = (s: string) => s === 'failed' || s === 'dead';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Background Jobs</h3>
          <p className="text-sm text-muted-foreground">
            Durable processing jobs. Failed jobs can be retried.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchJobs} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap gap-1">
        {STATUS_FILTERS.map((s) => (
          <Button
            key={s}
            variant={filter === s ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(s)}
          >
            {s}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="py-8 text-center text-muted-foreground">Loading...</div>
      ) : jobs.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No {filter} jobs.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Queue</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Attempt</TableHead>
              <TableHead>Error</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  <span className="text-sm">{job.filename || job.file_id || '--'}</span>
                </TableCell>
                <TableCell>
                  <code className="font-mono text-xs">{job.queue}</code>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                </TableCell>
                <TableCell className="text-sm">{job.attempt}</TableCell>
                <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={job.error || ''}>
                  {job.error || '--'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatRelativeTime(job.finished_at || job.created_at)}
                </TableCell>
                <TableCell>
                  {canRetry(job.status) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Retry job"
                      disabled={retrying === job.job_id}
                      onClick={() => handleRetry(job.job_id)}
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
