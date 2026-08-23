import { useI18n } from "@/components/I18nProvider";
import { RoleBadge } from "@/components/iam/RoleBadge";
import iamStyles from "@/components/iam/iam.module.css";
import { ROLE_CAPABILITIES } from "@/lib/permissions";
import { normalizePermissionEffect, permissionEffectToDecisionKey } from "@/lib/userAccessManagement";
import { CAPABILITY_LABEL_KEYS, type Capability, type SysUser } from "../types";
import { normalizeRole } from "../utils";
import styles from "./UserDrawer.module.css";

export function UserPermissions({ user }: { user: SysUser }) {
  const { t } = useI18n();
  const role = normalizeRole(user.role);
  const decisionIcon = (decision: "allow" | "approval" | "deny") => decision === "allow" ? <CheckCircle2 size={16} /> : decision === "approval" ? <CircleAlert size={16} /> : <XCircle size={16} />;
  return (
    <section className={styles.detailSection}>
      <h3>{t("users_detail_tab_permissions")}</h3>
      <div className={styles.permissionSummary}><span>{t("users_effective_role")}</span><RoleBadge role={role} /><small><Info size={14} />{t("users_no_user_overrides")}</small></div>
      <div className={styles.permissionMatrixScroll}>
        <table className={styles.permissionMatrix}>
          <caption className="sr-only">{t("users_permission_comparison")}</caption>
          <thead><tr><th>{t("roles_matrix_action")}</th><th>{t(`users_${role}`)}</th><th>{t("users_root")}</th></tr></thead>
          <tbody>
        {(Object.keys(ROLE_CAPABILITIES[role]) as Capability[]).map((capability) => {
          const decision = permissionEffectToDecisionKey(normalizePermissionEffect(ROLE_CAPABILITIES[role][capability]));
          const rootDecision = permissionEffectToDecisionKey(normalizePermissionEffect(ROLE_CAPABILITIES.root[capability]));
          return <tr key={capability} className={decision === "deny" ? styles.permissionDenied : undefined}><td>{t(CAPABILITY_LABEL_KEYS[capability])}</td><td><span className={`${iamStyles.decision} ${iamStyles[decision]}`}>{decisionIcon(decision)}{t(`users_perm_decision_${decision}`)}</span></td><td><span className={`${iamStyles.decision} ${iamStyles[rootDecision]}`}>{decisionIcon(rootDecision)}{t(`users_perm_decision_${rootDecision}`)}</span></td></tr>;
        })}
          </tbody>
        </table>
      </div>
      <Link className={styles.permissionLink} href="/roles">{t("users_view_permission_matrix")}<ArrowRight size={15} /></Link>
    </section>
  );
}
import Link from "next/link";
import { ArrowRight, CheckCircle2, CircleAlert, Info, XCircle } from "lucide-react";
