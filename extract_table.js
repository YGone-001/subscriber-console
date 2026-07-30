const fs = require('fs');

let page = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');

const tableStartStr = '          {selectedUsernames.length > 0 ? (';
const tableEndStr = '        </section>\n      </div>';

const tableStart = page.indexOf(tableStartStr);
const tableEnd = page.indexOf(tableEndStr);

if (tableStart !== -1 && tableEnd !== -1) {
  const tableJsx = page.substring(tableStart, tableEnd);

  const component = `import { useI18n } from "@/components/I18nProvider";
import { 
  User, Mail, Search, RefreshCw, Plus, KeyRound, LogOut, 
  UserCheck, UserX, Lock, ChevronDown, Trash2, Eye, Settings,
  MoreHorizontal, Shield, X, Download
} from "lucide-react";
import { LoadingRows, EmptyState } from "@/components/OperationFeedback";
import * as T from "../types";
import { VALID_ROLES } from "../types";
import { displayValue, formatDateTime } from "../utils";

export function UsersTable(props: any) {
  const { t } = useI18n();
  const {
    selectedUsernames, mutableSelectedUsers, requestBulkAction,
    bulkRole, setBulkRole, exportSelectedUsers, setSelectedUsernames,
    filteredUsers, users, allPageSelected, togglePageSelection,
    pagedUsers, toggleSort, sortKey, sortDirection,
    isLoading, error, mutate, openCreateDrawer, clearFilters,
    isProtectedUser, normalizeStatus, toggleUserSelection,
    openDetails, renderRoleBadge, renderStatusBadge,
    startEdit, openMenuUsername, setOpenMenuUsername,
    setPendingStatusChange, setConfirmReason, handleDelete,
    pageSize, setPageSize, setPage, PAGE_SIZE_OPTIONS,
    safePage, pageCount, normalizePageSize
  } = props;

  return (
    <>
${tableJsx}
    </>
  );
}
`;

  fs.writeFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', component);

  const injection = `
          <UsersTable {...tableProps} />
`;
  page = page.substring(0, tableStart) + injection + page.substring(tableEnd);
  
  const returnIdx = page.lastIndexOf('  return (\n    <>\n      <div className="users-page');
  const propsInjection = `
  const tableProps = {
    selectedUsernames, mutableSelectedUsers, requestBulkAction,
    bulkRole, setBulkRole, exportSelectedUsers, setSelectedUsernames,
    filteredUsers, users, allPageSelected, togglePageSelection,
    pagedUsers, toggleSort, sortKey, sortDirection,
    isLoading, error, mutate, openCreateDrawer, clearFilters,
    isProtectedUser, normalizeStatus, toggleUserSelection,
    openDetails, renderRoleBadge, renderStatusBadge,
    startEdit, openMenuUsername, setOpenMenuUsername,
    setPendingStatusChange, setConfirmReason, handleDelete,
    pageSize, setPageSize, setPage, PAGE_SIZE_OPTIONS,
    safePage, pageCount, normalizePageSize
  };
`;
  page = page.substring(0, returnIdx) + propsInjection + page.substring(returnIdx);
  page = page.replace('import { UsersToolbar } from "./components/UsersToolbar";', 'import { UsersToolbar } from "./components/UsersToolbar";\nimport { UsersTable } from "./components/UsersTable";');

  fs.writeFileSync('src/app/(dashboard)/users/page.tsx', page);
  console.log('Extracted UsersTable successfully');
}
