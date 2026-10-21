import { getJson } from '../../lib/api/read-client';
import { deleteJson, postForm, postJson, putJson } from '../../lib/api/mutation-client';
import type {
  KnowledgeEntry,
  KnowledgeEntryInput,
  KnowledgeEntryUpdate,
  KnowledgeListResponse,
  KnowledgeMeta,
  KnowledgeUploadResponse,
} from './types';

export type EntryQuery = {
  q?: string;
  protocol?: string;
  tag?: string;
  cursor?: string;
  limit?: number;
};

export function buildEntriesPath(query: EntryQuery = {}): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.protocol) params.set('protocol', query.protocol);
  if (query.tag) params.set('tag', query.tag);
  if (query.cursor) params.set('cursor', query.cursor);
  if (typeof query.limit === 'number') params.set('limit', String(query.limit));
  const suffix = params.toString();
  return suffix ? `/api/knowledge/entries?${suffix}` : '/api/knowledge/entries';
}

export function fetchKnowledgeMeta(): Promise<KnowledgeMeta> {
  return getJson<KnowledgeMeta>('/api/knowledge/meta');
}

export function fetchEntries(query: EntryQuery = {}): Promise<KnowledgeListResponse> {
  return getJson<KnowledgeListResponse>(buildEntriesPath(query));
}

export function fetchEntry(id: string): Promise<KnowledgeEntry> {
  return getJson<KnowledgeEntry>(`/api/knowledge/entries/${id}`);
}

export function createEntry(input: KnowledgeEntryInput): Promise<KnowledgeEntry> {
  return postJson<KnowledgeEntry>('/api/knowledge/entries', input);
}

export function updateEntry(id: string, input: KnowledgeEntryUpdate): Promise<KnowledgeEntry> {
  return putJson<KnowledgeEntry>(`/api/knowledge/entries/${id}`, input);
}

export function deleteEntry(id: string, revision: number): Promise<{ deleted: boolean; id: string }> {
  return deleteJson<{ deleted: boolean; id: string }>(`/api/knowledge/entries/${id}?revision=${revision}`);
}

export function uploadKnowledgeFile(file: File): Promise<KnowledgeUploadResponse> {
  const formData = new FormData();
  formData.append('file', file);
  return postForm<KnowledgeUploadResponse>('/api/knowledge/files', formData);
}

export function attachmentUrl(fileId: string): string {
  return `/api/knowledge/files/${fileId}`;
}
