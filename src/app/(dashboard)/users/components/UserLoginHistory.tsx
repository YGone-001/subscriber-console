import { useI18n } from '@/components/I18nProvider';
import type { SysUser } from '../types';
import { displayValue, formatDateTime } from '../utils';
import styles from './UserDrawer.module.css';

export function UserLoginHistory({ user }: { user: SysUser }) {
  const { t } = useI18n();
  const security = user.security;
  const rows = [
    [t('users_last_login'), formatDateTime(security?.lastLoginAt || user.lastLoginAt)],
    [t('users_last_login_ip'), displayValue(security?.lastLoginIp || user.lastLoginIp)],
    [t('users_password_changed_at'), formatDateTime(security?.passwordChangedAt)],
    [t('users_failed_logins'), security?.failedLoginAttempts ?? '—'],
    [t('users_locked_at'), formatDateTime(security?.lockedAt)],
    [t('users_lock_reason'), displayValue(security?.lockReason)],
    [t('users_session_version'), security?.sessionVersion ?? 0],
  ];
  return <section className={styles.detailSection}>
    <h3>{t('users_security_state')}</h3>
    <p className={styles.sectionDescription}>{t('users_security_snapshot_note')}</p>
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}
