import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("analytics charts expose a shared, keyboard-native data table view", () => {
  const dataTable = read("src/components/ui/ChartDataTable.tsx");
  assert.match(dataTable, /<details/);
  assert.match(dataTable, /<summary/);
  assert.match(dataTable, /<caption className="sr-only"/);
  assert.match(dataTable, /scope="col"/);

  for (const file of [
    "src/components/analytics/TopConsumerChart.tsx",
    "src/components/analytics/TariffPlanDistributionChart.tsx",
    "src/components/analytics/PlmnDistributionChart.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /<ChartDataTable/);
    assert.match(source, /chart_data_table/);
  }
});

test("dense tables declare responsive column priorities", () => {
  const globals = read("src/app/globals.css");
  assert.match(globals, /@media \(max-width: 980px\)[\s\S]*data-column-priority="supplementary"/);
  assert.match(globals, /@media \(max-width: 760px\)[\s\S]*data-column-priority="important"/);

  for (const file of [
    "src/app/(dashboard)/subscribers/components/SubscriberTable.tsx",
    "src/components/ocs/OcsBalancesPanel.tsx",
    "src/components/ocs/OcsSessionsPanel.tsx",
    "src/components/ocs/OcsUsagePanel.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /data-column-priority="essential"/);
    assert.match(source, /data-column-priority="important"/);
    assert.match(source, /data-column-priority="supplementary"/);
  }

  const usersTable = read("src/app/(dashboard)/users/components/UsersTable.tsx");
  assert.match(usersTable, /data-column-priority="essential"/);
  assert.match(usersTable, /data-column-priority="important"/);
  assert.doesNotMatch(usersTable, /data-column-priority="supplementary"/);

  for (const file of [
    "src/components/DataHub.tsx",
    "src/components/users/ApprovalCenterPanel.tsx",
    "src/components/rating/PccRuleList.tsx",
    "src/components/rating/TariffPlanList.tsx",
    "src/app/(dashboard)/system-health/page.tsx",
    "src/app/(dashboard)/audit-logs/page.tsx",
  ]) {
    const source = read(file);
    const table = source.match(/<table[\s\S]*?<\/table>/)?.[0] ?? "";
    assert.ok(table, `${file} should contain a table`);
    assert.match(table, /data-column-priority="essential"/);
    assert.match(table, /data-column-priority="(?:important|supplementary)"/);
    assert.doesNotMatch(table, /<th(?=\s|>)(?![^>]*data-column-priority)[^>]*>/);
    assert.doesNotMatch(table, /<td(?=\s|>)(?![^>]*(?:data-column-priority|colSpan))[^>]*>/);
  }
});

test("long forms protect unsaved edits across dialogs and navigation", () => {
  const guard = read("src/components/ui/UnsavedChangesGuard.tsx");
  const dialogFocus = read("src/components/ui/useDialogFocus.ts");
  assert.match(guard, /beforeunload/);
  assert.match(guard, /role="alertdialog"/);
  assert.match(guard, /aria-modal="true"/);
  assert.match(guard, /useDialogFocus/);
  assert.match(guard, /document\.addEventListener\("click", handleNavigationClick, true\)/);
  assert.match(guard, /router\.push\(pendingNavigation\)/);
  assert.match(dialogFocus, /sibling\.inert = true/);
  assert.match(dialogFocus, /event\.key === "Escape"/);
  assert.match(dialogFocus, /event\.key !== "Tab"/);
  assert.match(dialogFocus, /previousFocus\?\.focus\(\)/);
  assert.match(dialogFocus, /dialogStack\.at\(-1\) !== dialog/);
  assert.match(dialogFocus, /event\.stopImmediatePropagation\(\)/);

  for (const file of ["src/components/SubscriberModal.tsx", "src/components/ProfileModal.tsx"]) {
    const source = read(file);
    assert.match(source, /useUnsavedChangesGuard/);
    assert.match(source, /<UnsavedChangesDialog/);
    assert.match(source, /draftSignature/);
    assert.match(source, /unsavedGuard\.requestClose/);
  }
});

test("high-risk dialogs and drawers share the production focus contract", () => {
  const dialog = read("src/components/ui/Dialog.tsx");
  const feedback = read("src/components/OperationFeedback.tsx");

  assert.match(dialog, /useDialogFocus/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /closeOnOverlay/);
  assert.match(feedback, /role="alertdialog"/);
  assert.match(feedback, /initialFocusRef=\{cancelRef\}/);
  assert.doesNotMatch(feedback, /autoFocus/);

  for (const file of [
    "src/components/ocs/OcsDetailDrawer.tsx",
    "src/app/(dashboard)/users/components/UserDrawer.tsx",
    "src/components/users/RoleManagementPanel.tsx",
    "src/components/users/ApprovalCenterPanel.tsx",
    "src/components/SubscriberModal.tsx",
    "src/components/ProfileModal.tsx",
    "src/components/TrafficAdjustmentModal.tsx",
    "src/components/BulkPolicyModal.tsx",
    "src/components/BatchCreateModal.tsx",
    "src/components/SubscriberTraceModal.tsx",
    "src/components/rating/TariffRuleModal.tsx",
    "src/components/rating/TariffPlanImportModal.tsx",
    "src/components/rating/TariffPlanCloneModal.tsx",
    "src/app/(dashboard)/audit-logs/page.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /<Dialog/);
    assert.doesNotMatch(source, /<div className="modal-overlay/);
    assert.doesNotMatch(source, /role="dialog" aria-modal="true"/);
  }
});
