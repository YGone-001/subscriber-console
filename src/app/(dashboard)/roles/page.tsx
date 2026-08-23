"use client";

import { Shield } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import RoleManagementPanel from "@/components/users/RoleManagementPanel";
import PageHeader from "@/components/ui/PageHeader";
import styles from "./roles.module.css";

export default function RolesPage() {
  const { t } = useI18n();
  return (
    <div className={`${styles.page} animate-fade-in`}>
      <PageHeader eyebrow={t("eyebrow_rbac_matrix")} icon={<Shield size={23} />} title={t("roles_title")} description={t("roles_subtitle")} />
      <RoleManagementPanel />
    </div>
  );
}
