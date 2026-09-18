import { useId, useRef } from "react";
import { KeyRound, Plus, Save, Settings, UserPlus, X } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import iamStyles from "@/components/iam/iam.module.css";
import { OperationNotice } from "@/components/OperationFeedback";
import { Dialog } from "@/components/ui/Dialog";
import type { DetailTab } from "../types";
import { UserActivityLog } from "./UserActivityLog";
import { BulkProgressModal } from "./BulkProgressModal";
import { UserBasicInfo } from "./UserBasicInfo";
import { UserConfirmDialogs } from "./UserConfirmDialogs";
import { UserCreateForm } from "./UserCreateForm";
import { UserEditForm } from "./UserEditForm";
import { UserLoginHistory } from "./UserLoginHistory";
import { UserPermissions } from "./UserPermissions";
import { UserPasswordResetForm } from "./UserPasswordResetForm";
import type { UserDrawerProps } from "./types";
import styles from "./UserDrawer.module.css";

const DETAIL_TABS: Array<{ key: DetailTab; labelKey: string }> = [
  { key: "basic", labelKey: "users_detail_tab_basic" },
  { key: "permissions", labelKey: "users_detail_tab_permissions" },
  { key: "login", labelKey: "users_security_state" },
  { key: "activity", labelKey: "users_detail_tab_activity" },
];

export function UserDrawer(props: UserDrawerProps) {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const selectedUser = props.selectedUser;
  const shouldOpen = props.drawerMode === "create" || (props.drawerMode !== "closed" && selectedUser != null);
  const isPasswordReset = props.drawerMode === "resetPassword";

  return (
    <>
      {props.notice ? (
        <OperationNotice
          presentation="modal"
          tone={props.notice.type === "success" ? "success" : props.notice.type === "info" ? "info" : "danger"}
          title={props.notice.type === "success" ? t("success") : props.notice.type === "info" ? t("info") : t("error")}
          message={props.notice.text}
          onClose={() => props.setNotice(null)}
        />
      ) : null}
      <UserConfirmDialogs {...props} />
      {props.bulkProgress ? <BulkProgressModal progress={props.bulkProgress} onCancel={props.cancelBulkAction} onClose={props.closeBulkProgress} /> : null}

      {shouldOpen ? (
        <Dialog
          open
          onClose={props.closeDrawer}
          overlayClassName={styles.drawerLayer}
          className={styles.drawer}
          labelledBy={titleId}
          describedBy={descriptionId}
          initialFocusRef={closeButtonRef}
        >
          <header className={styles.drawerHeader}>
            <div>
              <span className={`${iamStyles.avatar} ${iamStyles.avatarLarge}`}>
                {props.drawerMode === "create" ? <Plus size={20} /> : selectedUser?.username.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <h2 id={titleId}>{props.drawerMode === "create" ? t("users_drawer_create_title") : isPasswordReset ? t("users_reset_password") : selectedUser?.username}</h2>
                <p id={descriptionId}>{props.drawerMode === "create" ? t("users_create_panel_desc") : isPasswordReset ? t("users_reset_password_desc", { username: selectedUser?.username || "" }) : t("users_drawer_subtitle")}</p>
              </div>
            </div>
            <button ref={closeButtonRef} type="button" className="btn-icon" onClick={props.closeDrawer} aria-label={t("cancel")} title={t("cancel")}><X size={18} /></button>
          </header>

          {props.drawerMode === "create" ? (
            <UserCreateForm {...props} />
          ) : selectedUser ? (
            <>
              {props.drawerMode === "view" ? (
                <nav className={styles.drawerTabs} aria-label={t("users_drawer_tabs")}>
                  {DETAIL_TABS.map((tab) => <button key={tab.key} type="button" className={props.detailTab === tab.key ? styles.activeTab : undefined} onClick={() => props.setDetailTab(tab.key)}>{t(tab.labelKey)}</button>)}
                </nav>
              ) : null}
              <div className={styles.drawerBody}>
                {props.drawerMode === "edit" ? (
                  <UserEditForm {...props} />
                ) : props.drawerMode === "resetPassword" ? (
                  <UserPasswordResetForm {...props} />
                ) : props.detailTab === "basic" ? (
                  <UserBasicInfo user={selectedUser} />
                ) : props.detailTab === "permissions" ? (
                  <UserPermissions user={selectedUser} />
                ) : props.detailTab === "login" ? (
                  <UserLoginHistory user={selectedUser} />
                ) : (
                  <UserActivityLog {...props} />
                )}
              </div>
            </>
          ) : null}

          <footer className={styles.drawerFooter}>
            {props.drawerMode === "create" ? (
              <>
                <button type="button" className="btn btn-outline" onClick={props.closeDrawer} disabled={props.savingAction === "create"}><X size={15} />{t("cancel")}</button>
                <button type="button" className="btn btn-primary" onClick={() => void props.handleCreate()} disabled={props.savingAction === "create"}>{props.savingAction === "create" ? <span className="spinner" /> : <UserPlus size={15} />}{t("users_create_action")}</button>
              </>
            ) : props.drawerMode === "resetPassword" && selectedUser ? (
              <>
                <button type="button" className="btn btn-outline" onClick={() => props.openDetails(selectedUser)} disabled={props.savingAction === `update:${selectedUser.username}`}><X size={15} />{t("cancel")}</button>
                <button type="button" className="btn btn-primary" onClick={() => void props.handlePasswordReset()} disabled={props.savingAction === `update:${selectedUser.username}`}><KeyRound size={15} />{t("users_reset_password")}</button>
              </>
            ) : props.drawerMode === "edit" && selectedUser ? (
              <>
                <button type="button" className="btn btn-outline" onClick={() => props.openDetails(selectedUser)} disabled={props.savingAction === `update:${selectedUser.username}`}><X size={15} />{t("cancel")}</button>
                <button type="button" className="btn btn-primary" onClick={() => void props.handleUpdate()} disabled={props.savingAction === `update:${selectedUser.username}`}>{props.savingAction === `update:${selectedUser.username}` ? <span className="spinner" /> : <Save size={15} />}{t("save")}</button>
              </>
            ) : selectedUser && props.canManage(selectedUser, 'update') ? (
              <button type="button" className="btn btn-primary" onClick={() => props.startEdit(selectedUser)}><Settings size={15} />{t("edit")}</button>
            ) : null}
          </footer>
        </Dialog>
      ) : null}
    </>
  );
}
