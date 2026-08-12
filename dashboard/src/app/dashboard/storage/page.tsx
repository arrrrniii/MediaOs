'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { HardDrive, Snowflake, Plug, Trash2, Plus } from 'lucide-react';

interface Backend {
  id: string;
  type: string;
  name: string;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  force_path_style: boolean | null;
  status: string;
  is_cold_default: boolean;
  last_verified_at: string | null;
  created_at: string;
}

const TYPES = [
  { value: 's3', label: 'AWS S3' },
  { value: 'r2', label: 'Cloudflare R2' },
  { value: 'b2', label: 'Backblaze B2' },
  { value: 'minio', label: 'MinIO (remote)' },
];

const emptyForm = {
  type: 's3',
  name: '',
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  forcePathStyle: false,
  is_cold_default: true,
};

export default function StorageBackendsPage() {
  const [backends, setBackends] = useState<Backend[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/storage/backends', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load backends');
      setBackends(data.data || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load backends');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/storage/backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create backend');
      toast.success('Storage backend added');
      setDialogOpen(false);
      setForm({ ...emptyForm });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create backend');
    } finally {
      setSaving(false);
    }
  }

  async function handleVerify(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/storage/backends/${id}/verify`, { method: 'POST' });
      const data = await res.json();
      if (data.verified) toast.success('Connection verified');
      else toast.error(`Verification failed: ${data.error || 'unknown error'}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleSetCold(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/storage/backends/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_cold_default: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update');
      toast.success('Cold backend updated');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this storage backend? This cannot be undone.')) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/storage/backends/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete');
      toast.success('Backend deleted');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setBusyId(null);
    }
  }

  const needsEndpoint = form.type !== 's3';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Storage Backends</h2>
          <p className="text-muted-foreground">
            Cold-storage targets for archived assets. Credentials are encrypted at rest and never shown again after saving.
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" />Add backend</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle>Add storage backend</DialogTitle>
                <DialogDescription>
                  Connect an S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, or a remote MinIO)
                  to archive cold assets to. The secret key is write-only.
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label>Provider</Label>
                  <Select
                    value={form.type}
                    onValueChange={(v) => setForm((f) => ({
                      ...f, type: v, forcePathStyle: v === 'minio' || v === 'b2' || v === 'r2',
                    }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="be-name">Name</Label>
                  <Input id="be-name" value={form.name} required placeholder="Glacier archive"
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="be-bucket">Bucket</Label>
                    <Input id="be-bucket" value={form.bucket} required placeholder="my-cold-bucket"
                      onChange={(e) => setForm((f) => ({ ...f, bucket: e.target.value }))} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="be-region">Region</Label>
                    <Input id="be-region" value={form.region} placeholder="us-east-1 / auto"
                      onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))} />
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="be-endpoint">Endpoint {needsEndpoint ? '' : '(optional for AWS S3)'}</Label>
                  <Input id="be-endpoint" value={form.endpoint} required={needsEndpoint}
                    placeholder="https://<account>.r2.cloudflarestorage.com"
                    onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))} />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="be-akid">Access key ID</Label>
                    <Input id="be-akid" value={form.accessKeyId} required autoComplete="off"
                      onChange={(e) => setForm((f) => ({ ...f, accessKeyId: e.target.value }))} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="be-secret">Secret access key</Label>
                    <Input id="be-secret" type="password" value={form.secretAccessKey} required autoComplete="off"
                      placeholder="write-only"
                      onChange={(e) => setForm((f) => ({ ...f, secretAccessKey: e.target.value }))} />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Checkbox id="be-path" checked={form.forcePathStyle}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, forcePathStyle: v === true }))} />
                  <Label htmlFor="be-path" className="font-normal">Force path-style addressing (MinIO / B2 / R2)</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox id="be-cold" checked={form.is_cold_default}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, is_cold_default: v === true }))} />
                  <Label htmlFor="be-cold" className="font-normal">Use as the cold backend for new archives</Label>
                </div>
              </div>

              <DialogFooter>
                <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Add backend'}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {loading ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">Loading…</CardContent></Card>
      ) : backends.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <HardDrive className="h-10 w-10 text-muted-foreground/50" />
            <div>
              <p className="font-medium">No storage backends yet</p>
              <p className="text-sm text-muted-foreground">
                Add an S3-compatible bucket to archive cold assets off your primary storage.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {backends.map((b) => (
            <Card key={b.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {b.name}
                      <Badge variant="outline" className="uppercase">{b.type}</Badge>
                      {b.is_cold_default && (
                        <Badge className="gap-1"><Snowflake className="h-3 w-3" />Cold default</Badge>
                      )}
                      {b.status !== 'active' && <Badge variant="secondary">{b.status}</Badge>}
                    </CardTitle>
                    <CardDescription className="truncate">
                      {b.bucket}{b.endpoint ? ` · ${b.endpoint}` : ''}{b.region ? ` · ${b.region}` : ''}
                    </CardDescription>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="outline" size="sm" disabled={busyId === b.id} onClick={() => handleVerify(b.id)}>
                      <Plug className="mr-1.5 h-3.5 w-3.5" />Verify
                    </Button>
                    {!b.is_cold_default && (
                      <Button variant="outline" size="sm" disabled={busyId === b.id} onClick={() => handleSetCold(b.id)}>
                        <Snowflake className="mr-1.5 h-3.5 w-3.5" />Set cold
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" disabled={busyId === b.id} onClick={() => handleDelete(b.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0 text-xs text-muted-foreground">
                {b.last_verified_at
                  ? `Last verified ${new Date(b.last_verified_at).toLocaleString()}`
                  : 'Not yet verified'}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
