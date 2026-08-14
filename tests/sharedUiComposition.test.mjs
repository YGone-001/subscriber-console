import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("analytics charts use the shared visual and summary contract", () => {
  const chartFiles = [
    "src/components/analytics/TopConsumerChart.tsx",
    "src/components/analytics/TariffPlanDistributionChart.tsx",
    "src/components/analytics/PlmnDistributionChart.tsx",
  ];

  for (const file of chartFiles) {
    const source = read(file);
    assert.match(source, /@\/components\/ui\/chartPrimitives/);
    assert.match(source, /<ChartSummary/);
    assert.doesNotMatch(source, /const\s+(?:COLORS|tooltipStyle)\s*=/);
  }

  const primitives = read("src/components/ui/chartPrimitives.tsx");
  assert.match(primitives, /CHART_TOOLTIP_STYLE/);
  assert.match(primitives, /CHART_SERIES_COLORS/);
  assert.match(primitives, /className="sr-only"/);
});

test("OCS data tables share state rows and pagination behavior", () => {
  const panelFiles = [
    "src/components/ocs/OcsBalancesPanel.tsx",
    "src/components/ocs/OcsSessionsPanel.tsx",
    "src/components/ocs/OcsUsagePanel.tsx",
  ];

  for (const file of panelFiles) {
    const source = read(file);
    assert.match(source, /<DataTableStateRow/);
    assert.match(source, /<DataTablePagination/);
    assert.doesNotMatch(source, /className="ocs-pagination"/);
  }

  const pagination = read("src/components/ui/DataTablePagination.tsx");
  assert.match(pagination, /<nav/);
  assert.match(pagination, /aria-live="polite"/);
  assert.match(pagination, /disabled=\{page <= 1\}/);
  assert.match(pagination, /disabled=\{page >= totalPages\}/);
});

test("rating forms and feedback use the shared field and notice contracts", () => {
  const ratingFiles = [
    "src/components/RatingManagementPage.tsx",
    "src/components/rating/PccRuleList.tsx",
    "src/components/rating/TariffPlanCloneModal.tsx",
    "src/components/rating/TariffPlanImportModal.tsx",
    "src/components/rating/TariffPlanList.tsx",
    "src/components/rating/TariffRuleModal.tsx",
  ];

  for (const file of ratingFiles) {
    const source = read(file);
    assert.match(source, /@\/components\/ui\/Field/);
    assert.doesNotMatch(source, /alert-banner alert-banner-(?:danger|warning)/);
  }

  assert.doesNotMatch(read("src/components/rating/types.tsx"), /export function Field/);
  assert.match(read("src/components/ui/Field.tsx"), /htmlFor=\{htmlFor\}/);
  assert.match(read("src/components/ui/InlineNotice.tsx"), /tone === "danger" \? "alert" : "status"/);
});
