/*
 * Log workspace types.
 *
 * The server declares its own vocabulary in /sources (levels, tail ceiling,
 * line ceiling); the page renders that vocabulary instead of hard-coding a
 * second copy of it.
 */

export type LogSource = {
  sourceId: string;
  name: string;
  kind: 'file' | 'unit';
  sizeBytes: number;
  updatedAt?: string;
  readable: boolean;
  note?: string;
  resourceIds?: string[];
};

export type LogCapabilities = {
  defaultTailLines: number;
  maxTailLines: number;
  levels: string[];
  maxLineBytes: number;
  follow: boolean;
  keywordIsLiteral: boolean;
  concurrencyPerSession: number;
};

export type LogSourcesResponse = {
  generatedAt: string;
  sources: LogSource[];
  capabilities: LogCapabilities;
};

export type LogLine = {
  /* Client-side render identity. The server's `seq` restarts at 1 on every
   * new stream (a reconnect is a new tail), so it cannot identify a row across
   * reconnects; this counter can. Optional only for values built by tests. */
  id?: number;
  seq: number;
  level: string;
  text: string;
};

export type LogStreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'unavailable';

/* Why the workspace will not open a stream. The page renders the localized
 * label; the hook never builds user-facing prose. */
export type LogStreamUnavailable = 'unreadable' | 'unknown_source';

export const DEFAULT_TAIL_LINES = 100;
export const DEFAULT_LEVEL = '';

/* The UI keeps a bounded window; older lines are dropped from the view, not
 * from the server's history. */
export const MAX_VIEW_LINES = 2000;
