import { useI18n } from '@/components/I18nProvider';
import { VALID_STATUS, type RoleKey, type UserStatus } from '../types';
import type { UserDrawerProps } from './types';
import styles from './UserDrawer.module.css';

type Props = Pick<UserDrawerProps, 'selectedUser' | 'editForm' | 'setEditForm' | 'canManage' | 'assignableRoles'>;
export function UserEditForm(props: Props) {
  const { t } = useI18n();
  const user = props.selectedUser;
  if (!user) return null;
  return <>
    <section className={styles.formSection}>
      <h3>{t('users_form_basic')}</h3>
      <label><span>{t('users_username')}</span><input className="form-input" value={user.username} disabled /></label>
      <label><span>{t('users_display_name')} *</span><input className="form-input" value={props.editForm.displayName} maxLength={100} required disabled={!props.canManage(user, 'update')} onChange={(event) => props.setEditForm((form) => ({ ...form, displayName: event.target.value }))} /></label>
      <label><span>{t('users_email')}</span><input type="email" className="form-input" value={props.editForm.email} maxLength={254} disabled={!props.canManage(user, 'update')} onChange={(event) => props.setEditForm((form) => ({ ...form, email: event.target.value }))} /></label>
    </section>
    <section className={styles.formSection}>
      <h3>{t('users_form_role')}</h3>
      <label><span>{t('users_role')}</span><select className="form-input" value={props.editForm.role} disabled={!props.canManage(user, 'role.change')} onChange={(event) => props.setEditForm((form) => ({ ...form, role: event.target.value as RoleKey }))}>
        {Array.from(new Set([props.editForm.role, ...props.assignableRoles])).map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
      </select></label>
      <label><span>{t('users_status')}</span><select className="form-input" value={props.editForm.status} disabled={!props.canManage(user, 'disable')} onChange={(event) => props.setEditForm((form) => ({ ...form, status: event.target.value as UserStatus }))}>
        {VALID_STATUS.map((status) => <option key={status} value={status}>{t(`users_${status}`)}</option>)}
      </select></label>
      <p className={styles.sectionDescription}>{t('users_session_impact')}</p>
    </section>
  </>;
}
