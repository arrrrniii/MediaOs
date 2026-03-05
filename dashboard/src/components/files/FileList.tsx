'use client';

import type { FileRecord } from '@/lib/types';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function FileList({
  files,
  onSelect,
}: {
  files: FileRecord[];
  onSelect: (file: FileRecord) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Size</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Uploaded</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => (
          <TableRow
            key={file.id}
            className="cursor-pointer"
            onClick={() => onSelect(file)}
          >
            <TableCell>
              <div>
                <p className="truncate font-medium">{file.filename}</p>
                {file.folder && (
                  <p className="text-xs text-muted-foreground">{file.folder}/</p>
                )}
              </div>
            </TableCell>
            <TableCell>
              <Badge variant="secondary">{file.type}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatBytes(file.size)}
            </TableCell>
            <TableCell>
              <Badge variant={file.status === 'done' ? 'default' : 'secondary'}>
                {file.status}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatRelativeTime(file.created_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
