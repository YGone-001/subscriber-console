const fs = require('fs');

let page = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');
page = page.replace('getUserStatusMeta(statusValue, locked)', 'getUserAccessStatusMeta(statusValue, locked)');
if (!page.includes('getUserAccessStatusMeta }')) {
    page = page.replace('import { useI18n } from "@/components/I18nProvider";', 'import { useI18n } from "@/components/I18nProvider";\nimport { getUserAccessStatusMeta } from "@/lib/userAccessManagement";');
}
fs.writeFileSync('src/app/(dashboard)/users/page.tsx', page);

let drawer = fs.readFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', 'utf-8');
drawer = drawer.replace('renderPasswordInput(\n                      newForm.password,\n                      (password) =>', 'renderPasswordInput(\n                      newForm.password,\n                      (password: any) =>');
drawer = drawer.replace('renderPasswordInput(\n                      newForm.confirmPassword,\n                      (confirmPassword) =>', 'renderPasswordInput(\n                      newForm.confirmPassword,\n                      (confirmPassword: any) =>');
drawer = drawer.replace('detailTabs.map((tab) =>', 'detailTabs.map((tab: any) =>');
drawer = drawer.replace('renderPasswordInput(\n                            editForm.password,\n                            (password) =>', 'renderPasswordInput(\n                            editForm.password,\n                            (password: any) =>');
drawer = drawer.replace('auditData.logs.map((log) =>', 'auditData.logs.map((log: any) =>');
fs.writeFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', drawer);

let toolbar = fs.readFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', 'utf-8');
toolbar = toolbar.replace('setAdvancedOpen((current) =>', 'setAdvancedOpen((current: any) =>');
fs.writeFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', toolbar);

console.log('Fixed final final final TS errors');
