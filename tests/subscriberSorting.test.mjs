import test from "node:test";
import assert from "node:assert/strict";

function sortSubscriberRows(rows, sortField, sortDirection) {
  const validSortFields = new Set(['imsi', 'status', 'plmn', 'policy', 'usage', 'lastActive']);
  const normalizedSortField = validSortFields.has(sortField) ? sortField : 'imsi';
  const normalizedSortDir = sortDirection === 'desc' ? 'desc' : 'asc';

  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (normalizedSortField === 'usage') {
      const valA = Number(a.traffic?.used || 0);
      const valB = Number(b.traffic?.used || 0);
      cmp = valA - valB;
    } else if (normalizedSortField === 'lastActive') {
      const timeA = new Date(a.lastActive).getTime();
      const timeB = new Date(b.lastActive).getTime();
      cmp = (Number.isNaN(timeA) ? 0 : timeA) - (Number.isNaN(timeB) ? 0 : timeB);
    } else if (normalizedSortField === 'plmn') {
      const valA = a.plmn || a.imsi.slice(0, 5);
      const valB = b.plmn || b.imsi.slice(0, 5);
      cmp = valA.localeCompare(valB);
    } else if (normalizedSortField === 'policy') {
      const valA = a.policyName || a.policy || '';
      const valB = b.policyName || b.policy || '';
      cmp = valA.localeCompare(valB);
    } else if (normalizedSortField === 'status') {
      cmp = (a.status || '').localeCompare(b.status || '');
    } else {
      cmp = a.imsi.localeCompare(b.imsi);
    }

    if (cmp !== 0) {
      return normalizedSortDir === 'desc' ? -cmp : cmp;
    }
    return a.imsi.localeCompare(b.imsi);
  });
}

const mockSubscribers = [
  {
    imsi: "460020000000003",
    status: "Suspended",
    ard: 255,
    plmn: "46002",
    policy: "plan_enterprise",
    policyName: "Enterprise Tier",
    traffic: { total: 10000, used: 8000, balance: 2000 },
    lastActive: "2026-08-01T10:00:00.000Z",
  },
  {
    imsi: "460020000000001",
    status: "Active",
    ard: 0,
    plmn: "46002",
    policy: "plan_basic",
    policyName: "Basic Tier",
    traffic: { total: 10000, used: 1000, balance: 9000 },
    lastActive: "2026-08-03T12:00:00.000Z",
  },
  {
    imsi: "454000000000002",
    status: "Active",
    ard: 0,
    plmn: "45400",
    policy: "plan_premium",
    policyName: "Premium Tier",
    traffic: { total: 10000, used: 5000, balance: 5000 },
    lastActive: "2026-08-02T08:00:00.000Z",
  },
];

test("sortSubscriberRows sorts by IMSI ascending and descending", () => {
  const asc = sortSubscriberRows(mockSubscribers, "imsi", "asc");
  assert.deepEqual(asc.map(s => s.imsi), [
    "454000000000002",
    "460020000000001",
    "460020000000003",
  ]);

  const desc = sortSubscriberRows(mockSubscribers, "imsi", "desc");
  assert.deepEqual(desc.map(s => s.imsi), [
    "460020000000003",
    "460020000000001",
    "454000000000002",
  ]);
});

test("sortSubscriberRows sorts by usage (traffic used)", () => {
  const asc = sortSubscriberRows(mockSubscribers, "usage", "asc");
  assert.deepEqual(asc.map(s => s.imsi), [
    "460020000000001", // 1000
    "454000000000002", // 5000
    "460020000000003", // 8000
  ]);

  const desc = sortSubscriberRows(mockSubscribers, "usage", "desc");
  assert.deepEqual(desc.map(s => s.imsi), [
    "460020000000003", // 8000
    "454000000000002", // 5000
    "460020000000001", // 1000
  ]);
});

test("sortSubscriberRows sorts by lastActive timestamp", () => {
  const asc = sortSubscriberRows(mockSubscribers, "lastActive", "asc");
  assert.deepEqual(asc.map(s => s.imsi), [
    "460020000000003", // 2026-08-01
    "454000000000002", // 2026-08-02
    "460020000000001", // 2026-08-03
  ]);

  const desc = sortSubscriberRows(mockSubscribers, "lastActive", "desc");
  assert.deepEqual(desc.map(s => s.imsi), [
    "460020000000001", // 2026-08-03
    "454000000000002", // 2026-08-02
    "460020000000003", // 2026-08-01
  ]);
});

test("sortSubscriberRows sorts by policy name", () => {
  const asc = sortSubscriberRows(mockSubscribers, "policy", "asc");
  assert.deepEqual(asc.map(s => s.imsi), [
    "460020000000001", // Basic Tier
    "460020000000003", // Enterprise Tier
    "454000000000002", // Premium Tier
  ]);

  const desc = sortSubscriberRows(mockSubscribers, "policy", "desc");
  assert.deepEqual(desc.map(s => s.imsi), [
    "454000000000002", // Premium Tier
    "460020000000003", // Enterprise Tier
    "460020000000001", // Basic Tier
  ]);
});

test("sortSubscriberRows sorts by PLMN network prefix", () => {
  const asc = sortSubscriberRows(mockSubscribers, "plmn", "asc");
  assert.deepEqual(asc.map(s => s.imsi), [
    "454000000000002", // 45400
    "460020000000001", // 46002
    "460020000000003", // 46002
  ]);
});
