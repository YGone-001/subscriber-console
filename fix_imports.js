import * as fs from 'fs';

const pagePath = 'src/app/(dashboard)/users/page.tsx';
let page = fs.readFileSync(pagePath, 'utf-8');

// The file currently has `import * as T from "./types";`
// I need to add explicit imports for types and constants
const typesImports = `import {
  SysUser, RoleKey, UserStatus, RoleFilter, StatusFilter, CreatedFilter, BinaryFilter,
  SortKey, SortDirection, DrawerMode, DetailTab, NewUserForm, EditUserForm,
  Notice, PendingStatusChange, PendingBulkAction, PendingUpdate, ApprovalMetricResponse,
  AuditLogResponse, BulkAction, VALID_ROLES, VALID_STATUS, PAGE_SIZE_OPTIONS,
  DEFAULT_NEW_FORM, DEFAULT_EDIT_FORM, USERNAME_PATTERN, ROLE_STYLE,
  ROLE_CAPABILITIES, CAPABILITY_LABEL_KEYS
} from "./types";
import { getUserStatusMeta } from "@/lib/userAccessManagement";
`;

page = page.replace('import * as T from "./types";', typesImports);
fs.writeFileSync(pagePath, page);

console.log('Fixed imports in page.tsx');

// Fix utils.ts imports
const utilsPath = 'src/app/(dashboard)/users/utils.ts';
let utils = fs.readFileSync(utilsPath, 'utf-8');
utils = utils.replace('import { type CreatedFilter', 'import { type CreatedFilter, type RoleFilter, type StatusFilter, type BinaryFilter');
fs.writeFileSync(utilsPath, utils);
console.log('Fixed imports in utils.ts');

// Also UsersToolbar needs missing constants
const toolbarPath = 'src/app/(dashboard)/users/components/UsersToolbar.tsx';
let toolbar = fs.readFileSync(toolbarPath, 'utf-8');
toolbar = toolbar.replace('import * as T from "../types";', 'import * as T from "../types";\nimport { VALID_ROLES, VALID_STATUS } from "../types";');
fs.writeFileSync(toolbarPath, toolbar);
