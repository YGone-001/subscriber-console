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
    "src/app/(dashboard)/users/components/UsersTable.tsx",
    "src/components/ocs/OcsBalancesPanel.tsx",
    "src/components/ocs/OcsSessionsPanel.tsx",
    "src/components/ocs/OcsUsagePanel.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /data-column-priority="essential"/);
    assert.match(source, /data-column-priority="important"/);
    assert.match(source, /data-column-priority="supplementary"/);
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

  for (const file of ["src/components/SubscriberModal.tsx", "src/components/ProfileModal.tsx"]) {
    const source = read(file);
    assert.match(source, /useUnsavedChangesGuard/);
    assert.match(source, /<UnsavedChangesDialog/);
    assert.match(source, /draftSignature/);
    assert.match(source, /unsavedGuard\.requestClose/);
  }
});
