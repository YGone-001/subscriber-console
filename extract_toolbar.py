import re
import os

source_file = 'src/app/(dashboard)/users/page.tsx'
with open(source_file, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace UsersToolbar
toolbar_start = content.find('<div className="users-toolbar">')
# The toolbar ends right before `<div className="users-table-container">`
toolbar_end = content.find('<div className="users-table-container">')

# But wait, there is `renderFilterTags()`!
filter_tags_func_start = content.find('const renderFilterTags = () => {')
filter_tags_func_end = content.find('  if (!isRoot) {', filter_tags_func_start)

filter_tags_code = content[filter_tags_func_start:filter_tags_func_end]

toolbar_jsx = content[toolbar_start:toolbar_end]

content = content.replace(filter_tags_code, '')
content = content.replace(toolbar_jsx, '<UsersToolbar {...toolbarProps} />\n          ')

# Create UsersToolbar.tsx
code = '''import { useI18n } from "@/components/I18nProvider";
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
    clearFilters, selectedUsernames, setPendingBulkAction,
    currentUser, isRoot
  } = props;
  
''' + '  ' + filter_tags_code.strip().replace('\n', '\n  ') + '''
  
  return (
    <>
''' + '      ' + toolbar_jsx.strip().replace('\n', '\n      ') + '''
      {renderFilterTags()}
    </>
  );
}
'''
with open('src/app/(dashboard)/users/components/UsersToolbar.tsx', 'w', encoding='utf-8') as f:
    f.write(code)

content = content.replace('import { UsersSummaryPanel } from "./components/UsersSummaryPanel";', 'import { UsersSummaryPanel } from "./components/UsersSummaryPanel";\nimport { UsersToolbar } from "./components/UsersToolbar";')

# Inject toolbarProps into UsersPage right before `return (`
props_injection = '''
  const toolbarProps = {
    searchInput, updateSearchQuery, roleFilter, updateRoleFilter,
    statusFilter, updateStatusFilter, advancedOpen, setAdvancedOpen,
    activeFilterCount, mutate, isValidating, exportFilteredUsers,
    filteredUsers, createdFilter, updateCreatedFilter, createdFrom,
    setCreatedFrom, setPage, createdTo, setCreatedTo, loginFrom,
    setLoginFrom, loginTo, setLoginTo, creatorFilter, setCreatorFilter,
    lockedFilter, setLockedFilter, neverLoginFilter, setNeverLoginFilter,
    clearFilters, selectedUsernames, setPendingBulkAction,
    currentUser, isRoot
  };
'''
content = content.replace('  return (\n    <>\n      <div className="users-page', props_injection + '\n  return (\n    <>\n      <div className="users-page')

with open(source_file, 'w', encoding='utf-8') as f:
    f.write(content)

print('Extracted UsersToolbar')
