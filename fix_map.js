const fs = require('fs');
let drawer = fs.readFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', 'utf-8');
drawer = drawer.replace(/mapT\.CapabilityDecision/g, 'mapCapabilityDecision');
fs.writeFileSync('src/app/(dashboard)/users/components/UserDrawer.tsx', drawer);
console.log('Fixed mapCapabilityDecision');
