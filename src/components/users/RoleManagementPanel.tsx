"use client";
import "./RoleManagementPanel.css";

import { Fragment, useId, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Eye, Shield, X } from "lucide-react";
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
import { Dialog } from "@/components/ui/Dialog";

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
  const [selectedRole, setSelectedRole] = useState<RoleKey | null>(null);
  const [onlyConfigured, setOnlyConfigured] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const users = useMemo(() => data?.users || [], [data?.users]);
  const roleCards = useMemo(() => (
    (Object.keys(ROLE_CAPABILITIES) as RoleKey[]).map((role) => {
      const effects = Object.values(ROLE_CAPABILITIES[role]).map(normalizePermissionEffect);
      return {
        role,
        users: users.filter((item) => item.role === role).length,
        configured: effects.filter((effect) => effect !== "deny").length,
        approvals: effects.filter((effect) => effect === "approval_required").length,
      };
    })
  ), [users]);

  const activeRole = selectedRole || roleCards[0]?.role || "viewer";
  const groupedCapabilities = useMemo(() => {
    const groups = new Map<string, Capability[]>();
    (Object.keys(ROLE_CAPABILITIES[activeRole]) as Capability[]).forEach((capability) => {
      const effect = normalizePermissionEffect(ROLE_CAPABILITIES[activeRole][capability]);
      if (onlyConfigured && effect === "deny") return;
      const group = CAPABILITY_DIMENSION_KEYS[capability];
      groups.set(group, [...(groups.get(group) || []), capability]);
    });
    return Array.from(groups.entries());
  }, [activeRole, onlyConfigured]);

  if (!isRoot) {
    return (
      <div className="roles-page">
        <EmptyState icon={<Shield size={48} />} title={t("users_access_denied")} description={t("users_access_denied_desc")} />
      </div>
    );
  }

  return (
    <>
      <div className="roles-page">
        <PageHeader
          eyebrow={t("eyebrow_rbac_matrix")}
          icon={<Shield size={23} />}
          title={t("roles_title")}
          description={t("roles_subtitle")}
        />

        <section className="roles-grid">
          {isLoading ? (
            <LoadingRows columns={4} rows={3} />
          ) : error ? (
            <EmptyState
              icon={<Shield size={42} />}
              title={t("roles_error_title")}
              description={t("roles_error_desc")}
              action={<button type="button" className="btn btn-outline" onClick={() => void mutate()}>{t("refresh")}</button>}
            />
          ) : roleCards.map((card) => (
            <article key={card.role} className="role-card">
              <div>
                <span className="role-badge">{t(`users_${card.role}`)}</span>
                <strong>{t(`roles_desc_${card.role}`)}</strong>
              </div>
              <dl>
                <div><dt>{t("roles_user_count")}</dt><dd>{card.users}</dd></div>
                <div><dt>{t("roles_permission_count")}</dt><dd>{card.configured}</dd></div>
                <div><dt>{t("roles_approval_count")}</dt><dd>{card.approvals}</dd></div>
                <div><dt>{t("roles_builtin")}</dt><dd>{t("yes")}</dd></div>
                <div><dt>{t("roles_updated_at")}</dt><dd>{t("roles_builtin_static")}</dd></div>
              </dl>
              <div className="role-actions">
                <button type="button" className="btn btn-outline" onClick={() => setSelectedRole(card.role)}>
                  <Eye size={15} />
                  {t("roles_view_permissions")}
                </button>
              </div>
            </article>
          ))}
        </section>
      </div>

      {selectedRole ? (
        <Dialog
          open
          onClose={() => setSelectedRole(null)}
          overlayClassName="role-drawer-layer"
          className="role-drawer"
          labelledBy={dialogTitleId}
          describedBy={dialogDescriptionId}
          initialFocusRef={closeButtonRef}
        >
          <header>
            <div>
              <h2 id={dialogTitleId}>{t(`users_${activeRole}`)}</h2>
              <p id={dialogDescriptionId}>{t("roles_matrix_subtitle")}</p>
            </div>
            <button ref={closeButtonRef} type="button" className="btn-icon" onClick={() => setSelectedRole(null)} aria-label={t("close")}>
              <X size={18} />
            </button>
          </header>

          <div className="role-drawer-tools">
            <label>
              <input type="checkbox" checked={onlyConfigured} onChange={(event) => setOnlyConfigured(event.target.checked)} />
              {t("roles_only_configured")}
            </label>
          </div>

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
                {groupedCapabilities.map(([group, capabilities]) => {
                  const groupCollapsed = collapsed.includes(group);
                  return (
                    <Fragment key={group}>
                      <tr className="role-group-row">
                        <td colSpan={3}>
                          <button
                            type="button"
                            onClick={() => setCollapsed((current) => current.includes(group) ? current.filter((item) => item !== group) : [...current, group])}
                          >
                            {t(group)} · {capabilities.length}
                          </button>
                        </td>
                      </tr>
                      {groupCollapsed ? null : capabilities.map((capability) => {
                        const effect = normalizePermissionEffect(ROLE_CAPABILITIES[activeRole][capability]);
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
                  );
                })}
              </tbody>
            </table>
          </div>

          <footer>
            <button type="button" className="btn btn-outline" onClick={() => setSelectedRole(null)}>{t("close")}</button>
          </footer>
        </Dialog>
      ) : null}
    </>
  );
}
