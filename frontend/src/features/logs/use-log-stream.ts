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
 *
 * Two lifecycle rules that are easy to get wrong:
 *
 *   - Every effect run owns a fresh frame buffer. A buffered frame belongs to
 *     the source/filter set that received it, so the buffer is discarded when
 *     the stream is replaced instead of being flushed into the next view.
 *   - A reconnect is a new tail (the server re-reads the file), not a resume.
 *     Re-opening the same EventSource therefore starts the view over; keeping
 *     the old scrollback would show the replayed tail twice.
 *
 * The hook reports stable error codes, never prose: the page owns localization.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { logStreamPath } from './logs-api';
import {
  MAX_VIEW_LINES,
  type LogLine,
  type LogStreamStatus,
  type LogStreamUnavailable,
} from './logs-types';

export type LogStreamOptions = {
  sourceId: string;
  tailLines: number;
  level: string;
  keyword: string;
  follow: boolean;
  paused: boolean;
  /**
   * The registry's verdict about this source. A source the deployment already
   * knows is unreadable is never opened: the server would answer 409 and the
   * browser would keep retrying a request that cannot succeed. An id the
   * registry does not offer is treated the same way.
   */
  unavailable?: LogStreamUnavailable | null;
};

export type LogStreamError = 'unsupported' | 'unreadable' | 'unknown_source' | 'reconnect_failed';

export type LogStreamResult = {
  lines: LogLine[];
  status: LogStreamStatus;
  dropped: number;
  discarded: number;
  notices: string[];
  error: LogStreamError | null;
  clear: () => void;
  reconnect: () => void;
};

const FLUSH_INTERVAL_MS = 120;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
/* Consecutive failed (re)open attempts that still deserve "reconnecting".
 * Past this the workspace states that it is unavailable; a later successful
 * open clears the state again. */
const MAX_SILENT_ATTEMPTS = 3;

/* Render identity for the retained rows. Monotonic per page, so a row keeps
 * its identity when the server's sequence restarts on a new stream. */
let nextLineId = 0;

type Frame = {
  seq: number;
  level: string;
  text: string;
};

export function trimLogLines(lines: LogLine[], limit = MAX_VIEW_LINES): LogLine[] {
  return lines.length > limit ? lines.slice(lines.length - limit) : lines;
}

export function useLogStream(options: LogStreamOptions): LogStreamResult {
  const { sourceId, tailLines, level, keyword, follow, paused, unavailable = null } = options;

  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<LogStreamStatus>('idle');
  const [dropped, setDropped] = useState(0);
  const [discarded, setDiscarded] = useState(0);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<LogStreamError | null>(null);
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
      setError(null);
      return undefined;
    }

    setLines([]);
    setDropped(0);
    setDiscarded(0);
    setNotices([]);
    /* Buffered frames belong to the previous stream. Flushing them after this
     * run starts would show the old source's lines under the new source. */
    pendingRef.current = [];

    if (unavailable) {
      setStatus('unavailable');
      setError(unavailable);
      return undefined;
    }

    if (typeof EventSource === 'undefined') {
      setStatus('unavailable');
      setError('unsupported');
      return undefined;
    }

    let disposed = false;
    let stream: EventSource | null = null;
    let flushTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let attempts = 0;
    let failures = 0;
    let opened = false;

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
        failures = 0;
        if (opened) {
          /* A new server tail: the replay replaces the window instead of
           * landing on top of the same lines. */
          pendingRef.current = [];
          setLines([]);
          setDropped(0);
          setDiscarded(0);
        }
        opened = true;
        setStatus('live');
        setError(null);
      });

      stream.addEventListener('line', (event) => {
        if (disposed) return;
        const payload = parseFrame<Frame>(event);
        if (!payload || typeof payload.text !== 'string') return;
        const line: LogLine = {
          id: (nextLineId += 1),
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
        failures += 1;
        if (failures >= MAX_SILENT_ATTEMPTS) {
          setStatus('unavailable');
          setError('reconnect_failed');
        } else {
          setStatus('reconnecting');
        }
        if (stream && stream.readyState === EventSource.CLOSED) {
          scheduleReconnect();
        }
      };
    };

    open();

    return () => {
      disposed = true;
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      pendingRef.current = [];
      stream?.close();
    };
  }, [sourceId, tailLines, level, keyword, follow, generation, unavailable]);

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
