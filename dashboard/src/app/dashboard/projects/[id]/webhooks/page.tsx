'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Plus, Copy, Trash2, Zap } from 'lucide-react';
import type { Webhook } from '@/lib/types';
import { formatRelativeTime } from '@/lib/utils';

const EVENTS = [
  'file.uploaded',
  'file.processed',
  'file.failed',
  'file.deleted',
];

export default function WebhooksPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['file.uploaded', 'file.processed']);
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const fetchWebhooks = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks`);
      if (res.ok) {
        const data = await res.json();
        setWebhooks(data.data || []);
      }
    } catch {
      // handle error
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, events }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.secret) {
          setCreatedSecret(data.secret);
        } else {
          setCreateOpen(false);
          toast.success('Webhook created');
        }
        setUrl('');
        setEvents(['file.uploaded', 'file.processed']);
        fetchWebhooks();
      } else {
        const body = await res.json();
        toast.error(body.error || 'Failed to create webhook');
      }
    } catch {
      toast.error('Failed to create webhook');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(webhookId: string) {
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${webhookId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success('Webhook deleted');
        fetchWebhooks();
      } else {
        toast.error('Failed to delete webhook');
      }
    } catch {
      toast.error('Failed to delete webhook');
    }
  }

  async function handleTest(webhookId: string) {
    setTesting(webhookId);
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${webhookId}/test`, {
        method: 'POST',
      });
      if (res.ok) {
        toast.success('Test event sent');
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Test failed -- endpoint may not be available yet');
      }
    } catch {
      toast.error('Test failed');
    } finally {
      setTesting(null);
    }
  }

  function toggleEvent(event: string) {
    setEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Webhooks</h3>
          <p className="text-sm text-muted-foreground">
            Receive notifications when events occur
          </p>
        </div>
        <Dialog
          open={createOpen}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) setCreatedSecret(null);
          }}
        >
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Webhook
            </Button>
          </DialogTrigger>
          <DialogContent>
            {createdSecret ? (
              <>
                <DialogHeader>
                  <DialogTitle>Webhook Created</DialogTitle>
                  <DialogDescription>
                    Copy this signing secret now. You will not be able to see it again.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 py-4">
                  <div className="flex items-center gap-2 rounded-md border bg-muted p-3">
                    <code className="flex-1 break-all font-mono text-sm">
                      {createdSecret}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        navigator.clipboard.writeText(createdSecret);
                        toast.success('Secret copied');
                      }}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={() => { setCreateOpen(false); setCreatedSecret(null); }}>
                    Done
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <form onSubmit={handleCreate}>
                <DialogHeader>
                  <DialogTitle>Add Webhook</DialogTitle>
                  <DialogDescription>
                    We&apos;ll send POST requests to this URL when events occur.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="webhook-url">URL</Label>
                    <Input
                      id="webhook-url"
                      type="url"
                      placeholder="https://example.com/webhook"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Events</Label>
                    <div className="space-y-2">
                      {EVENTS.map((event) => (
                        <label
                          key={event}
                          className="flex items-center gap-2 rounded-md border p-2 text-sm"
                        >
                          <Checkbox
                            checked={events.includes(event)}
                            onCheckedChange={() => toggleEvent(event)}
                          />
                          <code className="font-mono text-xs">{event}</code>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={creating || !url.trim() || events.length === 0}>
                    {creating ? 'Creating...' : 'Create'}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <div className="py-8 text-center text-muted-foreground">Loading...</div>
      ) : webhooks.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No webhooks configured yet.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Success / Fail</TableHead>
              <TableHead>Last Triggered</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {webhooks.map((wh) => (
              <TableRow key={wh.id}>
                <TableCell>
                  <code className="font-mono text-xs">{wh.url}</code>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {wh.events.map((event) => (
                      <Badge key={event} variant="secondary" className="text-xs">
                        {event}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={wh.status === 'active' ? 'default' : 'secondary'}>
                    {wh.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className="text-sm">
                    <span className="text-green-500">{wh.success_count}</span>
                    {' / '}
                    <span className="text-red-500">{wh.failure_count}</span>
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {wh.last_triggered_at
                    ? formatRelativeTime(wh.last_triggered_at)
                    : 'Never'}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Send test event"
                      disabled={testing === wh.id}
                      onClick={() => handleTest(wh.id)}
                    >
                      <Zap className="h-4 w-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete webhook?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will permanently delete the webhook for{' '}
                            <strong>{wh.url}</strong>. You will stop receiving
                            event notifications at this URL.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDelete(wh.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
