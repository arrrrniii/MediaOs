'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  Activity, HardDriveDownload, Ghost, AlertTriangle, Timer,
  Webhook, ArchiveRestore, DatabaseBackup, ShieldCheck, RefreshCw, Play,
} from 'lucide-react';

interface Metrics {
  healthy_assets: number;
  missing_objects: number;
  orphan_objects: number;
  corrupt_objects: number;
  stuck_jobs: number;
  dead_jobs?: number;
  failed_webhooks: number;
  pending_restores: number;
  pending_archives?: number;
  total_files?: number;
  total_objects?: number;
  last_backup_at: string | null;
  last_restore_test_at: string | null;
}

interface Run {
  id: string;
  kind: string;
  started_at: string;
  finished_at: string | null;
  checked: number;
  issues_found: number;
  repaired: number;
  status: string;
  error_count: number | string;
}

function fmtDate(v: string | null): string {
  if (!v) return 'Never';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'Never' : d.toLocaleString();
}

function Tile({
  icon: Icon, label, value, tone = 'default', hint,
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  hint?: string;
}) {
  const toneClass =
    tone === 'good' ? 'text-emerald-500'
      : tone === 'warn' ? 'text-amber-500'
      : tone === 'bad' ? 'text-destructive'
      : 'text-foreground';
  return (
    <Card>
      <CardContent className="flex items-start gap-3 py-4">
        <div className={`mt-0.5 ${toneClass}`}><Icon className="h-5 w-5" /></div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className={`text-2xl font-bold tabular-nums ${toneClass}`}>{value}</p>
          {hint && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SystemHealthPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [hRes, rRes] = await Promise.all([
        fetch('/api/system/health', { cache: 'no-store' }),
        fetch('/api/system/reconciliation/runs?limit=15', { cache: 'no-store' }),
      ]);
      if (hRes.status === 403) { setForbidden(true); return; }
      const h = await hRes.json();
      const r = await rRes.json();
      if (!hRes.ok) throw new Error(h.error || 'Failed to load system health');
      setMetrics(h.live as Metrics);
      setRuns((r.data || []) as Run[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load system health');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runNow() {
    setRunning(true);
    try {
      const res = await fetch('/api/system/reconciliation/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start reconciliation');
      toast.success(data.enqueued ? 'Reconciliation enqueued' : 'Reconciliation ran');
      // Give the worker a beat, then refresh.
      setTimeout(load, 1500);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start reconciliation');
    } finally {
      setRunning(false);
    }
  }

  if (forbidden) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <ShieldCheck className="h-10 w-10 text-muted-foreground/50" />
          <div>
            <p className="font-medium">Operator access only</p>
            <p className="text-sm text-muted-foreground">
              System health is restricted to the configured admin account (ADMIN_EMAIL).
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">System Health</h2>
          <p className="text-muted-foreground">
            Install-wide integrity: the self-healing reconciler&apos;s live view and recent runs.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh
          </Button>
          <Button size="sm" onClick={runNow} disabled={running}>
            <Play className="mr-1.5 h-3.5 w-3.5" />{running ? 'Starting…' : 'Run now'}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {loading && !metrics ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">Loading…</CardContent></Card>
      ) : metrics ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          <Tile icon={Activity} label="Healthy assets" value={metrics.healthy_assets} tone="good" />
          <Tile icon={HardDriveDownload} label="Missing objects" value={metrics.missing_objects}
            tone={metrics.missing_objects > 0 ? 'bad' : 'good'} />
          <Tile icon={Ghost} label="Orphan objects" value={metrics.orphan_objects}
            tone={metrics.orphan_objects > 0 ? 'warn' : 'good'} hint="from last run" />
          <Tile icon={AlertTriangle} label="Corrupt objects" value={metrics.corrupt_objects}
            tone={metrics.corrupt_objects > 0 ? 'bad' : 'good'} />
          <Tile icon={Timer} label="Stuck jobs" value={metrics.stuck_jobs}
            tone={metrics.stuck_jobs > 0 ? 'warn' : 'good'} />
          <Tile icon={Webhook} label="Failed webhooks" value={metrics.failed_webhooks}
            tone={metrics.failed_webhooks > 0 ? 'warn' : 'good'} />
          <Tile icon={ArchiveRestore} label="Pending restores" value={metrics.pending_restores}
            tone={metrics.pending_restores > 0 ? 'warn' : 'good'} />
          <Tile icon={DatabaseBackup} label="Last backup" value={fmtDate(metrics.last_backup_at)}
            tone={metrics.last_backup_at ? 'default' : 'warn'} />
          <Tile icon={ShieldCheck} label="Last restore test" value={fmtDate(metrics.last_restore_test_at)}
            tone={metrics.last_restore_test_at ? 'default' : 'warn'} />
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent reconciliation runs</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {runs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Kind</th>
                    <th className="py-2 pr-4 font-medium">Started</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 text-right font-medium">Checked</th>
                    <th className="py-2 pr-4 text-right font-medium">Issues</th>
                    <th className="py-2 pr-4 text-right font-medium">Repaired</th>
                    <th className="py-2 text-right font-medium">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-4 font-medium">{run.kind}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{fmtDate(run.started_at)}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={run.status === 'completed' ? 'outline' : run.status === 'failed' ? 'destructive' : 'secondary'}>
                          {run.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{run.checked}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{run.issues_found}</td>
                      <td className="py-2 pr-4 text-right tabular-nums text-emerald-500">{run.repaired}</td>
                      <td className="py-2 text-right tabular-nums">
                        {Number(run.error_count) > 0
                          ? <span className="text-destructive">{run.error_count}</span>
                          : <span className="text-muted-foreground">0</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
