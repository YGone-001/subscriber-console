const fs = require('fs');
let code = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');

// Extract types to types.ts
const typesStart = code.indexOf('interface SysUser');
const typesEnd = code.indexOf('function UsersPage');
if (typesStart !== -1 && typesEnd !== -1) {
  let typesCode = code.substring(typesStart, typesEnd);
  // Add missing imports for types
  typesCode = 'import { type Capability, type CapabilityDecision } from "@/lib/permissions";\nimport { getUserAccessStatusMeta } from "@/lib/userAccessManagement";\n\n' + typesCode;
  typesCode = typesCode.replace(/^(interface|type|const|function) /gm, 'export $1 ');
  fs.writeFileSync('src/app/(dashboard)/users/types.ts', typesCode);
  
  // Remove types from page.tsx and add import
  code = code.substring(0, typesStart) + 'import * as T from "./types";\n\nexport default ' + code.substring(typesEnd);
}

// Extract CSS
const cssStart = code.indexOf('const usersPageStyles = `');
if (cssStart !== -1) {
  const cssEnd = code.indexOf('`;', cssStart);
  if (cssEnd !== -1) {
    const css = code.substring(cssStart + 'const usersPageStyles = `\n'.length, cssEnd);
    fs.writeFileSync('src/app/(dashboard)/users/users.css', css);
    
    // Remove CSS from page.tsx
    code = code.substring(0, cssStart) + code.substring(cssEnd + 2);
    code = code.replace(/<style dangerouslySetInnerHTML=\{\{ __html: usersPageStyles \}\} \/>\s*/, '');
    code = code.replace('use client";', 'use client";\nimport "./users.css";');
  }
}

fs.writeFileSync('src/app/(dashboard)/users/page.tsx', code);
console.log('Extracted types and CSS');
