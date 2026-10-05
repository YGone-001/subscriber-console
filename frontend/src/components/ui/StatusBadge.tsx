export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'badge-secondary',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
  info: 'badge-info',
};

/**
 * Maps a lifecycle / status string onto the restored status colour language.
 * Unknown values fall back to the neutral tone rather than inventing a state.
 */
export function statusToneFor(value: string | undefined | null): StatusTone {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return 'neutral';
  if (['active', 'enabled', 'ok', 'healthy', 'success', 'succeeded', 'completed', 'settled', 'resolved'].includes(normalized)) return 'success';
  if (['maintenance', 'warning', 'pending', 'closing', 'degraded', 'reserved', 'partial'].includes(normalized)) return 'warning';
  if (['retired', 'disabled', 'error', 'failed', 'critical', 'locked', 'orphaned', 'broken', 'released'].includes(normalized)) return 'danger';
  if (['info', 'planned', 'open', 'closed'].includes(normalized)) return 'info';
  return 'neutral';
}

export function StatusBadge({ value, tone }: { value: string; tone?: StatusTone }) {
  return <span className={`badge ${TONE_CLASS[tone ?? statusToneFor(value)]}`}>{value}</span>;
}
