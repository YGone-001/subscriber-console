import type { FileKind } from './types';

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileKindLabel(kind: FileKind): string {
  switch (kind) {
    case 'image':
      return 'IMG';
    case 'pdf':
      return 'PDF';
    case 'text':
      return 'TXT';
    case 'pcap':
      return 'PCAP';
    default:
      return 'FILE';
  }
}

export function isImage(kind: FileKind): boolean {
  return kind === 'image';
}

/** Whether an inline Markdown image target is a safe knowledge attachment. */
export function isKnowledgeImageUrl(src: string): boolean {
  return /^\/api\/knowledge\/files\/[0-9a-fA-F-]{36}$/.test(src);
}
