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
import { RefreshCw, MoreHorizontal, Bell } from 'lucide-react';
import { formatBytes, formatRelativeTime } from '@/lib/utils';

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

  const fetchInbox = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/lifecycle/inbox');
      if (res.ok) {
        const data = await res.json();
        setRows(data.data || []);
        setTotal(data.total || 0);
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Lifecycle</h2>
          <p className="text-muted-foreground">
            Inactive files flagged for review. Archive cold data, protect what matters, or clean up.
          </p>
        </div>
        <div className="flex items-center gap-2">
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

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">Loading...</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center text-muted-foreground">
          <p className="font-medium">Nothing to review</p>
          <p className="text-sm">The scanner has not flagged any cold or deletion candidates.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Copies</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Last access</TableHead>
                <TableHead className="text-right">Accesses</TableHead>
                <TableHead className="text-right">Est. savings</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.file.id}>
                  <TableCell className="max-w-[200px] truncate font-medium" title={row.file.name}>
                    {row.file.name}
                    {row.protected && (
                      <Badge variant="outline" className="ml-2">protected</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.project.name}</TableCell>
                  <TableCell>
                    <Badge variant={stateVariant(row.lifecycle_state)}>
                      {row.lifecycle_state.replace(/_/g, ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{formatBytes(row.size)}</TableCell>
                  <TableCell className="text-right">{row.physical_copies}</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{row.current_tier}</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.last_access ? formatRelativeTime(row.last_access) : 'never'}
                  </TableCell>
                  <TableCell className="text-right">{row.access_count}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatBytes(row.estimated_savings)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" disabled={busy === row.file.id}>
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
