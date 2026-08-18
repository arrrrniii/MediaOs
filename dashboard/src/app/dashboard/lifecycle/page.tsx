'use client';

import { useState, useEffect, useCallback } from 'react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArchiveRestore, Bell, Clock3, Copy, MoreHorizontal, RefreshCw, Sparkles,
} from 'lucide-react';
import { formatBytes, formatDateTime, formatRelativeTime } from '@/lib/utils';

interface InboxRow {
  file: { id: string; name: string };
  project: { id: string; name: string };
  lifecycle_state: string;
  size: number;
  physical_copies: number;
  last_access: string | null;
  access_count: number;
  current_tier: string;
  estimated_savings: number;
  retention_until: string | null;
  protected: boolean;
  suggested_action: string;
  updated_at: string | null;
}

// action id → label + whether it is destructive/admin.
const ACTIONS: { id: string; label: string; admin?: boolean }[] = [
  { id: 'keep', label: 'Keep active' },
  { id: 'protect', label: 'Protect permanently', admin: true },
  { id: 'archive_source', label: 'Archive source only' },
  { id: 'archive_all', label: 'Archive everything' },
  { id: 'mark_delete', label: 'Mark for deletion', admin: true },
  { id: 'delete_after_grace', label: 'Delete after grace period', admin: true },
  { id: 'restore', label: 'Restore' },
];

function stateVariant(state: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (state === 'delete_candidate') return 'destructive';
  if (state === 'cold_candidate') return 'secondary';
  return 'outline';
}

export default function LifecyclePage() {
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchInbox = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/lifecycle/inbox');
      if (res.ok) {
        const data = await res.json();
        setRows(data.data || []);
        setTotal(data.total || 0);
        setLastRefresh(new Date());
      }
    } catch {
      // handled by empty state
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/lifecycle/notifications?status=unread');
      if (res.ok) {
        const data = await res.json();
        setUnread(data.unread_count || 0);
      }
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    fetchInbox();
    fetchNotifications();
  }, [fetchInbox, fetchNotifications]);

  async function applyAction(row: InboxRow, action: string) {
    setBusy(row.file.id);
    try {
      const res = await fetch('/api/lifecycle/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: row.project.id,
          fileId: row.file.id,
          action,
        }),
      });
      if (res.ok) {
        toast.success(`Applied: ${action.replace(/_/g, ' ')}`);
        fetchInbox();
        fetchNotifications();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Action failed');
      }
    } catch {
      toast.error('Action failed');
    } finally {
      setBusy(null);
    }
  }

  const reclaimableBytes = rows.reduce((sum, row) => sum + row.estimated_savings, 0);
  const extraCopies = rows.reduce((sum, row) => sum + Math.max(0, row.physical_copies - 1), 0);

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Storage hygiene</p>
          <h2 className="text-3xl font-semibold tracking-tight">Lifecycle review</h2>
          <p className="mt-1 text-sm text-muted-foreground">Decide what stays hot, what moves to archive, and what can be removed.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {lastRefresh && (
            <span className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground" title={formatDateTime(lastRefresh.toISOString())}>
              <Clock3 className="h-3.5 w-3.5" /> Refreshed {formatRelativeTime(lastRefresh.toISOString())}
            </span>
          )}
          <Badge variant={unread > 0 ? 'default' : 'secondary'} className="gap-1">
            <Bell className="h-3.5 w-3.5" />
            {unread} to review
          </Badge>
          <Button variant="outline" size="sm" onClick={fetchInbox} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid overflow-hidden rounded-xl border border-border/70 bg-border/70 sm:grid-cols-3">
        {[
          { label: 'Files to review', value: total.toLocaleString(), icon: Bell, note: `${unread} unread notices` },
          { label: 'Potential savings', value: formatBytes(reclaimableBytes), icon: Sparkles, note: `Across ${rows.length} loaded files` },
          { label: 'Extra copies', value: extraCopies.toLocaleString(), icon: Copy, note: 'Loaded copies beyond one primary' },
        ].map((item) => (
          <div key={item.label} className="flex items-center gap-4 bg-card px-5 py-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <item.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">{item.value}</p>
              <p className="truncate text-[11px] text-muted-foreground/70">{item.note}</p>
            </div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">Loading lifecycle review…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center text-muted-foreground">
          <ArchiveRestore className="mx-auto mb-3 h-6 w-6 text-primary" />
          <p className="font-medium text-foreground">Nothing to review</p>
          <p className="mt-1 text-sm">The scanner has not flagged any cold or deletion candidates.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/25 hover:bg-muted/25">
                <TableHead>Asset</TableHead>
                <TableHead>Lifecycle state</TableHead>
                <TableHead>Footprint</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Potential savings</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.file.id} className="group">
                  <TableCell className="max-w-[280px]">
                    <p className="truncate font-medium" title={row.file.name}>{row.file.name}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{row.project.name}</p>
                    {row.protected && (
                      <Badge variant="outline" className="mt-2">protected</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={stateVariant(row.lifecycle_state)}>
                      {row.lifecycle_state.replace(/_/g, ' ')}
                    </Badge>
                    <p className="mt-1.5 text-xs text-muted-foreground" title={row.updated_at ? formatDateTime(row.updated_at) : undefined}>
                      Updated {row.updated_at ? formatRelativeTime(row.updated_at) : 'unknown'}
                    </p>
                  </TableCell>
                  <TableCell>
                    <p className="font-medium tabular-nums">{formatBytes(row.size)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{row.physical_copies} physical {row.physical_copies === 1 ? 'copy' : 'copies'}</p>
                  </TableCell>
                  <TableCell>
                    <p className="text-sm">{row.last_access ? formatRelativeTime(row.last_access) : 'Never accessed'}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{row.access_count.toLocaleString()} total accesses</p>
                  </TableCell>
                  <TableCell>
                    <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">{row.current_tier}</code>
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatBytes(row.estimated_savings)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" disabled={busy === row.file.id} aria-label={`Actions for ${row.file.name}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuLabel>
                          Suggested: {row.suggested_action.replace(/_/g, ' ')}
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {ACTIONS.map((a) => (
                          <DropdownMenuItem
                            key={a.id}
                            className={a.admin ? 'text-destructive' : ''}
                            onClick={() => applyAction(row, a.id)}
                          >
                            {a.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {total > rows.length && (
        <p className="text-center text-sm text-muted-foreground">
          Showing {rows.length} of {total} flagged files.
        </p>
      )}
    </div>
  );
}
