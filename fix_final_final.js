const fs = require('fs');

let drawer = fs.readFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', 'utf-8');
drawer = drawer.replace(/\(password\)/g, '(password: any)');
drawer = drawer.replace(/\(confirmPassword\)/g, '(confirmPassword: any)');
drawer = drawer.replace(/\(tab\)/g, '(tab: any)');
drawer = drawer.replace(/\(log\)/g, '(log: any)');
drawer = drawer.replace('T.Capability', 'Capability');
fs.writeFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', drawer);

let page = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');
page = page.replace('getUserStatusMeta(selectedUser.status, selectedUser.locked)', 'renderStatusBadge(selectedUser.status, selectedUser.locked)');
fs.writeFileSync('src/app/(dashboard)/users/page.tsx', page);

let table = fs.readFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', 'utf-8');
table = table.replace('import { RoleKey } from "../types";', 'import { RoleKey } from "../types";\n');
if (!table.includes('import { type RoleKey } from "../types"')) {
    table = table.replace('import * as T from "../types";', 'import * as T from "../types";\nimport { type RoleKey } from "../types";');
}
fs.writeFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', table);

let toolbar = fs.readFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', 'utf-8');
toolbar = toolbar.replace(/setAdvancedOpen\(\(current\) =>/g, 'setAdvancedOpen((current: any) =>');
fs.writeFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', toolbar);

console.log('Fixed final final TS errors');
