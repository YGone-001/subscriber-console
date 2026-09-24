import { useI18n } from '@/components/I18nProvider';
import type { SysUser } from '../types';
import { displayValue, formatDateTime, normalizeStatus } from '../utils';
import styles from './UserDrawer.module.css';

export function UserLoginHistory({ user }: { user: SysUser }) {
  const { t } = useI18n();
  const security = user.security;
  const isLocked = normalizeStatus(user.status) === 'locked';
  const rows: Array<[string, React.ReactNode]> = [
    [t('users_status'), t(`users_${normalizeStatus(user.status)}`)],
    [t('users_session_version'), security?.sessionVersion ?? 0],
    [t('users_failed_logins'), security?.failedLoginAttempts ?? 0],
    [t('users_last_login'), formatDateTime(security?.lastLoginAt || user.lastLoginAt)],
    [t('users_last_login_ip'), displayValue(security?.lastLoginIp || user.lastLoginIp)],
    [t('users_password_changed_at'), formatDateTime(security?.passwordChangedAt)],
    ...(isLocked
      ? [
          [t('users_locked_at'), formatDateTime(security?.lockedAt)] as [string, React.ReactNode],
          [t('users_lock_reason'), displayValue(security?.lockReason)] as [string, React.ReactNode],
        ]
      : []),
  ];
  return (
    <section className={styles.detailSection}>
      <h3>{t('users_security_state')}</h3>
      <p className={styles.sectionDescription}>{t('users_security_snapshot_note')}</p>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
