/*
 * User management route.
 *
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/users/page.tsx
 *
 * The route now renders the historical composition — summary strip, toolbar,
 * table and drawer — driven by `useUsersPage`, which owns the URL-backed filter,
 * sort, pagination and drawer state. Adaptations: the App Router entry replaced by
 * a React Router container; the `Suspense` boundary dropped because the current
 * router resolves route parameters synchronously.
 */
import { Plus, Shield } from 'lucide-react';
import { UsersSummaryPanel } from './components/UsersSummaryPanel';
import { UsersToolbar } from './components/UsersToolbar';
import { UsersTable } from './components/UsersTable';
import { UserDrawer } from './components/UserDrawer';
import { EmptyState } from '../../components/ui/OperationFeedback';
import { useUsersPage } from './hooks/useUsersPage';
import PageHeader from '../../components/ui/PageHeader';
import styles from '../../styles/modules/users.module.css';

export function UsersPage() {
  const {
    canRead,
    canCreate,
    authLoading,
    stats,
    openCreateDrawer,
    t,
    toolbarProps,
    drawerProps,
    tableProps,
  } = useUsersPage();

  if (authLoading) return <div className="container" aria-busy="true">{t('loading')}</div>;

  if (!canRead) {
    return (
      <div className="container animate-fade-in">
        <div className={styles.accessPanel}>
          <EmptyState
            icon={<Shield size={48} />}
            title={t('users_access_denied')}
            description={t('users_access_denied_desc')}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="container animate-fade-in">
        <PageHeader
          eyebrow={t('eyebrow_rbac_iam')}
          icon={<Shield size={23} />}
          title={t('users_title')}
          description={t('users_subtitle')}
          actions={canCreate ? (
            <button type="button" className="btn btn-primary" onClick={openCreateDrawer}>
              <Plus size={17} />
              {t('users_new')}
            </button>
          ) : null}
        />

        <UsersSummaryPanel stats={stats} />

        <section className="dash-card">
          <UsersToolbar {...toolbarProps} />
          <UsersTable {...tableProps} />
        </section>
      </div>

      <UserDrawer {...drawerProps} />
    </>
  );
}
