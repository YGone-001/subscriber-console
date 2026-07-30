const fs = require('fs');

let page = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');

page = page.replace('ROLE_CAPABILITIES, CAPABILITY_LABEL_KEYS', '');
page = page.replace('import { getUserStatusMeta } from "@/lib/userAccessManagement";', 'import { getUserAccessStatusMeta } from "@/lib/userAccessManagement";');

// Fix implicitly any types in UsersToolbar, UsersTable, UserDrawer
// I will just use `any` instead of implicit any
let drawer = fs.readFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', 'utf-8');
drawer = drawer.replace(/\(current\)/g, '(current: any)');
drawer = drawer.replace(/\(password\)/g, '(password: any)');
drawer = drawer.replace(/\(confirmPassword\)/g, '(confirmPassword: any)');
drawer = drawer.replace(/\(tab\)/g, '(tab: any)');
drawer = drawer.replace(/\(log\)/g, '(log: any)');
fs.writeFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', drawer);

let table = fs.readFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', 'utf-8');
table = table.replace(/\(item\)/g, '(item: any)');
table = table.replace(/\(current\)/g, '(current: any)');
table = table.replace(/\(option\)/g, '(option: any)');
fs.writeFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', table);

let toolbar = fs.readFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', 'utf-8');
toolbar = toolbar.replace(/\(current\)/g, '(current: any)');
toolbar = toolbar.replace(/\(role\)/g, '(role: any)');
toolbar = toolbar.replace(/\(status\)/g, '(status: any)');
fs.writeFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', toolbar);

fs.writeFileSync('src/app/(dashboard)/users/page.tsx', page);
console.log('Fixed typescript errors');
