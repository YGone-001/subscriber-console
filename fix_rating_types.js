const fs = require('fs');

let types = fs.readFileSync('src/components/rating/types.tsx', 'utf-8');
if (!types.includes('import React from "react"')) {
  types = 'import React from "react";\n' + types;
  fs.writeFileSync('src/components/rating/types.tsx', types);
  console.log('Added React import');
}
