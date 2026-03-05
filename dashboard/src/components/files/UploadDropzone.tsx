'use client';

import { useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

const MAX_CONCURRENT = 4;

export default function UploadDropzone({
  projectId,
  onUpload,
}: {
  projectId: string;
  onUpload: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFiles = useCallback(
    async (fileList: FileList) => {
      if (fileList.length === 0) return;
      setUploading(true);

      const files = Array.from(fileList);
      let uploaded = 0;
      let failed = 0;
      const total = files.length;

      const updateProgress = () => {
        setProgress(`Uploaded ${uploaded + failed}/${total}`);
      };

      setProgress(`Uploading ${total} file(s)...`);

      // Process files with bounded concurrency
      const queue = [...files];

      async function processNext(): Promise<void> {
        const file = queue.shift();
        if (!file) return;

        try {
          const formData = new FormData();
          formData.append('file', file);

          const res = await fetch(`/api/projects/${projectId}/upload`, {
            method: 'POST',
            body: formData,
          });

          if (res.ok) {
            uploaded++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
        updateProgress();
        await processNext();
      }

      // Start MAX_CONCURRENT workers
      const workers = Array.from(
        { length: Math.min(MAX_CONCURRENT, files.length) },
        () => processNext(),
      );
      await Promise.all(workers);

      setUploading(false);
      setProgress('');

      if (uploaded > 0) {
        toast.success(`${uploaded} file(s) uploaded`);
        onUpload();
      }
      if (failed > 0) {
        toast.error(`${failed} file(s) failed to upload`);
      }
    },
    [projectId, onUpload],
  );

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      uploadFiles(e.dataTransfer.files);
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors',
        isDragging
          ? 'border-primary bg-primary/5'
          : 'border-muted-foreground/25 hover:border-muted-foreground/50',
      )}
    >
      <Upload className="mb-2 h-6 w-6 text-muted-foreground" />
      {uploading ? (
        <p className="text-sm text-muted-foreground">{progress}</p>
      ) : (
        <>
          <p className="text-sm font-medium">
            Drop files here or click to upload
          </p>
          <p className="text-xs text-muted-foreground">
            Images, videos, and documents
          </p>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) uploadFiles(e.target.files);
        }}
      />
    </div>
  );
}
