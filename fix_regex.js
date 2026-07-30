const fs = require('fs');

let page = fs.readFileSync('src/components/RatingManagementPage.tsx', 'utf-8');

page = page.replace(/setT\.PlanForm/g, 'setPlanForm');
page = page.replace(/setT\.Notice/g, 'setNotice');
page = page.replace(/setT\.RatingForm/g, 'setRatingForm');
page = page.replace(/validateT\.RatingForm/g, 'validateRatingForm');
page = page.replace(/<T\.RatingForm/g, '<RatingForm');

fs.writeFileSync('src/components/RatingManagementPage.tsx', page);
console.log('Fixed regex mistakes');
