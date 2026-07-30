const fs=require('fs');
let code=fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');
code = code.replace(/<style dangerouslySetInnerHTML=\{\{ __html: usersPageStyles \}\} \/>/, '');
const startIdx = code.indexOf('const usersPageStyles = `');
if (startIdx !== -1) {
  const endIdx = code.indexOf('`;', startIdx);
  if (endIdx !== -1) {
    code = code.substring(0, startIdx) + code.substring(endIdx + 2);
  }
}
code = code.replace('use client";\n', 'use client";\nimport \'./users.css\';\n');
fs.writeFileSync('src/app/(dashboard)/users/page.tsx', code);
