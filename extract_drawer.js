const fs = require('fs');

let page = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');

const overlayStartStr = '      {notice ? (';
const overlayEndStr = '          </>\n  );\n}';

const overlayStart = page.indexOf(overlayStartStr);
const overlayEnd = page.indexOf(overlayEndStr);

if (overlayStart !== -1 && overlayEnd !== -1) {
  const overlayJsx = page.substring(overlayStart, overlayEnd);

  const component = `import { useI18n } from "@/components/I18nProvider";
import { 
  Plus, X, Save, Shield, RefreshCw, CheckCircle2, Clock, Trash2, Settings
} from "lucide-react";
import { OperationNotice, ConfirmActionPanel, LoadingRows, EmptyState } from "@/components/OperationFeedback";
import * as T from "../types";
import { VALID_ROLES, VALID_STATUS } from "../types";
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
${overlayJsx}
    </>
  );
}
`;

  fs.writeFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', component);

  const injection = `
      <UserDrawer {...drawerProps} />
`;
  page = page.substring(0, overlayStart) + injection + page.substring(overlayEnd);
  
  const returnIdx = page.lastIndexOf('  const tableProps = {');
  const propsInjection = `
  const drawerProps = {
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
  };
`;
  page = page.substring(0, returnIdx) + propsInjection + page.substring(returnIdx);
  page = page.replace('import { UsersTable } from "./components/UsersTable";', 'import { UsersTable } from "./components/UsersTable";\nimport { UserDrawer } from "./components/UserDrawer";');

  fs.writeFileSync('src/app/(dashboard)/users/page.tsx', page);
  console.log('Extracted UserDrawer successfully');
}
