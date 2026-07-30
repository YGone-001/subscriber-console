const fs = require('fs');

// 1. UserDrawer.tsx
let drawer = fs.readFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', 'utf-8');
drawer = drawer.replace('import { VALID_ROLES, VALID_STATUS, RoleKey, UserStatus, Capability } from "../types";', 'import { VALID_ROLES, VALID_STATUS, RoleKey, UserStatus } from "../types";');
drawer = drawer.replace('import { useI18n } from "@/components/I18nProvider";', 'import { useI18n } from "@/components/I18nProvider";\nimport { type Capability } from "@/lib/permissions";');
drawer = drawer.replace(/\(password\)/g, '(password: any)');
drawer = drawer.replace(/\(confirmPassword\)/g, '(confirmPassword: any)');
drawer = drawer.replace(/\(tab\)/g, '(tab: any)');
drawer = drawer.replace(/\(log\)/g, '(log: any)');
fs.writeFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', drawer);

// 2. UsersTable.tsx
let table = fs.readFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', 'utf-8');
if (!table.includes('RoleKey')) {
    table = table.replace('import * as T from "../types";', 'import * as T from "../types";\nimport { RoleKey } from "../types";');
}
fs.writeFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', table);

// 3. UsersToolbar.tsx
let toolbar = fs.readFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', 'utf-8');
toolbar = toolbar.replace(/searchQuery/g, 'searchInput');
toolbar = toolbar.replace(/\(current\)/g, '(current: any)');
fs.writeFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', toolbar);

// 4. users/page.tsx
let page = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');
page = page.replace('import { getUserAccessStatusMeta } from "@/lib/userAccessManagement";', '');
page = page.replace('getUserStatusMeta(item.status, item.locked)', 'renderStatusBadge(item.status, item.locked)');
page = page.replace('CAPABILITY_LABEL_KEYS,', '');

// Add missing isRoleFilter, isStatusFilter, isCreatedFilter, isBinaryFilter, isSortKey, isSortDirection to utils imports
page = page.replace('import { normalizeRole, normalizeStatus, normalizePageSize, formatDateTime, displayValue, matchesCreatedFilter }', 'import { normalizeRole, normalizeStatus, normalizePageSize, formatDateTime, displayValue, matchesCreatedFilter, isRoleFilter, isStatusFilter, isCreatedFilter, isBinaryFilter, isSortKey, isSortDirection }');
fs.writeFileSync('src/app/(dashboard)/users/page.tsx', page);

// 5. rating/types.tsx
let ratingTypes = fs.readFileSync('src/components/rating/types.tsx', 'utf-8');
ratingTypes = ratingTypes.replace(/export export/g, 'export');
fs.writeFileSync('src/components/rating/types.tsx', ratingTypes);

console.log('Fixed final TS errors');
