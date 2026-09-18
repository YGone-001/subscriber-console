"use client";

import { useI18n } from '@/components/I18nProvider';
import { isRiskLevel, normalizeApprovalStatus } from '@/lib/governance/risk';
import styles from '@/components/iam/iam.module.css';

const RISK_TONES = { low: 'neutral', medium: 'info', high: 'warning', critical: 'critical' } as const;
const STATUS_TONES = {
  pending: 'warning', approved: 'info', rejected: 'danger', cancelled: 'neutral',
  executing: 'info', completed: 'success', failed: 'danger', expired: 'neutral',
} as const;

export function RiskBadge({ risk }: { risk?: string }) {
  const { t } = useI18n();
  const known = isRiskLevel(risk);
  return <span className={`${styles.badge} ${styles[known ? RISK_TONES[risk] : 'neutral']}`}>
    {known ? `${risk.toUpperCase()} · ${t(`governance_risk_${risk}`)}` : t('governance_risk_unknown')}
  </span>;
}

export function ApprovalStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const normalized = normalizeApprovalStatus(status);
  return <span className={`${styles.badge} ${styles[normalized ? STATUS_TONES[normalized] : 'neutral']}`}>
    {normalized ? t(`governance_status_${normalized}`) : t('governance_status_unknown')}
  </span>;
}

export function AuditResultBadge({ result }: { result?: string }) {
  const { t } = useI18n();
  const known = result === 'success' || result === 'failed' || result === 'denied';
  const tone = result === 'success' ? 'success' : result === 'failed' ? 'danger' : result === 'denied' ? 'warning' : 'neutral';
  return <span className={`${styles.badge} ${styles[tone]}`}>
    {known ? t(`governance_result_${result}`) : t('governance_result_unknown')}
  </span>;
}
