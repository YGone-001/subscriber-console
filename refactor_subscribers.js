const fs = require('fs');

let content = fs.readFileSync('src/app/(dashboard)/subscribers/page.tsx', 'utf8');

// 1. Remove the local interfaces and replace with import { ... } from "./types";
const interfaceStartStr = "interface PlmnRecord {";
const interfaceEndStr = "/**\n * Subscriber Management Page";

const interfaceStart = content.indexOf(interfaceStartStr);
const interfaceEnd = content.indexOf(interfaceEndStr);

if (interfaceStart !== -1 && interfaceEnd !== -1) {
  content = content.substring(0, interfaceStart) + 
            'import { PlmnRecord, SubscriberRow, TrafficAdjustmentMode, TrafficAdjustmentTarget, FeedbackTone, FeedbackState, PendingDelete, SubscriberStatusFilter, SubscriberSummary, ProfilesResponse, SubscribersResponse } from "./types";\n\n' + 
            content.substring(interfaceEnd);
}

// 2. Remove FeedbackTone type from the OperationFeedback import in page.tsx if it was imported there.
content = content.replace(', type FeedbackTone }', ' }');

// 3. Add imports for SubscriberToolbar and SubscriberTable
const importHookStr = 'import "./subscribers.css";\n';
const importHookIdx = content.indexOf(importHookStr);
if (importHookIdx !== -1) {
  const insertIdx = importHookIdx + importHookStr.length;
  content = content.substring(0, insertIdx) +
    'import { SubscriberToolbar } from "./components/SubscriberToolbar";\n' +
    'import { SubscriberTable } from "./components/SubscriberTable";\n' +
    content.substring(insertIdx);
}

// 4. Replace Toolbar
const toolbarStartStr = '{/* Search, Bulk Action & Data Sync Bar */}';
const toolbarEndStr = '{/* Main Data Table */}';
const toolbarStart = content.indexOf(toolbarStartStr);
const toolbarEnd = content.indexOf(toolbarEndStr);

const toolbarCode = `<SubscriberToolbar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        setCurrentPage={setCurrentPage}
        setSelectedImsis={setSelectedImsis}
        selectedImsis={selectedImsis}
        canEditSubscribers={canEditSubscribers}
        setIsPolicyModalOpen={setIsPolicyModalOpen}
        setIsDataHubOpen={setIsDataHubOpen}
        handleBulkDelete={handleBulkDelete}
        isDeletingBulk={isDeletingBulk}
        pendingDelete={pendingDelete}
        handleOpenNew={handleOpenNew}
        setIsBatchOpen={setIsBatchOpen}
        mutateSubscribers={mutateSubscribers}
        setFeedback={setFeedback}
      />\n\n      `;

if (toolbarStart !== -1 && toolbarEnd !== -1) {
  content = content.substring(0, toolbarStart) + toolbarCode + content.substring(toolbarEnd);
}

// 5. Replace Table
const tableStartStr = '{/* Main Data Table */}';
const tableEndStr = '{/* FAB: Single Add */}';
const tableStart = content.indexOf(tableStartStr);
const tableEnd = content.indexOf(tableEndStr);

const tableCode = `<SubscriberTable
          isLoading={isLoading}
          totalSubscribers={totalSubscribers}
          searchQuery={searchQuery}
          statusFilter={statusFilter}
          canEditSubscribers={canEditSubscribers}
          handleOpenNew={handleOpenNew}
          isAllPageSelected={isAllPageSelected}
          selectedOnPageCount={selectedOnPageCount}
          pageImsis={pageImsis}
          toggleSelectAll={toggleSelectAll}
          sortField={sortField}
          handleSort={handleSort}
          renderSortIcon={renderSortIcon}
          paginatedSubscribers={paginatedSubscribers}
          selectedImsis={selectedImsis}
          setSelectedImsis={setSelectedImsis}
          copiedImsi={copiedImsi}
          handleCopyImsi={handleCopyImsi}
          resolveNetwork={resolveNetwork}
          formatBytes={formatBytes}
          formatFullDate={formatFullDate}
          timeAgo={timeAgo}
          handleOpenEdit={handleOpenEdit}
          handleDelete={handleDelete}
          isDeletingSingle={isDeletingSingle}
          pendingDelete={pendingDelete}
          activeDropdown={activeDropdown}
          setActiveDropdown={setActiveDropdown}
          setTraceImsi={setTraceImsi}
          handleOpenTrafficAdjustment={handleOpenTrafficAdjustment}
        />
        {!isLoading && (
          <SubscriberPagination
            currentPage={currentPage}
            totalPages={totalPages}
            displayPage={displayPage}
            pageSize={pageSize}
            totalSubscribers={totalSubscribers}
            getPageNumbers={getPageNumbers}
            setPageSize={setPageSize}
            setCurrentPage={setCurrentPage}
          />
        )}
      </div>
    </div>\n\n      `; // Added missing </div>!

if (tableStart !== -1 && tableEnd !== -1) {
  content = content.substring(0, tableStart) + '<div className="dash-card shadow table-card">\n        ' + tableCode + content.substring(tableEnd);
}

fs.writeFileSync('src/app/(dashboard)/subscribers/page.tsx', content);
console.log('Successfully refactored subscribers/page.tsx');
