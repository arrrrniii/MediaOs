'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { FileRecord } from '@/lib/types';
import { formatBytes, formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
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
import { Separator } from '@/components/ui/separator';
import { Copy, Trash2, ExternalLink } from 'lucide-react';

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        toast.success(`${label} copied`);
      }}
      className="flex w-full items-center justify-between rounded-md border bg-muted/50 p-2 text-left font-mono text-xs hover:bg-muted"
    >
      <span className="truncate">{text}</span>
      <Copy className="ml-2 h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  );
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
    <Sheet open onOpenChange={onClose}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="truncate">{file.filename}</SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {isImage && file.url && (
            <div className="overflow-hidden rounded-lg border bg-muted/50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={file.urls?.original || file.url}
                alt={file.filename}
                className="w-full object-contain"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-muted-foreground">Type</p>
              <Badge variant="secondary">{file.type}</Badge>
            </div>
            <div>
              <p className="text-muted-foreground">Status</p>
              <Badge variant={file.status === 'done' ? 'default' : 'secondary'}>
                {file.status}
              </Badge>
            </div>
            <div>
              <p className="text-muted-foreground">Size</p>
              <p className="font-medium">{formatBytes(file.size)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Original Size</p>
              <p className="font-medium">{formatBytes(file.original_size)}</p>
            </div>
            {file.width && file.height && (
              <div>
                <p className="text-muted-foreground">Dimensions</p>
                <p className="font-medium">{file.width} x {file.height}</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground">MIME Type</p>
              <p className="font-mono text-xs">{file.mime_type}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Access</p>
              <p className="font-medium">{file.access}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Uploaded</p>
              <p className="font-medium">{formatDate(file.created_at)}</p>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <p className="text-sm font-medium">URLs</p>
            {file.url && <CopyButton text={file.url} label="URL" />}
            {file.urls &&
              Object.entries(file.urls).map(([key, url]) => (
                <CopyButton key={key} text={url} label={`${key} URL`} />
              ))}
          </div>

          <Separator />

          <div className="flex gap-2">
            {file.url && (
              <Button variant="outline" size="sm" asChild className="flex-1">
                <a href={file.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open
                </a>
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  disabled={deleting}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
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
      </SheetContent>
    </Sheet>
  );
}
