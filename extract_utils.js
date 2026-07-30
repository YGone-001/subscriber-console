const fs = require('fs');
let page = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');

const utilsStartStr = 'function isRoleKey(';
const utilsStart = page.indexOf(utilsStartStr);
const utilsEndStr = '  if (filter === "today") {';
const utilsEndFull = page.indexOf('return date.getTime() >= since;\n}', page.indexOf(utilsEndStr)) + 'return date.getTime() >= since;\n}'.length;

if (utilsStart !== -1 && utilsEndFull !== -1) {
  // We remove all the utility functions and just import them
  page = page.substring(0, utilsStart) + page.substring(utilsEndFull);
  page = page.replace('import * as T from "./types";', 'import * as T from "./types";\nimport { normalizeRole, normalizeStatus, normalizePageSize, formatDateTime, displayValue, matchesCreatedFilter } from "./utils";');
  fs.writeFileSync('src/app/(dashboard)/users/page.tsx', page);
  console.log('Removed utils from page.tsx');
}
