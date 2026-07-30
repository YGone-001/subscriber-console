const fs = require('fs');

let table = fs.readFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', 'utf-8');
table = table.replace(/isProtectedUseritem/g, 'isProtectedUser(item)');
table = table.replace(/openDetailsitem/g, 'openDetails(item)');
table = table.replace(/startEdititem/g, 'startEdit(item)');
fs.writeFileSync('src/app/(dashboard)/users/components/UsersTable.tsx', table);

let page = fs.readFileSync('src/components/RatingManagementPage.tsx', 'utf-8');
page = page.replace(/React\.SetStateAction<RatingForm>/g, 'React.SetStateAction<T.RatingForm>');
page = page.replace(/React\.Dispatch<React\.SetStateAction<RatingForm>>/g, 'React.Dispatch<React.SetStateAction<T.RatingForm>>');
page = page.replace(/\(current\) =>/g, '(current: any) =>');
// RatingForm inside generics
page = page.replace(/<RatingForm/g, '<T.RatingForm');
page = page.replace(/setRatingForm\(/g, 'setEditForm('); // Wait, if I replaced setT.RatingForm to setRatingForm, actually it was setEditForm in the file maybe? Let me not touch it if not needed.
// Wait, TS says `RatingForm` is not found, so there's `RatingForm` somewhere.
page = page.replace(/ RatingForm/g, ' T.RatingForm');

fs.writeFileSync('src/components/RatingManagementPage.tsx', page);

// Check UserDrawer.tsx
let drawer = fs.readFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', 'utf-8');
drawer = drawer.replace(/UserStatus/g, 'T.UserStatus');
drawer = drawer.replace(/RoleKey/g, 'T.RoleKey');
drawer = drawer.replace(/Capability/g, 'T.Capability');
// We imported T, so T.UserStatus etc.
// But we also might have VALID_ROLES imported directly, wait.
// In UserDrawer.tsx, RoleKey and UserStatus are from types, but I might need to import them directly if used as types.
// It's easier to just add import { RoleKey, UserStatus, Capability } from "../types"
if (!drawer.includes('Capability } from "../types"')) {
    drawer = drawer.replace('import { VALID_ROLES, VALID_STATUS } from "../types";', 'import { VALID_ROLES, VALID_STATUS, RoleKey, UserStatus, Capability } from "../types";');
}
fs.writeFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', drawer);

let toolbar = fs.readFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', 'utf-8');
if (!toolbar.includes('StatusFilter } from "../types"')) {
    toolbar = toolbar.replace('import { VALID_ROLES, VALID_STATUS } from "../types";', 'import { VALID_ROLES, VALID_STATUS, RoleFilter, StatusFilter, CreatedFilter, BinaryFilter } from "../types";');
}
fs.writeFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', toolbar);

console.log('Fixed more TS errors');
