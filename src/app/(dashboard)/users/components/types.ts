import type { Dispatch, SetStateAction } from "react";
import type {
  AuditLogResponse,
  BinaryFilter,
  BulkAction,
  BulkProgressState,
  CreatedFilter,
  DetailTab,
  DrawerMode,
  EditUserForm,
  NewUserForm,
  Notice,
  PendingBulkAction,
  PendingStatusChange,
  PendingUpdate,
  RoleFilter,
  RoleKey,
  SortDirection,
  SortKey,
  StatusFilter,
  SysUser,
  UsernameAvailability,
} from "../types";

export interface UsersToolbarProps {
  searchInput: string;
  updateSearchQuery: (value: string) => void;
  roleFilter: RoleFilter;
  updateRoleFilter: (value: RoleFilter) => void;
  statusFilter: StatusFilter;
  updateStatusFilter: (value: StatusFilter) => void;
  advancedOpen: boolean;
  setAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  activeFilterCount: number;
  refresh: () => void;
  isValidating: boolean;
  exportFilteredUsers: () => void;
  filteredCount: number;
  createdFilter: CreatedFilter;
  updateCreatedFilter: (value: CreatedFilter) => void;
  createdFrom: string;
  setCreatedFrom: (value: string) => void;
  createdTo: string;
  setCreatedTo: (value: string) => void;
  loginFrom: string;
  setLoginFrom: (value: string) => void;
  loginTo: string;
  setLoginTo: (value: string) => void;
  creatorFilter: string;
  setCreatorFilter: (value: string) => void;
  lockedFilter: BinaryFilter;
  setLockedFilter: (value: BinaryFilter) => void;
  neverLoginFilter: BinaryFilter;
  setNeverLoginFilter: (value: BinaryFilter) => void;
  clearFilters: () => void;
}

export interface UsersTableProps {
  selectedUsernames: string[];
  mutableSelectedCount: number;
  requestBulkAction: (action: BulkAction) => void;
  bulkRole: RoleKey;
  setBulkRole: (role: RoleKey) => void;
  exportSelectedUsers: () => void;
  clearSelection: () => void;
  filteredUsers: SysUser[];
  users: SysUser[];
  allPageSelected: boolean;
  togglePageSelection: () => void;
  pagedUsers: SysUser[];
  toggleSort: (key: SortKey) => void;
  sortKey: SortKey;
  sortDirection: SortDirection;
  isLoading: boolean;
  error: unknown;
  refresh: () => void;
  openCreateDrawer: () => void;
  clearFilters: () => void;
  isProtectedUser: (user: SysUser) => boolean;
  toggleUserSelection: (username: string) => void;
  openDetails: (user: SysUser) => void;
  startEdit: (user: SysUser) => void;
  startPasswordReset: (user: SysUser) => void;
  openMenuUsername: string | null;
  setOpenMenuUsername: Dispatch<SetStateAction<string | null>>;
  setPendingStatusChange: Dispatch<SetStateAction<PendingStatusChange | null>>;
  setConfirmReason: (reason: string) => void;
  handleDelete: (username: string) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  setPage: Dispatch<SetStateAction<number>>;
  safePage: number;
  pageCount: number;
}

export interface UserDrawerProps {
  notice: Notice | null;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  pendingDeleteUsername: string | null;
  savingAction: string | null;
  confirmReason: string;
  executeDelete: () => Promise<void>;
  resetConfirmState: () => void;
  setConfirmReason: (reason: string) => void;
  pendingStatusChange: PendingStatusChange | null;
  executeStatusChange: () => Promise<void>;
  pendingBulkAction: PendingBulkAction | null;
  executeBulkAction: () => Promise<void>;
  bulkProgress: BulkProgressState | null;
  cancelBulkAction: () => void;
  closeBulkProgress: () => void;
  pendingUpdate: PendingUpdate | null;
  selectedUser: SysUser | null;
  submitUpdate: (user: SysUser, payload: PendingUpdate["payload"], reason: string) => Promise<void>;
  drawerMode: DrawerMode;
  closeDrawer: () => void;
  newForm: NewUserForm;
  setNewForm: Dispatch<SetStateAction<NewUserForm>>;
  newPasswordVisible: boolean;
  setNewPasswordVisible: (visible: boolean) => void;
  newConfirmPasswordVisible: boolean;
  setNewConfirmPasswordVisible: (visible: boolean) => void;
  handleCreate: () => Promise<void>;
  usernameAvailability: UsernameAvailability;
  checkUsernameAvailability: (username: string) => Promise<void>;
  resetUsernameAvailability: () => void;
  detailTab: DetailTab;
  setDetailTab: (tab: DetailTab) => void;
  editForm: EditUserForm;
  setEditForm: Dispatch<SetStateAction<EditUserForm>>;
  isProtectedUser: (user: SysUser) => boolean;
  editPasswordVisible: boolean;
  setEditPasswordVisible: (visible: boolean) => void;
  handleUpdate: () => Promise<void>;
  handlePasswordReset: () => Promise<void>;
  openDetails: (user: SysUser) => void;
  startEdit: (user: SysUser) => void;
  startPasswordReset: (user: SysUser) => void;
  handleDelete: (username: string) => void;
  isAuditLoading: boolean;
  auditError: unknown;
  mutateAudit: () => Promise<unknown>;
  auditData?: AuditLogResponse;
}
