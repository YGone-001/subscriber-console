import { CheckCircle2, XCircle } from 'lucide-react';
import { useI18n } from '@/components/I18nProvider';
import { RoleBadge } from '@/components/iam/RoleBadge';
import { PERMISSION_CATALOG, hasPermission } from '@/lib/permissions';
import type { SysUser } from '../types';
import styles from './UserDrawer.module.css';

export function UserPermissions({ user }: { user: SysUser }) {
  const { t } = useI18n();
  const groups = [...new Set(PERMISSION_CATALOG.map((permission) => permission.split('.')[0]))];
  return <section className={styles.detailSection}>
    <h3>{t('users_detail_tab_permissions')}</h3>
    <div className={styles.permissionSummary}><RoleBadge role={user.role} /><small>{t('users_no_user_overrides')}</small></div>
    <p className={styles.sectionDescription}>{t('users_permission_snapshot_note')}</p>
    {groups.map((group) => <div key={group}>
      <h3>{t(`users_permission_group_${group}`)}</h3>
      <table className={styles.permissionMatrix}><caption className="sr-only">{t(`users_permission_group_${group}`)}</caption><tbody>
        {PERMISSION_CATALOG.filter((permission) => permission.startsWith(`${group}.`)).map((permission) => {
          const allowed = hasPermission({ role: user.role }, permission);
          return <tr key={permission} className={allowed ? undefined : styles.permissionDenied}>
            <td>{t(`permission_${permission.replace(/[.-]/g, '_')}`)}<small className={styles.permissionKey}>{permission}</small></td>
            <td>{allowed ? <CheckCircle2 size={16} aria-hidden /> : <XCircle size={16} aria-hidden />} {t(allowed ? 'users_perm_decision_allow' : 'users_perm_decision_deny')}</td>
          </tr>;
        })}
      </tbody></table>
    </div>)}
  </section>;
}
