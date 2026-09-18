"use client";
import { Suspense } from 'react';
import { UsersSummaryPanel } from "./components/UsersSummaryPanel";
import { UsersToolbar } from "./components/UsersToolbar";
import { UsersTable } from "./components/UsersTable";
import { UserDrawer } from "./components/UserDrawer";
import { Shield, Plus } from "lucide-react";
import { EmptyState } from "@/components/OperationFeedback";
import { useUsersPage } from "./hooks/useUsersPage";
import PageHeader from "@/components/ui/PageHeader";
import styles from "./users.module.css";

function UsersConsole() {
  const {
    canRead,
    canCreate,
    authLoading,
    stats,
    openCreateDrawer,
    t,
    toolbarProps,
    drawerProps,
    tableProps
  } = useUsersPage();

    if (authLoading) return <div className="container" aria-busy="true">{t('loading')}</div>;
    if (!canRead) {
    return (
      <div className="container animate-fade-in">
        <div className={styles.accessPanel}>
          <EmptyState
            icon={<Shield size={48} />}
            title={t("users_access_denied")}
            description={t("users_access_denied_desc")}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={`${styles.page} animate-fade-in`}>
        <PageHeader
          eyebrow={t("eyebrow_rbac_iam")}
          icon={<Shield size={23} />}
          title={t("users_title")}
          description={t("users_subtitle")}
          actions={canCreate ? <button type="button" className="btn btn-primary" onClick={openCreateDrawer}>
            <Plus size={17} />
            {t("users_new")}
          </button> : null}
        />

        <UsersSummaryPanel stats={stats} />

        <section className={styles.tablePanel}>
          <UsersToolbar {...toolbarProps} />


          <UsersTable {...tableProps} />
        </section>
      </div>


      <UserDrawer {...drawerProps} />
          </>
  );
}

export default function UsersPage() {
  return <Suspense><UsersConsole /></Suspense>;
}
