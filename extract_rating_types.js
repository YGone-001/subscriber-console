const fs = require('fs');

let page = fs.readFileSync('src/components/RatingManagementPage.tsx', 'utf-8');

const typeStartStr = 'const CURRENCIES = ';
const typeEndStr = 'function formatDateTime';

const start = page.indexOf(typeStartStr);
const end = page.indexOf(typeEndStr);

if (start !== -1 && end !== -1) {
  let extracted = page.substring(start, end);
  
  const typesContent = `export ` + extracted.replace(/^(const|type|function) /gm, 'export $1 ');
  
  fs.mkdirSync('src/components/rating', { recursive: true });
  fs.writeFileSync('src/components/rating/types.ts', typesContent);
  
  // Actually some of these are utils, but let's put them all in types.ts for now
  
  page = page.substring(0, start) + 'import * as T from "./rating/types";\nimport { classifyPolicy, applyChargingType, formatGrant, makeDefaultForm, defaultsFor, CURRENCIES, DEFAULT_OCS_PLAN_ID, DATA_GRANT, DATA_THRESHOLD, VOICE_GRANT, SMS_GRANT, SERVICE_FILTERS, Field } from "./rating/types";\n\n' + page.substring(end);
  
  // replace type references
  page = page.replace(/RatingPolicy/g, 'T.RatingPolicy');
  page = page.replace(/TariffPlan/g, 'T.TariffPlan');
  page = page.replace(/PlanSubscriberPreview/g, 'T.PlanSubscriberPreview');
  page = page.replace(/PlanOperationLog/g, 'T.PlanOperationLog');
  page = page.replace(/PlanOperationsData/g, 'T.PlanOperationsData');
  page = page.replace(/PlanForm/g, 'T.PlanForm');
  page = page.replace(/RatingForm/g, 'T.RatingForm');
  page = page.replace(/Notice/g, 'T.Notice');
  page = page.replace(/RatingManagementView/g, 'T.RatingManagementView');
  page = page.replace(/ChargingType/g, 'T.ChargingType');
  page = page.replace(/ServiceKey/g, 'T.ServiceKey');
  
  // Fix double T.T.
  page = page.replace(/T\.T\./g, 'T.');
  
  fs.writeFileSync('src/components/RatingManagementPage.tsx', page);
  console.log('Extracted types and utils successfully');
}
