import { useI18n } from "@/components/I18nProvider";
import { PasswordField } from "@/components/iam/PasswordField";
import { Info } from "lucide-react";
import { type RoleKey } from "../types";
import { PasswordStrengthBar } from "./PasswordStrengthBar";
import { UsernameField } from "./UsernameField";
import type { UserDrawerProps } from "./types";
import styles from "./UserDrawer.module.css";

type UserCreateFormProps = Pick<UserDrawerProps, "newForm" | "setNewForm" | "newPasswordVisible" | "setNewPasswordVisible" | "newConfirmPasswordVisible" | "setNewConfirmPasswordVisible" | "handleCreate" | "savingAction" | "usernameAvailability" | "checkUsernameAvailability" | "resetUsernameAvailability" | "assignableRoles">;

export function UserCreateForm(props: UserCreateFormProps) {
  const { t } = useI18n();
  return (
    <div className={styles.drawerBody}>
      <section className={styles.formSection}>
        <h3>{t("users_form_basic")}</h3>
        <UsernameField
          value={props.newForm.username}
          availability={props.usernameAvailability}
          onChange={(username) => props.setNewForm((current) => ({ ...current, username }))}
          onCheck={props.checkUsernameAvailability}
          onResetAvailability={props.resetUsernameAvailability}
        />
        <label><span>{t("users_display_name")} *</span><input type="text" required maxLength={100} className="form-input" value={props.newForm.displayName} onChange={(event) => props.setNewForm((current) => ({ ...current, displayName: event.target.value }))} autoComplete="name" /></label>
        <label><span>{t("users_email")} <small>{t("users_optional")}</small></span><input type="email" className="form-input" value={props.newForm.email} onChange={(event) => props.setNewForm((current) => ({ ...current, email: event.target.value }))} autoComplete="email" /></label>
      </section>
      <section className={styles.formSection}>
        <h3>{t("users_form_role")}</h3>
        <label><span>{t("users_role")} *</span><select className="form-input" value={props.newForm.role} onChange={(event) => props.setNewForm((current) => ({ ...current, role: event.target.value as RoleKey }))}>{props.assignableRoles.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}</select></label>
        <p className={styles.roleHint}><Info size={16} /><span><strong>{t(`users_${props.newForm.role}`)}</strong>{t(`roles_desc_${props.newForm.role}`)}</span></p>
      </section>
      <section className={styles.formSection}>
        <h3>{t("users_form_security")}</h3>
        <PasswordField id="new-user-password" label={t("users_password_new")} value={props.newForm.password} onChange={(password) => props.setNewForm((current) => ({ ...current, password }))} visible={props.newPasswordVisible} setVisible={props.setNewPasswordVisible} placeholder={t("users_password_new")} autoComplete="new-password" />
        <PasswordStrengthBar password={props.newForm.password} />
        <PasswordField id="new-user-password-confirm" label={t("users_password_confirm")} value={props.newForm.confirmPassword} onChange={(confirmPassword) => props.setNewForm((current) => ({ ...current, confirmPassword }))} visible={props.newConfirmPasswordVisible} setVisible={props.setNewConfirmPasswordVisible} placeholder={t("users_password_confirm")} autoComplete="new-password" onEnter={() => { if (props.savingAction !== "create") void props.handleCreate(); }} />
      </section>
    </div>
  );
}
