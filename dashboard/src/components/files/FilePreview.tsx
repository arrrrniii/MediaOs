'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { FileRecord } from '@/lib/types';
import { formatBytes, formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogTitle,
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
import { Copy, Trash2, ExternalLink, X, ImageIcon, FileVideo, FileAudio, FileText, Download } from 'lucide-react';

function CopyRow({ text, label }: { text: string; label: string }) {
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        toast.success(`${label} copied`);
      }}
      className="group flex w-full items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-left font-mono text-[11px] transition-colors hover:bg-muted/60"
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{text}</span>
      <Copy className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
    </button>
  );
}

function FileTypeIcon({ type }: { type: string }) {
  const cls = 'h-10 w-10 text-muted-foreground/40';
  switch (type) {
    case 'image': return <ImageIcon className={cls} />;
    case 'video': return <FileVideo className={cls} />;
    case 'audio': return <FileAudio className={cls} />;
    default: return <FileText className={cls} />;
  }
}

export default function FilePreview({
  file,
  onClose,
  onDelete,
}: {
  file: FileRecord;
  onClose: () => void;
  onDelete: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/projects/${file.project_id}/files/${file.id}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        toast.success('File deleted');
        onDelete();
      } else {
        toast.error('Failed to delete file');
      }
    } catch {
      toast.error('Failed to delete file');
    } finally {
      setDeleting(false);
    }
  }

  const isImage = file.type === 'image';

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent showCloseButton={false} className="flex max-h-[85vh] w-[95vw] max-w-[1200px] flex-col gap-0 overflow-hidden rounded-xl border border-border/50 bg-card p-0 shadow-2xl sm:max-w-[1200px] sm:rounded-xl">
        <DialogTitle className="sr-only">{file.filename}</DialogTitle>

        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{file.filename}</h2>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{file.original_name || file.storage_key}</p>
          </div>
          <button
            onClick={onClose}
            className="ml-4 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body — 2 columns */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row">
          {/* Left: Preview */}
          <div className="flex items-center justify-center border-b border-border/50 bg-muted/20 p-6 md:w-1/2 md:border-b-0 md:border-r">
            {isImage && file.url ? (
              <div className="overflow-hidden rounded-lg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={file.urls?.original || file.url}
                  alt={file.filename}
                  className="max-h-[50vh] w-auto rounded-lg object-contain"
                />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-center">
                <FileTypeIcon type={file.type} />
                <p className="text-xs text-muted-foreground">No preview available</p>
              </div>
            )}
          </div>

          {/* Right: Details */}
          <div className="flex flex-col gap-5 overflow-y-auto p-5 md:w-1/2">
            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Type</p>
                <Badge variant="secondary" className="mt-1">{file.type}</Badge>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Status</p>
                <Badge variant={file.status === 'done' ? 'default' : 'secondary'} className="mt-1">
                  {file.status}
                </Badge>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Size</p>
                <p className="mt-1 text-sm font-medium">{formatBytes(file.size)}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Original</p>
                <p className="mt-1 text-sm font-medium">{formatBytes(file.original_size)}</p>
              </div>
              {file.width && file.height && (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Dimensions</p>
                  <p className="mt-1 text-sm font-medium">{file.width} x {file.height}</p>
                </div>
              )}
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">MIME</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{file.mime_type}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Access</p>
                <p className="mt-1 text-sm font-medium">{file.access}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Uploaded</p>
                <p className="mt-1 text-sm font-medium">{formatDate(file.created_at)}</p>
              </div>
            </div>

            {/* URLs */}
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">URLs</p>
              {file.url && <CopyRow text={file.url} label="URL" />}
              {file.urls &&
                Object.entries(file.urls).map(([key, url]) => (
                  <CopyRow key={key} text={url} label={`${key} URL`} />
                ))}
            </div>

            {/* Actions */}
            <div className="mt-auto flex gap-2 border-t border-border/50 pt-4">
              {file.url && (
                <Button variant="outline" size="sm" asChild className="flex-1">
                  <a href={file.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-3.5 w-3.5" />
                    Open
                  </a>
                </Button>
              )}
              <Button variant="outline" size="sm" asChild className="flex-1">
                <a href={`/api/projects/${file.project_id}/files/${file.id}/download`} download>
                  <Download className="mr-2 h-3.5 w-3.5" />
                  Download
                </a>
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    disabled={deleting}
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    {deleting ? 'Deleting...' : 'Delete'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete file?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete <strong>{file.filename}</strong>.
                      This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
