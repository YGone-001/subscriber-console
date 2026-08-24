import { useI18n } from "@/components/I18nProvider";
import { ConfirmActionPanel } from "@/components/OperationFeedback";
import type { UserDrawerProps } from "./types";
import styles from "./UserDrawer.module.css";

type UserConfirmDialogsProps = Pick<
  UserDrawerProps,
  | "savingAction"
  | "confirmReason"
  | "resetConfirmState"
  | "setConfirmReason"
  | "pendingStatusChange"
  | "executeStatusChange"
  | "pendingBulkAction"
  | "executeBulkAction"
  | "pendingUpdate"
  | "selectedUser"
  | "submitUpdate"
>;

interface ConfirmDetailsProps {
  target: string;
  approval: string;
  irreversible: string;
  reason: string;
  setReason: (reason: string) => void;
}

function ConfirmDetails({ target, approval, irreversible, reason, setReason }: ConfirmDetailsProps) {
  const { t } = useI18n();
  return (
    <div className={styles.confirmDetails}>
      <span>{t("users_confirm_object", { target })}</span>
      <span>{approval}</span>
      <span>{irreversible}</span>
      <label>{t("users_confirm_reason")}<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} /></label>
    </div>
  );
}

export function UserConfirmDialogs(props: UserConfirmDialogsProps) {
  const { t } = useI18n();
  const pendingUpdate = props.pendingUpdate;
  const selectedUser = props.selectedUser;
  return (
    <>
      {props.pendingStatusChange ? (
        <ConfirmActionPanel
          presentation="modal"
          tone={props.pendingStatusChange.status === "disabled" ? "warning" : "info"}
          title={t("users_status_confirm", { username: props.pendingStatusChange.username })}
          message={t(props.pendingStatusChange.status === "disabled" ? "users_status_disable_desc" : "users_status_enable_desc")}
          confirmLabel={props.pendingStatusChange.status === "disabled" ? t("users_disable_account") : t("users_enable_account")}
          cancelLabel={t("cancel")}
          isWorking={props.savingAction === `status:${props.pendingStatusChange.username}`}
          confirmDisabled={props.confirmReason.trim().length < 3}
          onConfirm={props.executeStatusChange}
          onCancel={props.resetConfirmState}
        >
          <ConfirmDetails target={props.pendingStatusChange.username} approval={t("users_confirm_approval_none")} irreversible={t("users_confirm_irreversible_no")} reason={props.confirmReason} setReason={props.setConfirmReason} />
        </ConfirmActionPanel>
      ) : null}

      {props.pendingBulkAction ? (
        <ConfirmActionPanel
          presentation="modal"
          tone={props.pendingBulkAction.action === "disable" ? "warning" : "info"}
          title={t(`users_bulk_confirm_${props.pendingBulkAction.action}`)}
          message={t("users_bulk_confirm_desc", { count: props.pendingBulkAction.usernames.length })}
          confirmLabel={t("confirm")}
          cancelLabel={t("cancel")}
          isWorking={props.savingAction === `bulk:${props.pendingBulkAction.action}`}
          confirmDisabled={props.confirmReason.trim().length < 3}
          onConfirm={props.executeBulkAction}
          onCancel={props.resetConfirmState}
        >
          <ConfirmDetails
            target={props.pendingBulkAction.usernames.join(", ")}
            approval={props.pendingBulkAction.action === "assignRole" && props.pendingBulkAction.role === "root" ? t("users_confirm_root_role") : t("users_confirm_approval_none")}
            irreversible={t("users_confirm_irreversible_no")}
            reason={props.confirmReason}
            setReason={props.setConfirmReason}
          />
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
          isWorking={props.savingAction === `update:${pendingUpdate.username}`}
          confirmDisabled={props.confirmReason.trim().length < 3}
          onConfirm={() => props.submitUpdate(selectedUser, pendingUpdate.payload, props.confirmReason.trim())}
          onCancel={props.resetConfirmState}
        >
          <ConfirmDetails
            target={pendingUpdate.username}
            approval={pendingUpdate.payload.role === "root" ? t("users_confirm_root_role") : t("users_confirm_approval_none")}
            irreversible={t("users_confirm_irreversible_no")}
            reason={props.confirmReason}
            setReason={props.setConfirmReason}
          />
        </ConfirmActionPanel>
      ) : null}
    </>
  );
}
