import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function listTsxFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTsxFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [entryPath] : [];
  });
}

test("every data table has a screen-reader caption", () => {
  const tableFiles = listTsxFiles(path.join(projectRoot, "src")).filter((file) => readFileSync(file, "utf8").includes("<table"));

  assert.ok(tableFiles.length > 0);
  for (const file of tableFiles) {
    const source = readFileSync(file, "utf8");
    const tableCount = source.match(/<table\b/g)?.length ?? 0;
    const captionCount = source.match(/<caption\b[^>]*className="sr-only"/g)?.length ?? 0;
    assert.equal(captionCount, tableCount, `${path.relative(projectRoot, file)} must caption every table`);
  }
});

test("sortable data tables expose their active sort direction", () => {
  const subscriberTable = read("src/app/(dashboard)/subscribers/components/SubscriberTable.tsx");
  const usersTable = read("src/app/(dashboard)/users/components/UsersTable.tsx");
  const sessionsTable = read("src/components/ocs/OcsSessionsPanel.tsx");
  const balancesTable = read("src/components/ocs/OcsBalancesPanel.tsx");

  assert.match(subscriberTable, /SortableTableHeader/);
  assert.match(read("src/components/ui/SortableTableHeader.tsx"), /aria-sort=/);
  for (const key of ["username", "status", "lastLoginAt"]) {
    assert.match(usersTable, new RegExp(`aria-sort=\\{getAriaSort\\("${key}"\\)\\}`));
  }
  assert.match(sessionsTable, /aria-sort=\{getAriaSort\("last_update_at"\)\}/);
  assert.match(sessionsTable, /aria-sort=\{getAriaSort\(\["granted_total", "used_total"\]\)\}/);
  assert.match(balancesTable, /aria-sort=\{getAriaSort\("updated_at"\)\}/);
  assert.match(balancesTable, /aria-sort=\{getAriaSort\(\["data_total", "data_used"\]\)\}/);
});

test("data charts expose summaries and decorative KPI charts stay hidden", () => {
  const chartFiles = [
    "src/components/analytics/TopConsumerChart.tsx",
    "src/components/analytics/TariffPlanDistributionChart.tsx",
    "src/components/analytics/PlmnDistributionChart.tsx",
  ];

  for (const file of chartFiles) {
    const source = read(file);
    assert.match(source, /role=.*"img"/);
    assert.match(source, /aria-labelledby=/);
    assert.match(source, /aria-describedby=/);
    assert.match(source, /ChartSummary/);
  }

  assert.match(read("src/components/ui/chartPrimitives.tsx"), /className="sr-only"/);

  assert.match(read("src/components/analytics/KpiCard.tsx"), /className="analytics-sparkline"[^>]*aria-hidden="true"/);

  for (const locale of ["src/lib/locales/en.ts", "src/lib/locales/zh.ts"]) {
    const source = read(locale);
    assert.match(source, /dash_chart_top5_summary:/);
    assert.match(source, /dash_chart_tariff_plan_summary:/);
    assert.match(source, /dash_chart_plmn_summary:/);
  }
});
