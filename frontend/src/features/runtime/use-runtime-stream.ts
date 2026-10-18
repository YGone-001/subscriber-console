/*
 * Runtime snapshot stream subscription.
 *
 * GET /api/runtime/stream is a single shared SSE sample broadcast: the server
 * re-reads its one snapshot on a fixed cadence and fans the same frame out to
 * every subscriber. Subscribing never triggers a scan and never adds sampling
 * work. This module owns one module-level EventSource that is ref-counted
 * across every mounted consumer, so several runtime surfaces rendered on the
 * same page still open exactly one connection.
 *
 * Integrity rules:
 *   - the streamed payload is the same freshness-projected snapshot the polled
 *     observations endpoint serves, with the same association projection, so
 *     the stream and the polled fallback never disagree;
 *   - a malformed frame marks the stream as errored and never replaces the
 *     last valid snapshot (a failed push never overwrites the last honest
 *     measurement);
 *   - when the stream is not connected, consumers fall back to the polled
 *     observations endpoint.
 */
import { useSyncExternalStore } from 'react';
import type { RuntimeObservations } from './runtime-types';

export type RuntimeStreamStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

export type RuntimeStreamState = {
  status: RuntimeStreamStatus;
  data: RuntimeObservations | null;
};

type RuntimeStreamFrame = {
  timestamp?: string;
  snapshot?: RuntimeObservations['snapshot'];
  associationsComplete?: boolean;
};

const RUNTIME_STREAM_PATH = '/api/runtime/stream';

let state: RuntimeStreamState = { status: 'connecting', data: null };
const listeners = new Set<(next: RuntimeStreamState) => void>();
let source: EventSource | null = null;
let subscriptions = 0;

function emit(patch: Partial<RuntimeStreamState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

function onSnapshot(event: MessageEvent<string>): void {
  try {
    const frame = JSON.parse(event.data) as RuntimeStreamFrame;
    if (!frame || typeof frame !== 'object' || !frame.snapshot || !Array.isArray(frame.snapshot.components)) {
      emit({ status: 'error' });
      return;
    }
    emit({
      status: 'connected',
      data: { snapshot: frame.snapshot, associationsComplete: frame.associationsComplete !== false },
    });
  } catch {
    emit({ status: 'error' });
  }
}

function onSessionExpired(): void {
  window.dispatchEvent(new Event('xcloud-session-revalidate'));
}

function onError(): void {
  emit({ status: 'error' });
}

function openStream(): void {
  if (source) return;
  if (typeof window === 'undefined' || typeof window.EventSource !== 'function') {
    emit({ status: 'disconnected', data: null });
    return;
  }
  emit({ status: 'connecting' });
  const stream = new window.EventSource(RUNTIME_STREAM_PATH, { withCredentials: true });
  stream.addEventListener('snapshot', onSnapshot as EventListener);
  stream.addEventListener('session_expired', onSessionExpired as EventListener);
  stream.addEventListener('error', onError as EventListener);
  source = stream;
}

function closeStream(): void {
  if (!source) return;
  source.removeEventListener('snapshot', onSnapshot as EventListener);
  source.removeEventListener('session_expired', onSessionExpired as EventListener);
  source.removeEventListener('error', onError as EventListener);
  source.close();
  source = null;
  emit({ status: 'disconnected', data: null });
}

/**
 * Subscribe to the shared runtime stream. The connection opens with the first
 * subscriber and closes with the last one, so every consumer on a page shares
 * one server-side subscriber slot.
 */
export function subscribeRuntimeStream(listener: (next: RuntimeStreamState) => void): () => void {
  listeners.add(listener);
  subscriptions += 1;
  openStream();
  return () => {
    listeners.delete(listener);
    subscriptions -= 1;
    if (subscriptions <= 0) {
      subscriptions = 0;
      closeStream();
    }
  };
}

/** Client snapshot for useSyncExternalStore. */
export function getRuntimeStreamState(): RuntimeStreamState {
  return state;
}

/** Server snapshot: the live stream is a browser-only transport. */
export function getRuntimeStreamServerState(): RuntimeStreamState {
  return { status: 'disconnected', data: null };
}

/**
 * Prefer the live stream frame when the stream is connected; otherwise serve
 * the polled observations payload. The polled fallback keeps the surface
 * honest when the stream is unavailable.
 */
export function resolveRuntimeObservations(
  stream: RuntimeStreamState,
  polled: RuntimeObservations | undefined,
): RuntimeObservations | undefined {
  if (stream.status === 'connected' && stream.data) return stream.data;
  return polled;
}

/** React binding to the shared runtime stream. */
export function useRuntimeStream(): RuntimeStreamState {
  return useSyncExternalStore(subscribeRuntimeStream, getRuntimeStreamState, getRuntimeStreamServerState);
}
