/*
 * Log stream client.
 *
 * The browser holds one SSE connection per selected source. Frames are batched
 * before they reach React (a chatty source must not trigger a render per line),
 * the view is a bounded ring, and a stalled connection is reported instead of
 * silently freezing the screen.
 *
 * Pause is a view concern: the server keeps streaming, the client discards what
 * arrives and counts it, so resuming never rewrites history.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { logStreamPath } from './logs-api';
import {
  MAX_VIEW_LINES,
  type LogLine,
  type LogStreamStatus,
} from './logs-types';

export type LogStreamOptions = {
  sourceId: string;
  tailLines: number;
  level: string;
  keyword: string;
  follow: boolean;
  paused: boolean;
};

export type LogStreamResult = {
  lines: LogLine[];
  status: LogStreamStatus;
  dropped: number;
  discarded: number;
  notices: string[];
  error: string | null;
  clear: () => void;
  reconnect: () => void;
};

const FLUSH_INTERVAL_MS = 120;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;

type Frame = {
  seq: number;
  level: string;
  text: string;
};

export function trimLogLines(lines: LogLine[], limit = MAX_VIEW_LINES): LogLine[] {
  return lines.length > limit ? lines.slice(lines.length - limit) : lines;
}

export function useLogStream(options: LogStreamOptions): LogStreamResult {
  const { sourceId, tailLines, level, keyword, follow, paused } = options;

  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<LogStreamStatus>('idle');
  const [dropped, setDropped] = useState(0);
  const [discarded, setDiscarded] = useState(0);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const pausedRef = useRef(paused);
  const pendingRef = useRef<LogLine[]>([]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const clear = useCallback(() => {
    pendingRef.current = [];
    setLines([]);
    setDropped(0);
    setDiscarded(0);
    setNotices([]);
  }, []);

  const reconnect = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!sourceId) {
      setStatus('idle');
      return undefined;
    }
    if (typeof EventSource === 'undefined') {
      setStatus('unavailable');
      setError('this browser cannot open a log stream');
      return undefined;
    }

    let disposed = false;
    let stream: EventSource | null = null;
    let flushTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let attempts = 0;

    const flush = () => {
      flushTimer = undefined;
      if (pendingRef.current.length === 0) return;
      const batch = pendingRef.current;
      pendingRef.current = [];
      setLines((current) => trimLogLines([...current, ...batch]));
    };

    const scheduleFlush = () => {
      if (flushTimer !== undefined) return;
      flushTimer = window.setTimeout(flush, FLUSH_INTERVAL_MS);
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
      attempts += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        if (!disposed) open();
      }, delay);
    };

    const open = () => {
      setStatus((current) => (current === 'live' ? 'reconnecting' : 'connecting'));
      stream = new EventSource(logStreamPath({ sourceId, tailLines, level, keyword, follow }));

      stream.addEventListener('open', () => {
        if (disposed) return;
        attempts = 0;
        setStatus('live');
        setError(null);
      });

      stream.addEventListener('line', (event) => {
        if (disposed) return;
        const payload = parseFrame<Frame>(event);
        if (!payload || typeof payload.text !== 'string') return;
        const line: LogLine = {
          seq: typeof payload.seq === 'number' ? payload.seq : 0,
          level: typeof payload.level === 'string' ? payload.level : 'info',
          text: payload.text,
        };
        if (pausedRef.current) {
          setDiscarded((count) => count + 1);
          return;
        }
        pendingRef.current.push(line);
        scheduleFlush();
      });

      stream.addEventListener('dropped', (event) => {
        if (disposed) return;
        const frame = parseFrame<{ count?: number }>(event);
        const count = frame && typeof frame.count === 'number' ? frame.count : 0;
        if (count > 0) setDropped((current) => current + count);
      });

      stream.addEventListener('notice', (event) => {
        if (disposed) return;
        const frame = parseFrame<{ reason?: string; detail?: string }>(event);
        if (!frame?.reason) return;
        const text = frame.detail ? `${frame.reason}: ${frame.detail}` : frame.reason;
        setNotices((current) => [...current.slice(-4), text]);
      });

      stream.onerror = () => {
        if (disposed) return;
        // EventSource retries by itself; a closed connection needs a new one,
        // and either way the operator must see that the view is not live.
        setStatus('reconnecting');
        if (stream && stream.readyState === EventSource.CLOSED) {
          scheduleReconnect();
        }
      };
    };

    setLines([]);
    setDropped(0);
    setDiscarded(0);
    setNotices([]);
    setError(null);
    open();

    return () => {
      disposed = true;
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      stream?.close();
    };
  }, [sourceId, tailLines, level, keyword, follow, generation]);

  return { lines, status, dropped, discarded, notices, error, clear, reconnect };
}

function parseFrame<T>(event: Event): T | null {
  const payload = (event as MessageEvent<string>).data;
  if (typeof payload !== 'string' || payload === '') return null;
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}
