const fs = require('fs');

function extract() {
  let content = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');

  // Extract Types
  const typeStartStr = 'interface SysUser {';
  const typeEndStr = '\nfunction isRoleKey';
  const tsStart = content.indexOf(typeStartStr);
  const tsEnd = content.indexOf(typeEndStr);
  if (tsStart !== -1 && tsEnd !== -1) {
    let typesContent = content.substring(tsStart, tsEnd);
    typesContent = 'import { type Capability, type CapabilityDecision } from "@/lib/permissions";\n' + typesContent;
    typesContent = typesContent.replace(/^(interface|type|const|function) /gm, 'export $1 ');
    fs.writeFileSync('src/app/(dashboard)/users/types.ts', typesContent + '\n');
    content = content.substring(0, tsStart) + 'import * as T from "./types";\n' + content.substring(tsEnd);
  }

  // Extract CSS
  const cssStartStr = 'const usersPageStyles = `\n';
  const cssStart = content.indexOf(cssStartStr);
  if (cssStart !== -1) {
    const cssEnd = content.indexOf('\n`;\n', cssStart);
    if (cssEnd !== -1) {
      const css = content.substring(cssStart + cssStartStr.length, cssEnd);
      fs.writeFileSync('src/app/(dashboard)/users/users.css', css);
      content = content.substring(0, cssStart) + content.substring(cssEnd + 4);
      content = content.replace(/<style dangerouslySetInnerHTML=\{\{ __html: usersPageStyles \}\} \/>\n?/, '');
      content = content.replace('"use client";', '"use client";\nimport "./users.css";');
    }
  }

  fs.writeFileSync('src/app/(dashboard)/users/page.tsx', content);
  console.log("Extraction complete!");
}

extract();
