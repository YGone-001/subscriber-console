/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/users/components/UserPasswordResetForm.tsx
 * Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.
 */
import { useI18n } from '../../../providers/I18nProvider';
import { PasswordField } from '../../../components/iam/PasswordField';
import type { UserDrawerProps } from './types';
import { PasswordStrengthBar } from './PasswordStrengthBar';
import styles from '../../../styles/modules/UserDrawer.module.css';

type UserPasswordResetFormProps = Pick<UserDrawerProps, "selectedUser" | "editForm" | "setEditForm" | "editPasswordVisible" | "setEditPasswordVisible" | "savingAction" | "handlePasswordReset">;

export function UserPasswordResetForm(props: UserPasswordResetFormProps) {
  const { t } = useI18n();
  if (!props.selectedUser) return null;

  return (
      <section className={styles.formSection}>
        <h3>{t("users_reset_password")}</h3>
        <p className={styles.sectionDescription}>{t("users_reset_password_desc", { username: props.selectedUser.username })}</p>
        <PasswordField
          id="reset-user-password"
          label={t("users_password_new")}
          value={props.editForm.password}
          onChange={(password) => props.setEditForm((current) => ({ ...current, password }))}
          visible={props.editPasswordVisible}
          setVisible={props.setEditPasswordVisible}
          autoComplete="new-password"
          onEnter={() => { if (props.savingAction !== `update:${props.selectedUser?.username}`) void props.handlePasswordReset(); }}
        />
        <PasswordStrengthBar password={props.editForm.password} />
      </section>
  );
}
