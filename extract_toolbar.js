const fs = require('fs');

let page = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');

// 1. Extract UsersToolbar
const toolbarStartMarker = '<div className="users-toolbar">';
const toolbarStart = page.indexOf(toolbarStartMarker);
const renderTagsStart = page.indexOf('const renderFilterTags = () => {');
const renderTagsEnd = page.indexOf('  if (!isRoot) {', renderTagsStart);

// We know the toolbar ends at `</div>\n          </div>\n\n          {renderFilterTags()}`
// Let's find the `</div>\n          </div>` right before `renderFilterTags()`
const toolbarEnd = page.indexOf('          {renderFilterTags()}', toolbarStart);

if (toolbarStart !== -1 && toolbarEnd !== -1 && renderTagsStart !== -1 && renderTagsEnd !== -1) {
  const toolbarJsx = page.substring(toolbarStart, toolbarEnd);
  const filterTagsCode = page.substring(renderTagsStart, renderTagsEnd);
  
  const toolbarComponent = `import { useI18n } from "@/components/I18nProvider";
import { 
  Search, SlidersHorizontal, RefreshCw, Download, 
  CalendarDays, Trash2, KeyRound, Lock, Shield, UserCheck, X
} from "lucide-react";
import * as T from "../types";

export function UsersToolbar(props: any) {
  const { t } = useI18n();
  const {
    searchInput, updateSearchQuery, roleFilter, updateRoleFilter,
    statusFilter, updateStatusFilter, advancedOpen, setAdvancedOpen,
    activeFilterCount, mutate, isValidating, exportFilteredUsers,
    filteredUsers, createdFilter, updateCreatedFilter, createdFrom,
    setCreatedFrom, setPage, createdTo, setCreatedTo, loginFrom,
    setLoginFrom, loginTo, setLoginTo, creatorFilter, setCreatorFilter,
    lockedFilter, setLockedFilter, neverLoginFilter, setNeverLoginFilter,
    clearFilters
  } = props;
  
${filterTagsCode}
  
  return (
    <>
      ${toolbarJsx.trim()}
      {renderFilterTags()}
    </>
  );
}
`;
  fs.writeFileSync('src/app/(dashboard)/users/components/UsersToolbar.tsx', toolbarComponent);
  
  // Remove renderFilterTags and replace JSX
  page = page.substring(0, renderTagsStart) + page.substring(renderTagsEnd);
  
  // Need to re-find toolbarStart since string length changed
  const newToolbarStart = page.indexOf(toolbarStartMarker);
  const newToolbarEnd = page.indexOf('          {renderFilterTags()}', newToolbarStart) + '          {renderFilterTags()}\n'.length;
  
  page = page.substring(0, newToolbarStart) + '<UsersToolbar {...toolbarProps} />\n' + page.substring(newToolbarEnd);
  
  // Inject toolbarProps right before `return (`
  const returnIdx = page.lastIndexOf('  return (\n    <>\n      <div className="users-page');
  const propsInjection = `
  const toolbarProps = {
    searchInput, updateSearchQuery, roleFilter, updateRoleFilter,
    statusFilter, updateStatusFilter, advancedOpen, setAdvancedOpen,
    activeFilterCount, mutate, isValidating, exportFilteredUsers,
    filteredUsers, createdFilter, updateCreatedFilter, createdFrom,
    setCreatedFrom, setPage, createdTo, setCreatedTo, loginFrom,
    setLoginFrom, loginTo, setLoginTo, creatorFilter, setCreatorFilter,
    lockedFilter, setLockedFilter, neverLoginFilter, setNeverLoginFilter,
    clearFilters
  };\n\n`;
  page = page.substring(0, returnIdx) + propsInjection + page.substring(returnIdx);
  
  // Add import
  page = page.replace('import { UsersSummaryPanel } from "./components/UsersSummaryPanel";', 'import { UsersSummaryPanel } from "./components/UsersSummaryPanel";\nimport { UsersToolbar } from "./components/UsersToolbar";');
  
  fs.writeFileSync('src/app/(dashboard)/users/page.tsx', page);
  console.log('Extracted UsersToolbar successfully');
}
