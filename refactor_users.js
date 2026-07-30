const fs = require('fs');

let typesContent = fs.readFileSync('src/app/(dashboard)/users/types.ts', 'utf-8');

// Add export keyword
typesContent = typesContent.replace(/^(interface|type|const|function) /gm, 'export $1 ');

// Add missing imports
const imports = `import { type Capability, type CapabilityDecision } from "@/lib/permissions";
import { getUserAccessStatusMeta } from "@/lib/userAccessManagement";

`;

typesContent = imports + typesContent;

fs.writeFileSync('src/app/(dashboard)/users/types.ts', typesContent);
console.log('types.ts updated with exports');
