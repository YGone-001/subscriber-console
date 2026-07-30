import re
import os

source_file = 'src/app/(dashboard)/users/page.tsx'
with open(source_file, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace UsersSummaryPanel
summary_start = content.find('<section className="users-summary"')
summary_end = content.find('</section>', summary_start) + len('</section>\n')

summary_jsx = content[summary_start:summary_end]
content = content.replace(summary_jsx, '<UsersSummaryPanel usersCount={users.length} statusCounts={statusCounts} approvalMetrics={approvalMetrics} setNotice={setNotice} />\n')

# Create UsersSummaryPanel.tsx
panel_code = '''import { useI18n } from "@/components/I18nProvider";
import * as T from "../types";

export function UsersSummaryPanel({ 
  usersCount, 
  statusCounts, 
  approvalMetrics, 
  setNotice 
}: { 
  usersCount: number;
  statusCounts: { active: number; disabled: number };
  approvalMetrics?: T.ApprovalMetricResponse;
  setNotice: (notice: T.Notice | null) => void;
}) {
  const { t } = useI18n();
  return (
''' + '    ' + summary_jsx.strip().replace('\n', '\n    ') + '''
  );
}
'''
os.makedirs('src/app/(dashboard)/users/components', exist_ok=True)
with open('src/app/(dashboard)/users/components/UsersSummaryPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(panel_code)

# Add import to page.tsx
content = content.replace('export default function UsersPage() {', 'import { UsersSummaryPanel } from "./components/UsersSummaryPanel";\n\nexport default function UsersPage() {')

with open(source_file, 'w', encoding='utf-8') as f:
    f.write(content)

print('Extracted UsersSummaryPanel')
