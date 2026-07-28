"use client";

import { Fragment, useMemo, useState } from "react";
import useSWR from "swr";
import { Copy, Eye, Save, Shield, Trash2, X } from "lucide-react";
import { fetcher } from "@/lib/fetcher";
import { ROLE_CAPABILITIES, type Capability, type CapabilityDecision } from "@/lib/permissions";
import { useAuth } from "@/hooks/useAuth";
import { useI18n } from "@/components/I18nProvider";
import { EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";

type SysUser = {
  username: string;
  role: string;
};

type PermissionEffect = "allow" | "approval_required" | "deny";
type RoleKey = keyof typeof ROLE_CAPABILITIES;
type DraftMatrix = Record<Capability, PermissionEffect>;

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

function normalizeEffect(decision: CapabilityDecision): PermissionEffect {
  if (decision === "approval") return "approval_required";
  if (decision === "deny") return "deny";
  return "allow";
}

function effectTone(effect: PermissionEffect) {
  if (effect === "allow") return "allow";
  if (effect === "approval_required") return "approval";
  return "deny";
}

function buildDraft(role: RoleKey): DraftMatrix {
  const entries = Object.entries(ROLE_CAPABILITIES[role]).map(([capability, decision]) => [
    capability,
    normalizeEffect(decision),
  ]);
  return Object.fromEntries(entries) as DraftMatrix;
}

export default function RoleManagementPanel() {
  const { isRoot } = useAuth();
  const { t } = useI18n();
  const { data, error, isLoading, mutate } = useSWR<{ users: SysUser[] }>("/api/auth/users", fetcher);
  const [selectedRole, setSelectedRole] = useState<RoleKey | null>(null);
  const [editingRole, setEditingRole] = useState<RoleKey | null>(null);
  const [draft, setDraft] = useState<DraftMatrix | null>(null);
  const [onlyConfigured, setOnlyConfigured] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const users = useMemo(() => data?.users || [], [data?.users]);
  const roleCards = useMemo(() => {
    return (Object.keys(ROLE_CAPABILITIES) as RoleKey[]).map((role) => {
      const capabilities = ROLE_CAPABILITIES[role];
      const effects = Object.values(capabilities).map(normalizeEffect);
      return {
        role,
        users: users.filter((item) => item.role === role).length,
        configured: effects.filter((effect) => effect !== "deny").length,
        approvals: effects.filter((effect) => effect === "approval_required").length,
      };
    });
  }, [users]);

  const activeRole = selectedRole || roleCards[0]?.role || "viewer";
  const baseline = buildDraft(activeRole);
  const activeDraft = draft || baseline;
  const changes = (Object.keys(activeDraft) as Capability[]).filter((capability) => activeDraft[capability] !== baseline[capability]);
  const affectedUsers = users.filter((item) => item.role === activeRole).length;
  const groupedCapabilities = useMemo(() => {
    const groups = new Map<string, Capability[]>();
    (Object.keys(ROLE_CAPABILITIES[activeRole]) as Capability[]).forEach((capability) => {
      if (onlyConfigured && baseline[capability] === "deny") return;
      const group = CAPABILITY_DIMENSION_KEYS[capability];
      groups.set(group, [...(groups.get(group) || []), capability]);
    });
    return Array.from(groups.entries());
  }, [activeRole, baseline, onlyConfigured]);

  if (!isRoot) {
    return (
      <div className="roles-page">
        <EmptyState icon={<Shield size={48} />} title={t("users_access_denied")} description={t("users_access_denied_desc")} />
      </div>
    );
  }

  const openRole = (role: RoleKey, edit = false) => {
    setSelectedRole(role);
    setEditingRole(edit ? role : null);
    setDraft(buildDraft(role));
    setNotice(null);
  };

  const closeDetail = () => {
    setSelectedRole(null);
    setEditingRole(null);
    setDraft(null);
  };

  return (
    <>
      <div className="roles-page">
        <header className="roles-header">
          <div>
            <h1>{t("roles_title")}</h1>
            <p>{t("roles_subtitle")}</p>
          </div>
        </header>

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
                <button type="button" className="btn btn-outline" onClick={() => openRole(card.role)}>
                  <Eye size={15} />
                  {t("roles_view_permissions")}
                </button>
                <button type="button" className="btn btn-outline" onClick={() => openRole(card.role, true)}>
                  <Save size={15} />
                  {t("edit")}
                </button>
                <button type="button" className="btn btn-outline" disabled title={t("roles_no_api")}>
                  <Copy size={15} />
                  {t("roles_copy")}
                </button>
                <button type="button" className="btn btn-outline danger" disabled title={t("roles_builtin_protected")}>
                  <Trash2 size={15} />
                  {t("delete")}
                </button>
              </div>
            </article>
          ))}
        </section>
      </div>

      {selectedRole ? (
        <div className="role-drawer-layer" role="dialog" aria-modal="true" aria-label={t("roles_matrix_title")}>
          <button type="button" className="role-drawer-backdrop" aria-label={t("close")} onClick={closeDetail} />
          <aside className="role-drawer">
            <header>
              <div>
                <h2>{t(`users_${activeRole}`)}</h2>
                <p>{editingRole ? t("roles_edit_readonly_hint") : t("roles_matrix_subtitle")}</p>
              </div>
              <button type="button" className="btn-icon" onClick={closeDetail} aria-label={t("close")}><X size={18} /></button>
            </header>

            <div className="role-drawer-tools">
              <label>
                <input type="checkbox" checked={onlyConfigured} onChange={(event) => setOnlyConfigured(event.target.checked)} />
                {t("roles_only_configured")}
              </label>
            </div>

            <div className="role-matrix-scroll">
              <table className="role-matrix">
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
                        <tr key={group} className="role-group-row">
                          <td colSpan={3}>
                            <button
                              type="button"
                              onClick={() => setCollapsed((current) => current.includes(group) ? current.filter((item) => item !== group) : [...current, group])}
                            >
                              {t(group)} · {capabilities.length}
                            </button>
                          </td>
                        </tr>
                        {groupCollapsed ? null : capabilities.map((capability) => (
                          <tr key={capability}>
                            <td>{t(group)}</td>
                            <td>{t(CAPABILITY_LABEL_KEYS[capability])}</td>
                            <td>
                              {editingRole ? (
                                <select
                                  className="form-input"
                                  value={activeDraft[capability]}
                                  onChange={(event) => setDraft((current) => ({
                                    ...(current || baseline),
                                    [capability]: event.target.value as PermissionEffect,
                                  }))}
                                >
                                  <option value="allow">{t("users_perm_decision_allow")}</option>
                                  <option value="approval_required">{t("users_perm_decision_approval")}</option>
                                  <option value="deny">{t("users_perm_decision_deny")}</option>
                                </select>
                              ) : (
                                <span className={`permission-effect ${effectTone(activeDraft[capability])}`}>
                                  {t(`users_perm_decision_${effectTone(activeDraft[capability])}`)}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {editingRole ? (
              <section className="role-diff">
                <h3>{t("roles_diff_title")}</h3>
                {changes.length === 0 ? (
                  <p>{t("roles_diff_empty")}</p>
                ) : (
                  <>
                    <p>{t("roles_diff_affected", { count: affectedUsers })}</p>
                    {changes.map((capability) => (
                      <div key={capability}>
                        <span>{t(CAPABILITY_LABEL_KEYS[capability])}</span>
                        <strong>{t(`users_perm_decision_${effectTone(baseline[capability])}`)} → {t(`users_perm_decision_${effectTone(activeDraft[capability])}`)}</strong>
                      </div>
                    ))}
                  </>
                )}
              </section>
            ) : null}

            <footer>
              <button type="button" className="btn btn-outline" onClick={closeDetail}>{t("cancel")}</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!editingRole || changes.length === 0}
                onClick={() => setNotice(t("roles_no_api"))}
              >
                {t("save")}
              </button>
            </footer>
          </aside>
        </div>
      ) : null}

      {notice ? <OperationNotice presentation="modal" tone="info" title={t("info")} message={notice} onClose={() => setNotice(null)} /> : null}
      <style dangerouslySetInnerHTML={{ __html: roleStyles }} />
    </>
  );
}

const roleStyles = `
  .roles-page {
    min-height: 100%;
    padding: 24px;
    background: var(--background);
    max-width: 1880px;
    margin: 0 auto;
  }

  .roles-header {
    margin-bottom: 20px;
  }

  .roles-header h1 {
    margin: 0;
    color: var(--text-main);
    font-size: 1.65rem;
    letter-spacing: 0;
  }

  .roles-header p {
    margin: 0.35rem 0 0;
    color: var(--text-muted);
  }

  .roles-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(260px, 1fr));
    gap: 20px;
  }

  .role-card {
    display: grid;
    gap: 1rem;
    padding: 1rem;
    border: 1px solid var(--surface-border);
    border-radius: 8px;
    background: var(--surface);
  }

  .role-card > div:first-child {
    display: grid;
    gap: 0.5rem;
  }

  .role-card strong {
    color: var(--text-main);
  }

  .role-badge,
  .permission-effect {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: max-content;
    min-width: 72px;
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary) 9%, transparent);
    color: var(--primary);
    font-weight: 900;
    font-size: 0.78rem;
  }

  .role-card dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.7rem;
    margin: 0;
  }

  .role-card dl div {
    display: grid;
    gap: 0.12rem;
  }

  .role-card dt {
    color: var(--text-muted);
    font-size: 0.74rem;
  }

  .role-card dd {
    margin: 0;
    color: var(--text-main);
    font-weight: 900;
  }

  .role-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .role-actions .danger {
    color: var(--danger);
  }

  .role-drawer-layer {
    position: fixed;
    inset: 0;
    z-index: 2100;
    display: flex;
    justify-content: flex-end;
  }

  .role-drawer-backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    background: rgba(15, 23, 42, 0.32);
  }

  .role-drawer {
    position: relative;
    width: min(760px, 100vw);
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-left: 1px solid var(--surface-border);
  }

  .role-drawer header,
  .role-drawer footer,
  .role-drawer-tools {
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--surface-border);
  }

  .role-drawer header,
  .role-drawer footer {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .role-drawer h2,
  .role-drawer h3 {
    margin: 0;
    color: var(--text-main);
  }

  .role-drawer p {
    margin: 0.25rem 0 0;
    color: var(--text-muted);
  }

  .role-matrix-scroll {
    flex: 1;
    overflow: auto;
  }

  .role-matrix {
    width: 100%;
    min-width: 680px;
    border-collapse: collapse;
  }

  .role-matrix th,
  .role-matrix td {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--surface-border);
    text-align: left;
    background: var(--surface);
  }

  .role-matrix th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--surface-hover);
    color: var(--text-muted);
    font-size: 0.76rem;
    text-transform: uppercase;
  }

  .role-matrix th:first-child,
  .role-matrix td:first-child {
    position: sticky;
    left: 0;
    z-index: 3;
  }

  .role-group-row button {
    border: 0;
    background: transparent;
    color: var(--primary);
    cursor: pointer;
    font-weight: 900;
  }

  .permission-effect.allow {
    color: var(--success);
    background: rgba(28, 200, 138, 0.12);
  }

  .permission-effect.approval {
    color: #d97706;
    background: rgba(245, 158, 11, 0.14);
  }

  .permission-effect.deny {
    color: var(--danger);
    background: rgba(231, 74, 59, 0.12);
  }

  .role-diff {
    display: grid;
    gap: 0.5rem;
    padding: 1rem 1.25rem;
    border-top: 1px solid var(--surface-border);
    background: var(--surface-hover);
  }

  .role-diff > div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.55rem 0;
    border-top: 1px solid var(--surface-border);
  }

  @media (max-width: 1180px) {
    .roles-grid {
      grid-template-columns: repeat(2, minmax(260px, 1fr));
    }
  }

  @media (max-width: 760px) {
    .roles-grid {
      grid-template-columns: 1fr;
    }
  }
`;
