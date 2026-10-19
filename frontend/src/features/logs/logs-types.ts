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
  seq: number;
  level: string;
  text: string;
};

export type LogStreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'unavailable';

export const DEFAULT_TAIL_LINES = 100;
export const DEFAULT_LEVEL = '';

/* The UI keeps a bounded window; older lines are dropped from the view, not
 * from the server's history. */
export const MAX_VIEW_LINES = 2000;
