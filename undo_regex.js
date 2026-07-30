const fs = require('fs');

let table = fs.readFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', 'utf-8');

table = table.replace(/\(item: any\)/g, 'item');
table = table.replace(/pagedUsers\.map\(item =>/g, 'pagedUsers.map((item: any) =>');
table = table.replace(/openDetails\(item\)/g, 'openDetails(item)');

// There might be some remaining any types that I messed up like (option: any) for the options
// table = table.replace(/\(option\)/g, '(option: any)'); -> this could have messed up value={option} if it had (option)
table = table.replace(/\(option: any\)/g, 'option');
table = table.replace(/PAGE_SIZE_OPTIONS\.map\(option =>/g, 'PAGE_SIZE_OPTIONS.map((option: any) =>');

// Let's also check UserDrawer.tsx
let drawer = fs.readFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', 'utf-8');
drawer = drawer.replace(/\(current: any\)/g, 'current');
// drawer.replace(/\(current\)/g, '(current: any)') might have broken setCurrent((current) => ...) => setCurrent(current: any => ...)
drawer = drawer.replace(/setEditForm\(current =>/g, 'setEditForm((current: any) =>');
drawer = drawer.replace(/setNewForm\(current =>/g, 'setNewForm((current: any) =>');
// Actually, `current` is usually an argument in `setX((current) => ...)`, which TS can infer! So `(current: any)` wasn't even needed, except it implicitly had any because the parent `setForm` type was missing or something. But wait, `setNewForm` is strongly typed in `page.tsx`, but passed as `any` in `UserDrawerProps`! 
// Let's just blindly undo the bad regexes for (current: any), (password: any), (confirmPassword: any), (tab: any), (log: any)
drawer = drawer.replace(/\(password: any\)/g, 'password');
drawer = drawer.replace(/\(confirmPassword: any\)/g, 'confirmPassword');
drawer = drawer.replace(/\(tab: any\)/g, 'tab');
drawer = drawer.replace(/\(log: any\)/g, 'log');

fs.writeFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', table);
fs.writeFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', drawer);

let toolbar = fs.readFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', 'utf-8');
toolbar = toolbar.replace(/\(current: any\)/g, 'current');
toolbar = toolbar.replace(/\(role: any\)/g, 'role');
toolbar = toolbar.replace(/\(status: any\)/g, 'status');
fs.writeFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', toolbar);

console.log('Undid bad regexes');
