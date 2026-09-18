import { CheckCircle2, RefreshCw, Shield } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { EmptyState, LoadingRows } from "@/components/OperationFeedback";
import { displayValue, formatDateTime } from "../utils";
import type { UserDrawerProps } from "./types";
import styles from "./UserDrawer.module.css";
import Link from 'next/link';
import { AuditResultBadge } from '@/components/governance/GovernanceBadges';

type UserActivityLogProps = Pick<UserDrawerProps, "isAuditLoading" | "auditError" | "mutateAudit" | "auditData" | "selectedUser">;

export function UserActivityLog({ isAuditLoading, auditError, mutateAudit, auditData, selectedUser }: UserActivityLogProps) {
  const { t } = useI18n();
  if (isAuditLoading) return <LoadingRows columns={5} rows={4} />;
  if (auditError) return <EmptyState icon={<Shield size={42} />} title={t("users_audit_error_title")} description={t("users_audit_error_desc")} action={<button type="button" className="btn btn-outline" onClick={() => void mutateAudit()}><RefreshCw size={15} />{t("refresh")}</button>} />;
  if (!auditData?.logs.length) return <EmptyState icon={<CheckCircle2 size={42} />} title={t("users_no_data_title")} description={t("users_no_activity_data_desc")} />;
  return (
    <section className={styles.detailSection}>
      <h3>{t("users_detail_tab_activity")}</h3>
      <div className={styles.recordList}>{auditData.logs.map((log) => <div key={log.id}><span>{formatDateTime(log.timestamp)}</span><small>{log.action} · {log.targetId}</small><strong>{displayValue(log.actor)} · {log.result ? <AuditResultBadge result={log.result} /> : '—'}</strong></div>)}</div>
      <Link href={`/audit-logs?actor=${encodeURIComponent(selectedUser?.username || '')}`}>{t('users_view_all_activity')}</Link>
    </section>
  );
}
