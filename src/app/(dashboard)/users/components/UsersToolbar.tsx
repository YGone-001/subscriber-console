import { Search } from 'lucide-react';
import { useI18n } from '@/components/I18nProvider';
import { VALID_ROLES, VALID_STATUS, type RoleFilter, type StatusFilter } from '../types';
import type { UsersToolbarProps } from './types';
import styles from './UsersToolbar.module.css';

export function UsersToolbar(props: UsersToolbarProps) {
  const { t } = useI18n();
  return <div className={styles.toolbar}>
    <form className={styles.search} onSubmit={(event) => { event.preventDefault(); props.updateSearchQuery(String(new FormData(event.currentTarget).get('q') || '')); }}>
      <Search size={16} />
      <input key={props.searchInput} name="q" defaultValue={props.searchInput} maxLength={100} placeholder={t('users_search_ph')} aria-label={t('users_search_ph')} />
      <button type="submit" className="btn btn-ghost">{t('search')}</button>
    </form>
    <div className={styles.filterGroup} aria-label={t('users_filters')}>
      <select className="form-input" aria-label={t('users_role')} value={props.roleFilter} onChange={(event) => props.updateRoleFilter(event.target.value as RoleFilter)}>
        <option value="all">{t('users_filter_all_roles')}</option>
        {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
      </select>
      <select className="form-input" aria-label={t('users_status')} value={props.statusFilter} onChange={(event) => props.updateStatusFilter(event.target.value as StatusFilter)}>
        <option value="all">{t('users_filter_all_statuses')}</option>
        {VALID_STATUS.map((status) => <option key={status} value={status}>{t(`users_${status}`)}</option>)}
      </select>
      <button type="button" className="btn btn-outline" onClick={props.clearFilters}>{t('users_clear_filters')}</button>
    </div>
  </div>;
}
