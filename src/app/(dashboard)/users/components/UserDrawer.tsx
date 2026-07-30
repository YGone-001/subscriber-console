import { useI18n } from "@/components/I18nProvider";
import { type Capability } from "@/lib/permissions";
import { 
  Plus, X, Save, Shield, RefreshCw, CheckCircle2, Clock, Trash2, Settings
} from "lucide-react";
import { OperationNotice, ConfirmActionPanel, LoadingRows, EmptyState } from "@/components/OperationFeedback";
import * as T from "../types";
import { VALID_ROLES, VALID_STATUS, RoleKey, UserStatus } from "../types";
import { displayValue, formatDateTime, normalizeRole } from "../utils";

export function UserDrawer(props: any) {
  const { t } = useI18n();
  const {
    notice, setNotice, pendingDeleteUsername, savingAction, confirmReason,
    executeDelete, resetConfirmState, setConfirmReason, pendingStatusChange,
    executeStatusChange, pendingBulkAction, executeBulkAction, pendingUpdate,
    selectedUser, submitUpdate, drawerMode, closeDrawer, drawerRef,
    newForm, setNewForm, newPasswordVisible, setNewPasswordVisible,
    newConfirmPasswordVisible, setNewConfirmPasswordVisible, handleCreate,
    detailTabs, detailTab, setDetailTab, editForm, setEditForm,
    isProtectedUser, editPasswordVisible, setEditPasswordVisible,
    handleUpdate, openDetails, startEdit, handleDelete, renderPasswordInput,
    renderRoleBadge, renderStatusBadge, ROLE_CAPABILITIES, CAPABILITY_LABEL_KEYS,
    mapCapabilityDecision, isAuditLoading, auditError, mutateAudit, auditData
  } = props;

  return (
    <>
      {notice ? (
        <OperationNotice
          presentation="modal"
          tone={notice.type === "success" ? "success" : notice.type === "info" ? "info" : "danger"}
          title={notice.type === "success" ? t("success") : notice.type === "info" ? t("info") : t("error")}
          message={notice.text}
          onClose={() => setNotice(null)}
        />
      ) : null}

      {pendingDeleteUsername ? (
        <ConfirmActionPanel
          presentation="modal"
          title={t("users_delete_confirm", { username: pendingDeleteUsername })}
          message={t("users_delete_desc")}
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          isWorking={savingAction === `delete:${pendingDeleteUsername}`}
          confirmDisabled={confirmReason.trim().length < 3}
          onConfirm={executeDelete}
          onCancel={resetConfirmState}
        >
          <div className="users-confirm-details">
            <span>{t("users_confirm_object", { target: pendingDeleteUsername })}</span>
            <span>{t("users_confirm_approval_none")}</span>
            <span>{t("users_confirm_irreversible_yes")}</span>
            <label>
              {t("users_confirm_reason")}
              <textarea value={confirmReason} onChange={(event) => setConfirmReason(event.target.value)} rows={3} />
            </label>
          </div>
        </ConfirmActionPanel>
      ) : null}

      {pendingStatusChange ? (
        <ConfirmActionPanel
          presentation="modal"
          tone={pendingStatusChange.status === "disabled" ? "warning" : "info"}
          title={t("users_status_confirm", { username: pendingStatusChange.username })}
          message={t(pendingStatusChange.status === "disabled" ? "users_status_disable_desc" : "users_status_enable_desc")}
          confirmLabel={pendingStatusChange.status === "disabled" ? t("users_disable_account") : t("users_enable_account")}
          cancelLabel={t("cancel")}
          isWorking={savingAction === `status:${pendingStatusChange.username}`}
          confirmDisabled={confirmReason.trim().length < 3}
          onConfirm={executeStatusChange}
          onCancel={resetConfirmState}
        >
          <div className="users-confirm-details">
            <span>{t("users_confirm_object", { target: pendingStatusChange.username })}</span>
            <span>{t("users_confirm_approval_none")}</span>
            <span>{t("users_confirm_irreversible_no")}</span>
            <label>
              {t("users_confirm_reason")}
              <textarea value={confirmReason} onChange={(event) => setConfirmReason(event.target.value)} rows={3} />
            </label>
          </div>
        </ConfirmActionPanel>
      ) : null}

      {pendingBulkAction ? (
        <ConfirmActionPanel
          presentation="modal"
          tone={pendingBulkAction.action === "delete" || pendingBulkAction.action === "disable" ? "warning" : "info"}
          title={t(`users_bulk_confirm_${pendingBulkAction.action}`)}
          message={t("users_bulk_confirm_desc", { count: pendingBulkAction.usernames.length })}
          confirmLabel={t("confirm")}
          cancelLabel={t("cancel")}
          isWorking={savingAction === `bulk:${pendingBulkAction.action}`}
          confirmDisabled={confirmReason.trim().length < 3}
          onConfirm={executeBulkAction}
          onCancel={resetConfirmState}
        >
          <div className="users-confirm-details">
            <span>{t("users_confirm_object", { target: pendingBulkAction.usernames.join(", ") })}</span>
            <span>{pendingBulkAction.action === "assignRole" && pendingBulkAction.role === "root" ? t("users_confirm_root_role") : t("users_confirm_approval_none")}</span>
            <span>{pendingBulkAction.action === "delete" ? t("users_confirm_irreversible_yes") : t("users_confirm_irreversible_no")}</span>
            <label>
              {t("users_confirm_reason")}
              <textarea value={confirmReason} onChange={(event) => setConfirmReason(event.target.value)} rows={3} />
            </label>
          </div>
        </ConfirmActionPanel>
      ) : null}

      {pendingUpdate && selectedUser ? (
        <ConfirmActionPanel
          presentation="modal"
          tone={pendingUpdate.payload.role === "root" || pendingUpdate.payload.status === "disabled" ? "warning" : "info"}
          title={t("users_update_confirm", { username: pendingUpdate.username })}
          message={pendingUpdate.impact}
          confirmLabel={t("confirm")}
          cancelLabel={t("cancel")}
          isWorking={savingAction === `update:${pendingUpdate.username}`}
          confirmDisabled={confirmReason.trim().length < 3}
          onConfirm={() => void submitUpdate(selectedUser, pendingUpdate.payload, confirmReason.trim())}
          onCancel={resetConfirmState}
        >
          <div className="users-confirm-details">
            <span>{t("users_confirm_object", { target: pendingUpdate.username })}</span>
            <span>{pendingUpdate.payload.role === "root" ? t("users_confirm_root_role") : t("users_confirm_approval_none")}</span>
            <span>{t("users_confirm_irreversible_no")}</span>
            <label>
              {t("users_confirm_reason")}
              <textarea value={confirmReason} onChange={(event) => setConfirmReason(event.target.value)} rows={3} />
            </label>
          </div>
        </ConfirmActionPanel>
      ) : null}

      {drawerMode !== "closed" ? (
        <div className="users-drawer-layer" role="dialog" aria-modal="true" aria-label={t("users_drawer_title")}>
          <button type="button" className="users-drawer-backdrop" aria-label={t("cancel")} onClick={closeDrawer} />
          <aside className="users-drawer" ref={drawerRef}>
            <header className="users-drawer-header">
              <div>
                <span className="users-avatar large">
                  {drawerMode === "create" ? <Plus size={20} /> : selectedUser?.username.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <h2>{drawerMode === "create" ? t("users_drawer_create_title") : selectedUser?.username}</h2>
                  <p>{drawerMode === "create" ? t("users_create_panel_desc") : t("users_drawer_subtitle")}</p>
                </div>
              </div>
              <button type="button" className="btn-icon" onClick={closeDrawer} aria-label={t("cancel")} title={t("cancel")}>
                <X size={18} />
              </button>
            </header>

            {drawerMode === "create" ? (
              <div className="users-drawer-body">
                <section className="users-form-section">
                  <h3>{t("users_form_basic")}</h3>
                  <label>
                    <span>{t("users_username")}</span>
                    <input
                      type="text"
                      className="form-input"
                      value={newForm.username}
                      onChange={(event) => setNewForm((current: any) => ({ ...current, username: event.target.value }))}
                      autoFocus
                    />
                  </label>
                </section>
                <section className="users-form-section">
                  <h3>{t("users_form_role")}</h3>
                  <label>
                    <span>{t("users_role")}</span>
                    <select
                      className="form-input"
                      value={newForm.role}
                      onChange={(event) => setNewForm((current: any) => ({ ...current, role: event.target.value as T.RoleKey }))}
                    >
                      {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
                    </select>
                  </label>
                </section>
                <section className="users-form-section">
                  <h3>{t("users_form_security")}</h3>
                  <label>
                    <span>{t("users_password_new")}</span>
                    {renderPasswordInput(
                      newForm.password,
                      (password: string) => setNewForm((current: any) => ({ ...current, password })),
                      newPasswordVisible,
                      setNewPasswordVisible,
                      t("users_password_new"),
                    )}
                  </label>
                  <label>
                    <span>{t("users_password_confirm")}</span>
                    {renderPasswordInput(
                      newForm.confirmPassword,
                      (confirmPassword: string) => setNewForm((current: any) => ({ ...current, confirmPassword })),
                      newConfirmPasswordVisible,
                      setNewConfirmPasswordVisible,
                      t("users_password_confirm"),
                      () => {
                        if (savingAction !== "create") void handleCreate();
                      },
                    )}
                  </label>
                </section>
              </div>
            ) : selectedUser ? (
              <>
                {drawerMode === "view" ? (
                  <nav className="users-drawer-tabs" aria-label={t("users_drawer_tabs")}>
                    {detailTabs.map((tab: any) => (
                      <button
                        key={tab.key}
                        type="button"
                        className={detailTab === tab.key ? "active" : undefined}
                        onClick={() => setDetailTab(tab.key)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </nav>
                ) : null}

                <div className="users-drawer-body">
                  {drawerMode === "edit" ? (
                    <>
                      <section className="users-form-section">
                        <h3>{t("users_form_basic")}</h3>
                        <label>
                          <span>{t("users_username")}</span>
                          <input type="text" className="form-input" value={selectedUser.username} disabled />
                        </label>
                      </section>
                      <section className="users-form-section">
                        <h3>{t("users_form_role")}</h3>
                        <label>
                          <span>{t("users_role")}</span>
                          <select
                            className="form-input"
                            value={editForm.role}
                            onChange={(event) => setEditForm((current: any) => ({ ...current, role: event.target.value as T.RoleKey }))}
                            disabled={isProtectedUser(selectedUser)}
                          >
                            {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
                          </select>
                        </label>
                        <label>
                          <span>{t("users_status")}</span>
                          <select
                            className="form-input"
                            value={editForm.status}
                            onChange={(event) => setEditForm((current: any) => ({ ...current, status: event.target.value as T.UserStatus }))}
                            disabled={isProtectedUser(selectedUser)}
                          >
                            {VALID_STATUS.map((status) => <option key={status} value={status}>{t(`users_${status}`)}</option>)}
                          </select>
                        </label>
                      </section>
                      <section className="users-form-section">
                        <h3>{t("users_form_security")}</h3>
                        <label>
                          <span>{t("users_password_optional")}</span>
                          {renderPasswordInput(
                            editForm.password,
                            (password: string) => setEditForm((current: any) => ({ ...current, password })),
                            editPasswordVisible,
                            setEditPasswordVisible,
                            t("users_password_optional"),
                            () => {
                              if (savingAction !== `update:${selectedUser.username}`) void handleUpdate();
                            },
                          )}
                        </label>
                      </section>
                    </>
                  ) : detailTab === "basic" ? (
                    <section className="users-detail-section">
                      <h3>{t("users_detail_tab_basic")}</h3>
                      <dl>
                        <div>
                          <dt>{t("users_username")}</dt>
                          <dd>{selectedUser.username}</dd>
                        </div>
                        <div>
                          <dt>{t("users_display_name")}</dt>
                          <dd>{displayValue(selectedUser.displayName)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_email")}</dt>
                          <dd>{displayValue(selectedUser.email)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_role")}</dt>
                          <dd>{renderRoleBadge(selectedUser.role)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_status")}</dt>
                          <dd>{renderStatusBadge(selectedUser.status, selectedUser.locked)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_detail_created_at")}</dt>
                          <dd>{formatDateTime(selectedUser.createdAt)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_detail_created_by")}</dt>
                          <dd>{displayValue(selectedUser.createdBy)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_last_login")}</dt>
                          <dd>{formatDateTime(selectedUser.lastLoginAt)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_last_login_ip")}</dt>
                          <dd>{displayValue(selectedUser.lastLoginIp)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_account_note")}</dt>
                          <dd>{displayValue(selectedUser.description)}</dd>
                        </div>
                      </dl>
                    </section>
                  ) : detailTab === "permissions" ? (
                    <section className="users-detail-section">
                      <h3>{t("users_detail_tab_permissions")}</h3>
                      <div className="users-permission-summary">
                        <span>{t("users_effective_role")}</span>
                        {renderRoleBadge(selectedUser.role)}
                        <small>{t("users_no_user_overrides")}</small>
                      </div>
                      <div className="users-permission-list">
                        {(Object.keys(ROLE_CAPABILITIES[normalizeRole(selectedUser.role)]) as Capability[]).map((capability) => {
                          const decision = mapCapabilityDecision(ROLE_CAPABILITIES[normalizeRole(selectedUser.role)][capability]);
                          return (
                            <div key={capability}>
                              <span>{t(CAPABILITY_LABEL_KEYS[capability])}</span>
                              <span className={`users-permission-decision ${decision}`}>{t(`users_perm_decision_${decision}`)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ) : detailTab === "login" ? (
                    selectedUser.lastLoginAt ? (
                      <section className="users-detail-section">
                        <h3>{t("users_detail_tab_login")}</h3>
                        <div className="users-record-list">
                          <div>
                            <span>{formatDateTime(selectedUser.lastLoginAt)}</span>
                            <small>{displayValue(selectedUser.lastLoginIp)} · {displayValue(selectedUser.userAgent)}</small>
                            <strong>{t("users_login_success")}</strong>
                          </div>
                        </div>
                      </section>
                    ) : (
                      <EmptyState icon={<Clock size={42} />} title={t("users_no_data_title")} description={t("users_no_login_data_desc")} />
                    )
                  ) : isAuditLoading ? (
                    <LoadingRows columns={5} rows={4} />
                  ) : auditError ? (
                    <EmptyState
                      icon={<Shield size={42} />}
                      title={t("users_audit_error_title")}
                      description={t("users_audit_error_desc")}
                      action={
                        <button type="button" className="btn btn-outline" onClick={() => void mutateAudit()}>
                          <RefreshCw size={15} />
                          {t("refresh")}
                        </button>
                      }
                    />
                  ) : auditData?.logs.length ? (
                    <section className="users-detail-section">
                      <h3>{t("users_detail_tab_activity")}</h3>
                      <div className="users-record-list">
                        {auditData.logs.map((log: any) => (
                          <div key={log.id}>
                            <span>{formatDateTime(log.timestamp)}</span>
                            <small>{log.action} · {log.targetId}</small>
                            <strong>{log.level} · {displayValue(log.operatorIp)} · {log.id}</strong>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : (
                    <EmptyState icon={<CheckCircle2 size={42} />} title={t("users_no_data_title")} description={t("users_no_activity_data_desc")} />
                  )}
                </div>
              </>
            ) : null}

            <footer className="users-drawer-footer">
              {drawerMode === "create" ? (
                <>
                  <button type="button" className="btn btn-outline" onClick={closeDrawer} disabled={savingAction === "create"}>
                    <X size={15} />
                    {t("cancel")}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={savingAction === "create"}>
                    {savingAction === "create" ? <span className="spinner" /> : <Save size={15} />}
                    {t("save")}
                  </button>
                </>
              ) : drawerMode === "edit" && selectedUser ? (
                <>
                  <button type="button" className="btn btn-outline" onClick={() => openDetails(selectedUser)} disabled={savingAction === `update:${selectedUser.username}`}>
                    <X size={15} />
                    {t("cancel")}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleUpdate} disabled={savingAction === `update:${selectedUser.username}`}>
                    {savingAction === `update:${selectedUser.username}` ? <span className="spinner" /> : <Save size={15} />}
                    {t("save")}
                  </button>
                </>
              ) : selectedUser ? (
                <>
                  <button
                    type="button"
                    className="btn btn-outline users-danger-action"
                    onClick={() => handleDelete(selectedUser.username)}
                    disabled={isProtectedUser(selectedUser) || pendingDeleteUsername != null}
                  >
                    <Trash2 size={15} />
                    {t("delete")}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={() => startEdit(selectedUser)}>
                    <Settings size={15} />
                    {t("edit")}
                  </button>
                </>
              ) : null}
            </footer>
          </aside>
        </div>
      ) : null}


    </>
  );
}
