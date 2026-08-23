"use client";

import { Fragment, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Download, Eye, RefreshCw, RotateCcw, Save, Search, Shield, Users, X } from "lucide-react";
import useSWR from "swr";
import { useI18n } from "@/components/I18nProvider";
import { RoleBadge } from "@/components/iam/RoleBadge";
import { StatusBadge } from "@/components/iam/StatusBadge";
import iamStyles from "@/components/iam/iam.module.css";
import { EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";
import { Dialog } from "@/components/ui/Dialog";
import { useAuth } from "@/hooks/useAuth";
import { toCsvRow } from "@/lib/csv";
import { fetcher } from "@/lib/fetcher";
import { ROLE_CAPABILITIES } from "@/lib/permissions";
import {
  buildPermissionDiff,
  normalizePermissionEffect,
  permissionEffectToDecisionKey,
} from "@/lib/userAccessManagement";
import {
  CAPABILITY_DIMENSION_KEYS,
  CAPABILITY_LABEL_KEYS,
  VALID_ROLES,
  type Capability,
  type PermissionEffect,
  type RoleKey,
  type SysUser,
} from "@/types/iam";
import styles from "./RoleManagementPanel.module.css";

type DraftMatrix = Record<Capability, PermissionEffect>;
type EffectFilter = PermissionEffect | "all";

function effectTone(effect: PermissionEffect) {
  return permissionEffectToDecisionKey(effect);
}

function buildDraft(role: RoleKey): DraftMatrix {
  return Object.fromEntries(
    Object.entries(ROLE_CAPABILITIES[role]).map(([capability, decision]) => [capability, normalizePermissionEffect(decision)]),
  ) as DraftMatrix;
}

function triggerDownload(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function RoleManagementPanel() {
  const { isRoot } = useAuth();
  const { t } = useI18n();
  const { data, error, isLoading, mutate } = useSWR<{ users: SysUser[] }>("/api/auth/users", fetcher);
  const [selectedRole, setSelectedRole] = useState<RoleKey | null>(null);
  const [editingRole, setEditingRole] = useState<RoleKey | null>(null);
  const [draft, setDraft] = useState<DraftMatrix | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [effectFilter, setEffectFilter] = useState<EffectFilter>("all");
  const [onlyConfigured, setOnlyConfigured] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const users = useMemo(() => data?.users || [], [data?.users]);
  const roleCards = useMemo(() => VALID_ROLES.map((role) => {
    const effects = Object.values(ROLE_CAPABILITIES[role]).map(normalizePermissionEffect);
    return {
      role,
      users: users.filter((item) => item.role === role).length,
      configured: effects.filter((effect) => effect !== "deny").length,
      approvals: effects.filter((effect) => effect === "approval_required").length,
    };
  }), [users]);
  const activeRole = selectedRole || "root";
  const baseline = useMemo(() => buildDraft(activeRole), [activeRole]);
  const activeDraft = draft || baseline;
  const changes = buildPermissionDiff(baseline, activeDraft);
  const activeUsers = users.filter((item) => item.role === activeRole);

  const visibleCapabilities = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return (Object.keys(CAPABILITY_LABEL_KEYS) as Capability[]).filter((capability) => {
      const matchesQuery = !query || [t(CAPABILITY_LABEL_KEYS[capability]), t(CAPABILITY_DIMENSION_KEYS[capability]), capability].join(" ").toLowerCase().includes(query);
      const matchesEffect = effectFilter === "all" || VALID_ROLES.some((role) => normalizePermissionEffect(ROLE_CAPABILITIES[role][capability]) === effectFilter);
      return matchesQuery && matchesEffect;
    });
  }, [effectFilter, searchQuery, t]);

  const groupedCapabilities = useMemo(() => {
    const groups = new Map<string, Capability[]>();
    visibleCapabilities.forEach((capability) => {
      if (onlyConfigured && baseline[capability] === "deny") return;
      const group = CAPABILITY_DIMENSION_KEYS[capability];
      groups.set(group, [...(groups.get(group) || []), capability]);
    });
    return Array.from(groups.entries());
  }, [baseline, onlyConfigured, visibleCapabilities]);

  if (!isRoot) {
    return <section className={styles.accessPanel}><EmptyState icon={<Shield size={48} />} title={t("users_access_denied")} description={t("users_access_denied_desc")} /></section>;
  }

  const openRole = (role: RoleKey, edit = false) => {
    setSelectedRole(role);
    setEditingRole(edit ? role : null);
    setDraft(buildDraft(role));
    setCollapsed([]);
    setNotice(null);
  };

  const closeDetail = () => {
    setSelectedRole(null);
    setEditingRole(null);
    setDraft(null);
  };

  const exportMatrix = (format: "csv" | "json") => {
    const date = new Date().toISOString().slice(0, 10);
    if (format === "json") {
      const payload = Object.fromEntries(VALID_ROLES.map((role) => [role, buildDraft(role)]));
      triggerDownload(JSON.stringify(payload, null, 2), `role-permission-matrix-${date}.json`, "application/json;charset=utf-8");
    } else {
      const rows = [
        toCsvRow(["dimension", "capability", ...VALID_ROLES]),
        ...(Object.keys(CAPABILITY_LABEL_KEYS) as Capability[]).map((capability) => toCsvRow([
          t(CAPABILITY_DIMENSION_KEYS[capability]),
          t(CAPABILITY_LABEL_KEYS[capability]),
          ...VALID_ROLES.map((role) => buildDraft(role)[capability]),
        ])),
      ];
      triggerDownload(`\uFEFF${rows.join("\r\n")}`, `role-permission-matrix-${date}.csv`, "text/csv;charset=utf-8");
    }
    setNotice(t("roles_export_ready", { format: format.toUpperCase() }));
  };

  return (
    <>
      <section className={styles.roleGrid} aria-label={t("roles_title")}>
        {isLoading ? <LoadingRows columns={4} rows={3} /> : error ? (
          <EmptyState icon={<Shield size={42} />} title={t("roles_error_title")} description={t("roles_error_desc")} action={<button type="button" className="btn btn-outline" onClick={() => void mutate()}><RefreshCw size={15} />{t("refresh")}</button>} />
        ) : roleCards.map((card) => (
          <article key={card.role} className={styles.roleCard}>
            <div className={styles.roleCardHeader}><RoleBadge role={card.role} /><strong>{t(`roles_desc_${card.role}`)}</strong></div>
            <dl>
              <div><dt>{t("roles_user_count")}</dt><dd><Link className={styles.roleUserLink} href={`/users?role=${card.role}`}>{card.users}<span>{t("roles_view_users")}<ArrowRight size={13} /></span></Link></dd></div>
              <div><dt>{t("roles_permission_count")}</dt><dd>{card.configured}</dd></div>
              <div><dt>{t("roles_approval_count")}</dt><dd>{card.approvals}</dd></div>
              <div><dt>{t("roles_builtin")}</dt><dd>{t("yes")}</dd></div>
            </dl>
            <div className={styles.roleActions}>
              <button type="button" className="btn btn-outline" onClick={() => openRole(card.role)}><Eye size={15} />{t("roles_view_permissions")}</button>
              <button type="button" className="btn btn-outline" onClick={() => openRole(card.role, true)}><Save size={15} />{t("edit")}</button>
            </div>
          </article>
        ))}
      </section>

      <section className={styles.compareSection}>
        <header className={styles.compareHeader}>
          <div><span>{t("eyebrow_rbac_matrix")}</span><h2>{t("roles_compare_title")}</h2><p>{t("roles_compare_desc")}</p></div>
          <div className={styles.exportActions}>
            <button type="button" className="btn btn-outline" onClick={() => exportMatrix("csv")}><Download size={15} />{t("roles_export_csv")}</button>
            <button type="button" className="btn btn-outline" onClick={() => exportMatrix("json")}><Download size={15} />{t("roles_export_json")}</button>
          </div>
        </header>
        <div className={styles.matrixTools}>
          <label className={styles.search}><Search size={16} /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t("roles_search_placeholder")} aria-label={t("roles_search_placeholder")} /></label>
          <label><span>{t("roles_effect_filter")}</span><select className="form-input" value={effectFilter} onChange={(event) => setEffectFilter(event.target.value as EffectFilter)}><option value="all">{t("roles_effect_all")}</option><option value="allow">{t("users_perm_decision_allow")}</option><option value="approval_required">{t("users_perm_decision_approval")}</option><option value="deny">{t("users_perm_decision_deny")}</option></select></label>
        </div>
        <div className={styles.matrixScroll}>
          <table className={styles.compareMatrix}>
            <caption className="sr-only">{t("roles_matrix_title")}</caption>
            <thead><tr><th data-column-priority="essential">{t("roles_matrix_module")}</th><th data-column-priority="essential">{t("roles_matrix_action")}</th>{VALID_ROLES.map((role) => <th key={role} data-column-priority={role === "root" ? "essential" : role === "operator" ? "important" : "supplementary"}><RoleBadge role={role} /></th>)}</tr></thead>
            <tbody>
              {visibleCapabilities.map((capability) => (
                <tr key={capability}>
                  <td data-label={t("roles_matrix_module")} data-column-priority="essential">{t(CAPABILITY_DIMENSION_KEYS[capability])}</td>
                  <td data-label={t("roles_matrix_action")} data-column-priority="essential"><strong>{t(CAPABILITY_LABEL_KEYS[capability])}</strong><small>{capability}</small></td>
                  {VALID_ROLES.map((role) => {
                    const effect = normalizePermissionEffect(ROLE_CAPABILITIES[role][capability]);
                    const tone = effectTone(effect);
                    return <td key={role} data-label={t(`users_${role}`)} data-column-priority={role === "root" ? "essential" : role === "operator" ? "important" : "supplementary"}><span className={`${iamStyles.decision} ${iamStyles[tone]}`}>{t(`users_perm_decision_${tone}`)}</span></td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedRole ? (
        <Dialog open onClose={closeDetail} overlayClassName={styles.drawerLayer} className={styles.drawer} labelledBy={dialogTitleId} describedBy={dialogDescriptionId} initialFocusRef={closeButtonRef}>
          <header className={styles.drawerHeader}>
            <div><RoleBadge role={activeRole} /><div><h2 id={dialogTitleId}>{t(`users_${activeRole}`)}</h2><p id={dialogDescriptionId}>{editingRole ? t("roles_edit_readonly_hint") : t("roles_matrix_subtitle")}</p></div></div>
            <button ref={closeButtonRef} type="button" className="btn-icon" onClick={closeDetail} aria-label={t("close")}><X size={18} /></button>
          </header>
          <section className={styles.roleUsers}>
            <div><Users size={17} /><strong>{t("roles_user_list", { count: activeUsers.length })}</strong></div>
            {activeUsers.length ? <ul>{activeUsers.map((user) => <li key={user.username}><Link href={`/users?role=${activeRole}&user=${encodeURIComponent(user.username)}`}>{user.username}<ArrowRight size={13} /></Link><StatusBadge status={user.status} locked={user.locked} /></li>)}</ul> : <p>{t("roles_user_empty")}</p>}
          </section>
          <div className={styles.drawerTools}><label><input type="checkbox" checked={onlyConfigured} onChange={(event) => setOnlyConfigured(event.target.checked)} />{t("roles_only_configured")}</label></div>
          <div className={styles.drawerMatrixScroll}>
            <table className={styles.drawerMatrix}>
              <caption className="sr-only">{t("roles_matrix_title")}</caption>
              <thead><tr><th data-column-priority="essential">{t("roles_matrix_module")}</th><th data-column-priority="essential">{t("roles_matrix_action")}</th><th data-column-priority="important">{t("roles_matrix_effect")}</th></tr></thead>
              <tbody>{groupedCapabilities.map(([group, capabilities]) => {
                const groupCollapsed = collapsed.includes(group);
                return (
                  <Fragment key={group}>
                    <tr className={styles.groupRow}><td colSpan={3}><button type="button" onClick={() => setCollapsed((current) => current.includes(group) ? current.filter((item) => item !== group) : [...current, group])}>{t(group)} · {capabilities.length}</button></td></tr>
                    {groupCollapsed ? null : capabilities.map((capability) => {
                      const tone = effectTone(activeDraft[capability]);
                      return (
                        <tr key={capability}>
                          <td data-label={t("roles_matrix_module")} data-column-priority="essential">{t(group)}</td>
                          <td data-label={t("roles_matrix_action")} data-column-priority="essential">{t(CAPABILITY_LABEL_KEYS[capability])}</td>
                          <td data-label={t("roles_matrix_effect")} data-column-priority="important">{editingRole ? <select className="form-input" value={activeDraft[capability]} onChange={(event) => setDraft((current) => ({ ...(current || baseline), [capability]: event.target.value as PermissionEffect }))}><option value="allow">{t("users_perm_decision_allow")}</option><option value="approval_required">{t("users_perm_decision_approval")}</option><option value="deny">{t("users_perm_decision_deny")}</option></select> : <span className={`${iamStyles.decision} ${iamStyles[tone]}`}>{t(`users_perm_decision_${tone}`)}</span>}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}</tbody>
            </table>
          </div>
          {editingRole ? (
            <section className={styles.diff}>
              <div className={styles.diffHeader}><div><h3>{t("roles_diff_title")}</h3><p>{changes.length ? t("roles_diff_affected", { count: activeUsers.length }) : t("roles_diff_empty")}</p></div><button type="button" className="btn btn-outline" onClick={() => setDraft(buildDraft(activeRole))} disabled={changes.length === 0}><RotateCcw size={15} />{t("roles_reset_draft")}</button></div>
              {changes.map((change) => { const capability = change.key as Capability; return <div key={change.key}><span>{t(CAPABILITY_LABEL_KEYS[capability])} · {t(`roles_diff_category_${change.category}`)}</span><strong>{t(`users_perm_decision_${effectTone(change.before)}`)} → {t(`users_perm_decision_${effectTone(change.after)}`)}</strong></div>; })}
            </section>
          ) : null}
          <footer className={styles.drawerFooter}><button type="button" className="btn btn-outline" onClick={closeDetail}>{t("cancel")}</button><button type="button" className="btn btn-primary" disabled={!editingRole || changes.length === 0} onClick={() => setNotice(t("roles_no_api"))}>{t("save")}</button></footer>
        </Dialog>
      ) : null}

      {notice ? <OperationNotice presentation="modal" tone="info" title={t("info")} message={notice} onClose={() => setNotice(null)} /> : null}
    </>
  );
}
