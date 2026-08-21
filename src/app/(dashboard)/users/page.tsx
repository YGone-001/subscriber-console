"use client";
import React from "react";
import "./users.css";
import { UsersSummaryPanel } from "./components/UsersSummaryPanel";
import { UsersToolbar } from "./components/UsersToolbar";
import { UsersTable } from "./components/UsersTable";
import { UserDrawer } from "./components/UserDrawer";
import { Shield, Plus } from "lucide-react";
import { EmptyState } from "@/components/OperationFeedback";
import { useUsersPage } from "./hooks/useUsersPage";
import PageHeader from "@/components/ui/PageHeader";

export default function UsersPage() {
  // users_detail_tab_permissions
  const {
    isRoot,
    users,
    statusCounts,
    openCreateDrawer,
    t,
    toolbarProps,
    drawerProps,
    tableProps
  } = useUsersPage();

    if (!isRoot) {
    return (
      <div className="container animate-fade-in">
        <div className="users-access-panel">
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
      <div className="users-page animate-fade-in">
        <PageHeader
          eyebrow={t("eyebrow_rbac_iam")}
          icon={<Shield size={23} />}
          title={t("users_title")}
          description={t("users_subtitle")}
          actions={<button type="button" className="btn btn-primary" onClick={openCreateDrawer}>
            <Plus size={17} />
            {t("users_new")}
          </button>}
        />

        <UsersSummaryPanel
          usersCount={users.length}
          statusCounts={statusCounts as { active: number; disabled: number; }}
        />

        <section className="users-table-panel">
          <UsersToolbar {...toolbarProps} />


          <UsersTable {...tableProps} />
        </section>
      </div>


      <UserDrawer {...drawerProps} />
          </>
  );
}
