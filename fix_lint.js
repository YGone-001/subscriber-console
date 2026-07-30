const fs = require('fs');

// 1. Fix UserDrawer.tsx
let drawer = fs.readFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', 'utf-8');
drawer = drawer.replace('// @ts-nocheck\n', '');
drawer = drawer.replace(/\(password\) =>/g, '(password: string) =>');
drawer = drawer.replace(/\(confirmPassword\) =>/g, '(confirmPassword: string) =>');
drawer = drawer.replace(/\(tab\) =>/g, '(tab: any) =>');
drawer = drawer.replace(/\(log\) =>/g, '(log: any) =>');
fs.writeFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', drawer);

// 2. Fix UsersToolbar.tsx
let toolbar = fs.readFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', 'utf-8');
toolbar = toolbar.replace('// @ts-nocheck\n', '');
toolbar = toolbar.replace(/\(current\) =>/g, '(current: boolean) =>');
fs.writeFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', toolbar);

// 3. Remove unused vars from page.tsx to clear lint warnings (optional, but let's do some)
let page = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');
page = page.replace('CalendarDays, CheckCircle2, ChevronDown, Clock, Download, KeyRound, Lock, LogOut, Mail, MoreHorizontal, RefreshCw, Save, Search, Settings, SlidersHorizontal, Trash2, User, UserCheck, UserX, X', 'X');
page = page.replace('ConfirmActionPanel, LoadingRows, OperationNotice', 'EmptyState');
fs.writeFileSync('src/app/(dashboard)/users/page.tsx', page);

console.log('Fixed lint errors');
