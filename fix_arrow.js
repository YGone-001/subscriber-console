const fs = require('fs');
let drawer = fs.readFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', 'utf-8');
drawer = drawer.replace('password => setNewForm', '(password: string) => setNewForm');
drawer = drawer.replace('confirmPassword => setNewForm', '(confirmPassword: string) => setNewForm');
drawer = drawer.replace('tab => setDetailTab', '(tab: string) => setDetailTab');
drawer = drawer.replace('password => setEditForm', '(password: string) => setEditForm');
drawer = drawer.replace('log => (', '(log: any) => (');
fs.writeFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', drawer);
console.log('Fixed arrow functions');
