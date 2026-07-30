const fs = require('fs');

let page = fs.readFileSync('src/components/RatingManagementPage.tsx', 'utf-8');
page = page.replace(/OperationT\.Notice/g, 'OperationNotice');
fs.writeFileSync('src/components/RatingManagementPage.tsx', page);
console.log('Fixed OperationT.Notice');
