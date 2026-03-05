'use client';

import { useState } from 'react';
import { formatBytes } from '@/lib/utils';
import { FileIcon, X, ExternalLink, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import type { FileRecord } from '@/lib/types';

interface RecentFile extends FileRecord {
  project_name: string;
}

export default function RecentUploadsGrid({ files }: { files: RecentFile[] }) {
  const [selected, setSelected] = useState<RecentFile | null>(null);

  return (
    <>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {files.map((file) => {
          const isImage = file.type === 'image';
          const thumbUrl = file.urls?.original || file.url;
          return (
            <button
              key={file.id}
              onClick={() => setSelected(file)}
              className="group overflow-hidden rounded-lg border bg-card text-left transition-all hover:border-primary/30 hover:shadow-md"
            >
              <div className="aspect-square overflow-hidden bg-muted/50">
                {isImage && thumbUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={thumbUrl}
                    alt={file.filename}
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <FileIcon className="h-8 w-8 text-muted-foreground/50" />
                  </div>
                )}
              </div>
              <div className="p-2">
                <p className="truncate text-xs font-medium">{file.filename}</p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {file.project_name} &middot; {formatBytes(file.size)}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <div
            className="relative mx-4 w-full max-w-2xl overflow-hidden rounded-xl border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{selected.filename}</p>
                <p className="text-xs text-muted-foreground">
                  {selected.project_name}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setSelected(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {selected.type === 'image' && (selected.urls?.original || selected.url) && (
              <div className="flex items-center justify-center bg-muted/30 p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={selected.urls?.original || selected.url}
                  alt={selected.filename}
                  className="max-h-[60vh] rounded-md object-contain"
                />
              </div>
            )}

            <div className="space-y-3 p-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{selected.type}</Badge>
                <Badge variant="secondary">{selected.mime_type}</Badge>
                <Badge variant={selected.access === 'public' ? 'default' : 'secondary'}>
                  {selected.access}
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-muted-foreground">Size</p>
                  <p className="font-medium">{formatBytes(selected.size)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Original</p>
                  <p className="font-medium">{formatBytes(selected.original_size)}</p>
                </div>
                {selected.width && selected.height && (
                  <div>
                    <p className="text-muted-foreground">Dimensions</p>
                    <p className="font-medium">{selected.width} x {selected.height}</p>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <p className="font-medium">{selected.status}</p>
                </div>
              </div>

              <div className="flex gap-2">
                {selected.url && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(selected.url);
                      toast.success('URL copied');
                    }}
                  >
                    <Copy className="mr-2 h-3 w-3" />
                    Copy URL
                  </Button>
                )}
                {selected.url && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={selected.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="mr-2 h-3 w-3" />
                      Open
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
