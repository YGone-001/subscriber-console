/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/common/OcsStatusBadge.tsx
 *
 * Adaptations: "use client" dropped; the `@/components/...` alias replaced with a
 * relative import for the Vite runtime. DOM structure, class vocabulary and the
 * status-to-style mapping are unchanged, so the ported `ocs.css` rules apply.
 */
import { useI18n } from '../../../providers/I18nProvider';

interface OcsStatusBadgeProps {
  status: string;
  className?: string;
}

const STATUS_STYLES: Record<string, string> = {
  active: 'ocs-status-badge ocs-status-active',
  disabled: 'ocs-status-badge ocs-status-disabled',
  suspended: 'ocs-status-badge ocs-status-suspended',
  terminated: 'ocs-status-badge ocs-status-terminated',
  pending: 'ocs-status-badge ocs-status-pending',
  completed: 'ocs-status-badge ocs-status-completed',
  executed: 'ocs-status-badge ocs-status-completed',
  expired: 'ocs-status-badge ocs-status-expired',
  cancelled: 'ocs-status-badge ocs-status-cancelled',
  executing: 'ocs-status-badge ocs-status-executing',
  failed: 'ocs-status-badge ocs-status-failed',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  active: 'ocs_status_active',
  disabled: 'ocs_status_disabled',
  suspended: 'ocs_status_suspended',
  terminated: 'ocs_status_terminated',
  pending: 'ocs_status_pending',
  completed: 'ocs_status_completed',
  executed: 'ocs_status_executed',
  expired: 'ocs_status_expired',
  cancelled: 'ocs_status_cancelled',
  executing: 'ocs_status_executing',
  failed: 'ocs_status_failed',
};

export default function OcsStatusBadge({ status, className }: OcsStatusBadgeProps) {
  const { t } = useI18n();
  const normalized = status ? status.toLowerCase() : '';
  const baseClass = STATUS_STYLES[normalized] || 'ocs-status-badge';
  const labelKey = STATUS_LABEL_KEYS[normalized];
  const label = labelKey ? t(labelKey) : (status || t('ocs_status_unknown'));

  return (
    <span
      className={className ? `${baseClass} ${className}` : baseClass}
      aria-label={label}
      title={status || label}
    >
      {label}
    </span>
  );
}
