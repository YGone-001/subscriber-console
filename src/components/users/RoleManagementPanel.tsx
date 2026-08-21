"use client";
import "./RoleManagementPanel.css";

import { Fragment, useMemo, useState } from "react";
import useSWR from "swr";
import { Shield } from "lucide-react";
import { fetcher } from "@/lib/fetcher";
import { ROLE_CAPABILITIES, type Capability } from "@/lib/permissions";
import {
  normalizePermissionEffect,
  permissionEffectToDecisionKey,
  type PermissionEffect,
} from "@/lib/userAccessManagement";
import { useAuth } from "@/hooks/useAuth";
import { useI18n } from "@/components/I18nProvider";
import { EmptyState, LoadingRows } from "@/components/OperationFeedback";
import PageHeader from "@/components/ui/PageHeader";

type SysUser = {
  username: string;
  role: string;
};

type RoleKey = keyof typeof ROLE_CAPABILITIES;

const CAPABILITY_LABEL_KEYS: Record<Capability, string> = {
  subscriber_write: "users_cap_action_subscriber_write",
  policy_approve: "users_cap_action_policy_approve",
  balance_adjust: "users_cap_action_balance_adjust",
  profile_rollback: "users_cap_action_profile_rollback",
  rating_publish: "users_cap_action_rating_publish",
  audit_export: "users_cap_action_audit_export",
  system_heal: "users_cap_action_system_heal",
  user_admin: "users_cap_action_user_admin",
};

const CAPABILITY_DIMENSION_KEYS: Record<Capability, string> = {
  subscriber_write: "role_perm_dimension_edit",
  policy_approve: "role_perm_dimension_approve",
  balance_adjust: "role_perm_dimension_edit",
  profile_rollback: "role_perm_dimension_rollback",
  rating_publish: "role_perm_dimension_publish",
  audit_export: "role_perm_dimension_export",
  system_heal: "role_perm_dimension_system",
  user_admin: "role_perm_dimension_system",
};

function effectTone(effect: PermissionEffect) {
  return permissionEffectToDecisionKey(effect);
}

export default function RoleManagementPanel() {
  const { isRoot } = useAuth();
  const { t } = useI18n();
  const { data, error, isLoading, mutate } = useSWR<{ users: SysUser[] }>("/api/auth/users", fetcher);
  const [selectedRole, setSelectedRole] = useState<RoleKey>("root");

  const users = useMemo(() => data?.users || [], [data?.users]);
  const roleCards = useMemo(() => (
    (Object.keys(ROLE_CAPABILITIES) as RoleKey[]).map((role) => {
      const effects = Object.values(ROLE_CAPABILITIES[role]).map(normalizePermissionEffect);
      return {
        role,
        users: users.filter((item) => item.role === role).length,
        allowed: effects.filter((effect) => effect === "allow").length,
        approvals: effects.filter((effect) => effect === "approval_required").length,
        denied: effects.filter((effect) => effect === "deny").length,
      };
    })
  ), [users]);

  const groupedCapabilities = useMemo(() => {
    const groups = new Map<string, Capability[]>();
    (Object.keys(ROLE_CAPABILITIES[selectedRole]) as Capability[]).forEach((capability) => {
      const group = CAPABILITY_DIMENSION_KEYS[capability];
      groups.set(group, [...(groups.get(group) || []), capability]);
    });
    return Array.from(groups.entries());
  }, [selectedRole]);

  if (!isRoot) {
    return (
      <div className="roles-page">
        <EmptyState icon={<Shield size={48} />} title={t("users_access_denied")} description={t("users_access_denied_desc")} />
      </div>
    );
  }

  return (
    <div className="roles-page">
      <PageHeader
        eyebrow={t("eyebrow_rbac_matrix")}
        icon={<Shield size={23} />}
        title={t("roles_title")}
        description={t("roles_subtitle")}
      />

      {isLoading ? (
        <LoadingRows columns={3} rows={3} />
      ) : error ? (
        <EmptyState
          icon={<Shield size={42} />}
          title={t("roles_error_title")}
          description={t("roles_error_desc")}
          action={<button type="button" className="btn btn-outline" onClick={() => void mutate()}>{t("refresh")}</button>}
        />
      ) : (
        <>
          <section className="roles-grid" role="tablist" aria-label={t("roles_title")}>
            {roleCards.map((card) => (
              <button
                key={card.role}
                id={`role-tab-${card.role}`}
                type="button"
                role="tab"
                className="role-card"
                aria-selected={selectedRole === card.role}
                aria-controls="role-policy-matrix"
                onClick={() => setSelectedRole(card.role)}
              >
                <span className="role-badge">{t(`users_${card.role}`)}</span>
                <strong>{t(`roles_desc_${card.role}`)}</strong>
                <dl>
                  <div><dt>{t("roles_user_count")}</dt><dd>{card.users}</dd></div>
                  <div><dt>{t("roles_allow_count")}</dt><dd>{card.allowed}</dd></div>
                  <div><dt>{t("roles_approval_count")}</dt><dd>{card.approvals}</dd></div>
                  <div><dt>{t("roles_deny_count")}</dt><dd>{card.denied}</dd></div>
                </dl>
              </button>
            ))}
          </section>

          <section
            id="role-policy-matrix"
            className="role-policy-panel"
            role="tabpanel"
            aria-labelledby={`role-tab-${selectedRole}`}
          >
            <header className="role-policy-header">
              <div>
                <h2>{t("roles_matrix_title")} · {t(`users_${selectedRole}`)}</h2>
                <p>{t("roles_builtin_note")}</p>
              </div>
            </header>

            <div className="role-matrix-scroll">
              <table className="role-matrix">
                <caption className="sr-only">{t("roles_matrix_title")}</caption>
                <thead>
                  <tr>
                    <th>{t("roles_matrix_module")}</th>
                    <th>{t("roles_matrix_action")}</th>
                    <th>{t("roles_matrix_effect")}</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedCapabilities.map(([group, capabilities]) => (
                    <Fragment key={group}>
                      <tr className="role-group-row">
                        <td colSpan={3}>{t(group)}</td>
                      </tr>
                      {capabilities.map((capability) => {
                        const effect = normalizePermissionEffect(ROLE_CAPABILITIES[selectedRole][capability]);
                        return (
                          <tr key={capability}>
                            <td>{t(group)}</td>
                            <td>{t(CAPABILITY_LABEL_KEYS[capability])}</td>
                            <td>
                              <span className={`permission-effect ${effectTone(effect)}`}>
                                {t(`users_perm_decision_${effectTone(effect)}`)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
