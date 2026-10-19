import { getJson } from '../../lib/api/read-client';
import type { LogSourcesResponse } from './logs-types';

/** Reads the fixed source registry. A request never names a file path. */
export async function fetchLogSources(resourceId?: string): Promise<LogSourcesResponse> {
  const query = resourceId ? `?resourceId=${encodeURIComponent(resourceId)}` : '';
  return getJson<LogSourcesResponse>(`/api/nf-logs/sources${query}`);
}

/**
 * Builds the stream URL from the bounded vocabulary.
 *
 * Every value is optional except the source; filters are literal text, so the
 * URL never carries a pattern.
 */
export function logStreamPath(options: {
  sourceId: string;
  tailLines: number;
  level?: string;
  keyword?: string;
  follow?: boolean;
}): string {
  const params = new URLSearchParams();
  params.set('sourceId', options.sourceId);
  params.set('tailLines', String(options.tailLines));
  if (options.level) params.set('level', options.level);
  if (options.keyword) params.set('keyword', options.keyword);
  if (options.follow === false) params.set('follow', 'false');
  return `/api/nf-logs/stream?${params.toString()}`;
}
