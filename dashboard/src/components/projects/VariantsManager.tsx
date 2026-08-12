'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Trash2 } from 'lucide-react';
import type { NamedVariant } from '@/lib/types';

const MODES = ['fit', 'fill', 'auto', 'force'] as const;
const FORMATS = ['auto', 'webp', 'avif', 'jpeg', 'png'] as const;

export default function VariantsManager({ projectId }: { projectId: string }) {
  const [variants, setVariants] = useState<NamedVariant[]>([]);
  const [builtins, setBuiltins] = useState<NamedVariant[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // New-variant form
  const [name, setName] = useState('');
  const [mode, setMode] = useState<NamedVariant['mode']>('fit');
  const [width, setWidth] = useState(400);
  const [height, setHeight] = useState(0);
  const [format, setFormat] = useState<NamedVariant['format']>('auto');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/variants`);
      if (res.ok) {
        const data = await res.json();
        setVariants(data.data || []);
        setBuiltins(data.builtins || []);
      }
    } catch {
      toast.error('Failed to load variants');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mode, width, height, format }),
      });
      if (res.ok) {
        toast.success(`Variant "${name}" saved`);
        setName('');
        load();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to create variant');
      }
    } catch {
      toast.error('Failed to create variant');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(variantName: string) {
    try {
      const res = await fetch(`/api/projects/${projectId}/variants/${encodeURIComponent(variantName)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success(`Variant "${variantName}" deleted`);
        load();
      } else {
        toast.error('Failed to delete variant');
      }
    } catch {
      toast.error('Failed to delete variant');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Named Variants</CardTitle>
        <CardDescription>
          Reusable transform presets, served at <code className="font-mono text-xs">/img/v/&lt;name&gt;/f/&lt;key&gt;</code>.
          Built-ins (thumbnail, card, hero) work even when not listed here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            {/* Existing variants */}
            <div className="space-y-2">
              {variants.length === 0 && (
                <p className="text-sm text-muted-foreground">No custom variants yet.</p>
              )}
              {variants.map((v) => (
                <div key={v.name} className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
                  <span className="font-mono text-sm font-medium">{v.name}</span>
                  <Badge variant="secondary">{v.mode}</Badge>
                  <span className="text-xs text-muted-foreground">{v.width}×{v.height}</span>
                  <Badge variant="outline">{v.format}</Badge>
                  <button
                    onClick={() => handleDelete(v.name)}
                    className="ml-auto text-muted-foreground transition-colors hover:text-destructive"
                    aria-label={`Delete ${v.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            {/* Built-in reference */}
            <div className="flex flex-wrap gap-2">
              {builtins.map((b) => (
                <Badge key={b.name} variant="outline" className="font-mono text-[11px]">
                  {b.name} · {b.width}×{b.height}
                </Badge>
              ))}
            </div>

            {/* Create form */}
            <div className="grid grid-cols-2 gap-3 border-t border-border/50 pt-4 sm:grid-cols-5">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="banner" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Mode</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as NamedVariant['mode'])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MODES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Width</Label>
                <Input type="number" min={0} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Height</Label>
                <Input type="number" min={0} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Format</Label>
                <Select value={format} onValueChange={(v) => setFormat(v as NamedVariant['format'])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FORMATS.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={handleCreate} disabled={saving || !name.trim()} size="sm">
              {saving ? 'Saving...' : 'Add Variant'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
