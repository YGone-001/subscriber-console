import { useI18n } from "@/components/I18nProvider";
import { PasswordField } from "@/components/iam/PasswordField";
import { VALID_ROLES, VALID_STATUS, type RoleKey, type UserStatus } from "../types";
import type { UserDrawerProps } from "./types";
import styles from "./UserDrawer.module.css";

type UserEditFormProps = Pick<UserDrawerProps, "selectedUser" | "editForm" | "setEditForm" | "isProtectedUser" | "editPasswordVisible" | "setEditPasswordVisible" | "savingAction" | "handleUpdate">;

export function UserEditForm(props: UserEditFormProps) {
  const { t } = useI18n();
  const user = props.selectedUser;
  if (!user) return null;
  const protectedUser = props.isProtectedUser(user);
  return (
    <>
      <section className={styles.formSection}><h3>{t("users_form_basic")}</h3><label><span>{t("users_username")}</span><input type="text" className="form-input" value={user.username} disabled /></label></section>
      <section className={styles.formSection}>
        <h3>{t("users_form_role")}</h3>
        <label><span>{t("users_role")}</span><select className="form-input" value={props.editForm.role} onChange={(event) => props.setEditForm((current) => ({ ...current, role: event.target.value as RoleKey }))} disabled={protectedUser}>{VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}</select></label>
        <label><span>{t("users_status")}</span><select className="form-input" value={props.editForm.status} onChange={(event) => props.setEditForm((current) => ({ ...current, status: event.target.value as UserStatus }))} disabled={protectedUser}>{VALID_STATUS.map((status) => <option key={status} value={status}>{t(`users_${status}`)}</option>)}</select></label>
      </section>
      <section className={styles.formSection}>
        <h3>{t("users_form_security")}</h3>
        <PasswordField id="edit-user-password" label={t("users_password_optional")} value={props.editForm.password} onChange={(password) => props.setEditForm((current) => ({ ...current, password }))} visible={props.editPasswordVisible} setVisible={props.setEditPasswordVisible} placeholder={t("users_password_optional")} autoComplete="new-password" onEnter={() => { if (props.savingAction !== `update:${user.username}`) void props.handleUpdate(); }} />
      </section>
    </>
  );
}
