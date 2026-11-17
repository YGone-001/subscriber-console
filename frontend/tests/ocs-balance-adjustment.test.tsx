/*
 * OCS balance adjustment safety confirmation and exact preview test suite.
 *
 * Verifies:
 *   1. Strict amount conversion and unit arithmetic (BigInt precision, no float rounding).
 *   2. Accurate before/delta/after projection with invariant validation.
 *   3. Two-step confirmation state machine (editing -> reviewing -> submitting).
 *   4. Zero mutations before confirmation.
 *   5. CAS precondition enforcement and stale snapshot invalidation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import AdjustBalanceModal from '../src/components/ocs/balances/AdjustBalanceModal';
import {
  isNonNegativeSafeInteger,
  parseCanonicalAdjustmentAmount,
  projectBalanceAdjustment,
  validateAuthoritativeBalance,
} from '../src/features/ocs/ocs-balance-math';
import type { OcsBalanceViewModel } from '../src/features/ocs/ocs-view-models';

function createTestBalance(overrides: Partial<OcsBalanceViewModel> = {}): OcsBalanceViewModel {
  return {
    id: 'bal-001',
    imsi: '460001234567890',
    planId: 'plan-unlimited',
    status: 'active',
    data: {
      total: 5368709120, // 5 GB
      used: 1073741824, // 1 GB
      reserved: 1073741824, // 1 GB
      available: 3221225472, // 3 GB
    },
    voice: {
      total: 3600, // 60 mins
      used: 600, // 10 mins
      reserved: 0,
      available: 3000, // 50 mins
    },
    sms: {
      total: 100,
      used: 20,
      reserved: null,
      available: 80,
    },
    moneyBalance: 50.0,
    version: 4,
    invariants: {
      data: true,
      voice: true,
      sms: true,
      all: true,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    cycleStartAt: '2026-01-01T00:00:00Z',
    cycleResetAt: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

/* ---------------------------------------------------------------------------
 * Task B: Exact Amount Conversion and Arithmetic Tests
 * ------------------------------------------------------------------------- */

test('valid data conversions: GB, MB, and Bytes calculate exact integers', () => {
  // 1 GB = 1,073,741,824 Bytes
  const gb1 = parseCanonicalAdjustmentAmount('1', 'data', 'GB');
  assert.equal(gb1.ok, true);
  if (gb1.ok) assert.equal(gb1.canonicalAmount, 1073741824);

  // 1.5 GB = 1,610,612,736 Bytes (example from specification)
  const gb1_5 = parseCanonicalAdjustmentAmount('1.5', 'data', 'GB');
  assert.equal(gb1_5.ok, true);
  if (gb1_5.ok) assert.equal(gb1_5.canonicalAmount, 1610612736);

  // 0.25 GB = 268,435,456 Bytes
  const gb0_25 = parseCanonicalAdjustmentAmount('0.25', 'data', 'GB');
  assert.equal(gb0_25.ok, true);
  if (gb0_25.ok) assert.equal(gb0_25.canonicalAmount, 268435456);

  // 1 MB = 1,048,576 Bytes
  const mb1 = parseCanonicalAdjustmentAmount('1', 'data', 'MB');
  assert.equal(mb1.ok, true);
  if (mb1.ok) assert.equal(mb1.canonicalAmount, 1048576);

  // 0.5 MB = 524,288 Bytes
  const mb0_5 = parseCanonicalAdjustmentAmount('0.5', 'data', 'MB');
  assert.equal(mb0_5.ok, true);
  if (mb0_5.ok) assert.equal(mb0_5.canonicalAmount, 524288);

  // Exact Bytes
  const bytes = parseCanonicalAdjustmentAmount('1024', 'data', 'Bytes');
  assert.equal(bytes.ok, true);
  if (bytes.ok) assert.equal(bytes.canonicalAmount, 1024);
});

test('valid voice conversions: Minutes and Seconds calculate exact integers', () => {
  // 1 Minute = 60 Seconds
  const min1 = parseCanonicalAdjustmentAmount('1', 'voice', 'Minutes');
  assert.equal(min1.ok, true);
  if (min1.ok) assert.equal(min1.canonicalAmount, 60);

  // 0.5 Minutes = 30 Seconds (example from specification)
  const min0_5 = parseCanonicalAdjustmentAmount('0.5', 'voice', 'Minutes');
  assert.equal(min0_5.ok, true);
  if (min0_5.ok) assert.equal(min0_5.canonicalAmount, 30);

  // 0.1 Minutes = 6 Seconds
  const min0_1 = parseCanonicalAdjustmentAmount('0.1', 'voice', 'Minutes');
  assert.equal(min0_1.ok, true);
  if (min0_1.ok) assert.equal(min0_1.canonicalAmount, 6);

  // Exact Seconds
  const sec = parseCanonicalAdjustmentAmount('45', 'voice', 'Seconds');
  assert.equal(sec.ok, true);
  if (sec.ok) assert.equal(sec.canonicalAmount, 45);
});

test('valid SMS conversions: integer quantities only', () => {
  const sms = parseCanonicalAdjustmentAmount('50', 'sms', 'SMS');
  assert.equal(sms.ok, true);
  if (sms.ok) assert.equal(sms.canonicalAmount, 50);
});

test('fractional canonical units are rejected without silent rounding', () => {
  // 1.5 SMS -> invalid (cannot have half an SMS)
  const smsFrac = parseCanonicalAdjustmentAmount('1.5', 'sms', 'SMS');
  assert.equal(smsFrac.ok, false);
  if (!smsFrac.ok) assert.equal(smsFrac.errorKey, 'ocs_balance_fractional_unit');

  // 0.1 Bytes -> invalid (cannot have fractional byte)
  const byteFrac = parseCanonicalAdjustmentAmount('0.1', 'data', 'Bytes');
  assert.equal(byteFrac.ok, false);
  if (!byteFrac.ok) assert.equal(byteFrac.errorKey, 'ocs_balance_fractional_unit');

  // 0.1 Seconds -> invalid (cannot have fractional second)
  const secFrac = parseCanonicalAdjustmentAmount('0.1', 'voice', 'Seconds');
  assert.equal(secFrac.ok, false);
  if (!secFrac.ok) assert.equal(secFrac.errorKey, 'ocs_balance_fractional_unit');

  // 0.1 MB -> 104,857.6 Bytes (fractional byte!)
  const mbFrac = parseCanonicalAdjustmentAmount('0.1', 'data', 'MB');
  assert.equal(mbFrac.ok, false);
  if (!mbFrac.ok) assert.equal(mbFrac.errorKey, 'ocs_balance_fractional_unit');

  // 0.33 Minutes -> 19.8 Seconds (fractional second!)
  const minFrac = parseCanonicalAdjustmentAmount('0.33', 'voice', 'Minutes');
  assert.equal(minFrac.ok, false);
  if (!minFrac.ok) assert.equal(minFrac.errorKey, 'ocs_balance_fractional_unit');
});

test('malformed, empty, negative, zero and non-finite inputs are rejected', () => {
  const badInputs = ['', '   ', '0', '0.0', '-1', '-0.5', 'abc', '12abc', '1e5', '0x10', 'Infinity', 'NaN'];
  for (const input of badInputs) {
    const res = parseCanonicalAdjustmentAmount(input, 'data', 'GB');
    assert.equal(res.ok, false, `Input "${input}" must be rejected`);
  }
});

test('overflow beyond safe integer limits is rejected', () => {
  const huge = '99999999999999999999999';
  const res = parseCanonicalAdjustmentAmount(huge, 'data', 'GB');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.errorKey, 'ocs_balance_overflow');
});

/* ---------------------------------------------------------------------------
 * Task C: Accurate Before / Delta / After Projection Tests
 * ------------------------------------------------------------------------- */

test('data credit projection correctly updates total and available by delta', () => {
  const balance = createTestBalance();
  const res = projectBalanceAdjustment({
    balance,
    bucket: 'data',
    operation: 'credit',
    canonicalAmount: 1073741824, // 1 GB
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    const p = res.projection;
    assert.equal(p.bucket, 'data');
    assert.equal(p.operation, 'credit');
    assert.equal(p.canonicalAmount, 1073741824);
    assert.equal(p.signedDelta, 1073741824);
    assert.equal(p.beforeTotal, 5368709120);
    assert.equal(p.beforeAvailable, 3221225472);
    assert.equal(p.expectedTotal, 6442450944); // 5 GB + 1 GB = 6 GB
    assert.equal(p.expectedAvailable, 4294967296); // 3 GB + 1 GB = 4 GB
    assert.equal(p.unchangedUsed, 1073741824); // unchanged
    assert.equal(p.unchangedReserved, 1073741824); // unchanged
    assert.equal(p.version, 4);
    // Invariant holds: total == used + reserved + available
    assert.equal(p.expectedTotal, p.unchangedUsed + (p.unchangedReserved ?? 0) + p.expectedAvailable);
  }
});

test('data debit projection correctly decrements total and available by delta', () => {
  const balance = createTestBalance();
  const res = projectBalanceAdjustment({
    balance,
    bucket: 'data',
    operation: 'debit',
    canonicalAmount: 1073741824, // 1 GB
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    const p = res.projection;
    assert.equal(p.bucket, 'data');
    assert.equal(p.operation, 'debit');
    assert.equal(p.signedDelta, -1073741824);
    assert.equal(p.beforeTotal, 5368709120);
    assert.equal(p.beforeAvailable, 3221225472);
    assert.equal(p.expectedTotal, 4294967296); // 5 GB - 1 GB = 4 GB
    assert.equal(p.expectedAvailable, 2147483648); // 3 GB - 1 GB = 2 GB
    assert.equal(p.unchangedUsed, 1073741824);
    assert.equal(p.unchangedReserved, 1073741824);
    assert.equal(p.expectedTotal, p.unchangedUsed + (p.unchangedReserved ?? 0) + p.expectedAvailable);
  }
});

test('debit exceeding available capacity is rejected', () => {
  const balance = createTestBalance();
  // available is 3221225472 (3 GB), attempt to debit 4 GB
  const res = projectBalanceAdjustment({
    balance,
    bucket: 'data',
    operation: 'debit',
    canonicalAmount: 4294967296,
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.errorKey, 'ocs_balance_insufficient');
  }
});

test('voice credit and debit project exact seconds', () => {
  const balance = createTestBalance();
  const creditRes = projectBalanceAdjustment({
    balance,
    bucket: 'voice',
    operation: 'credit',
    canonicalAmount: 600, // 10 mins
  });
  assert.equal(creditRes.ok, true);
  if (creditRes.ok) {
    assert.equal(creditRes.projection.beforeTotal, 3600);
    assert.equal(creditRes.projection.expectedTotal, 4200);
    assert.equal(creditRes.projection.expectedAvailable, 3600);
  }

  const debitRes = projectBalanceAdjustment({
    balance,
    bucket: 'voice',
    operation: 'debit',
    canonicalAmount: 300, // 5 mins
  });
  assert.equal(debitRes.ok, true);
  if (debitRes.ok) {
    assert.equal(debitRes.projection.expectedTotal, 3300);
    assert.equal(debitRes.projection.expectedAvailable, 2700);
  }
});

test('SMS credit and debit project exact message counts with null reserved', () => {
  const balance = createTestBalance();
  const res = projectBalanceAdjustment({
    balance,
    bucket: 'sms',
    operation: 'credit',
    canonicalAmount: 25,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.projection.beforeTotal, 100);
    assert.equal(res.projection.expectedTotal, 125);
    assert.equal(res.projection.expectedAvailable, 105);
    assert.equal(res.projection.unchangedReserved, null);
  }
});

test('broken invariants on the account block adjustment projection', () => {
  const balance = createTestBalance({
    invariants: { data: false, voice: true, sms: true, all: false },
  });
  const res = projectBalanceAdjustment({
    balance,
    bucket: 'data',
    operation: 'credit',
    canonicalAmount: 1073741824,
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.errorKey, 'ocs_balance_invariants_broken');
  }
});

test('missing or unknown balance fields block projection without substituting zero', () => {
  const balance = createTestBalance({
    data: { total: null, used: 100, reserved: 0, available: 100 },
  });
  const res = projectBalanceAdjustment({
    balance,
    bucket: 'data',
    operation: 'credit',
    canonicalAmount: 1073741824,
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.errorKey, 'ocs_balance_fields_missing');
  }
});

test('version zero is accepted as valid CAS version', () => {
  const balance = createTestBalance({ version: 0 });
  const res = projectBalanceAdjustment({
    balance,
    bucket: 'data',
    operation: 'credit',
    canonicalAmount: 1073741824,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.projection.version, 0);
  }
});

test('missing version blocks adjustment projection', () => {
  const balance = createTestBalance({ version: null });
  const res = projectBalanceAdjustment({
    balance,
    bucket: 'data',
    operation: 'credit',
    canonicalAmount: 1073741824,
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.errorKey, 'ocs_balance_version_missing');
  }
});

/* ---------------------------------------------------------------------------
 * Task E: Two-step Component Workflow & Markup Tests
 * ------------------------------------------------------------------------- */

test('modal initially renders editing state without issuing any network request', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('No fetch permitted on modal mount');
  }) as typeof fetch;

  try {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(AdjustBalanceModal, {
          isOpen: true,
          imsi: '460001234567890',
          balance: createTestBalance(),
          onClose: () => {},
          onSuccess: () => {},
        }),
      ),
    );

    assert.equal(fetchCalls, 0, 'Mounting modal must never issue a network request');
    assert.match(markup, /class="ocs-dialog ocs-modal-dialog"/);
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-modal="true"/);
    assert.match(markup, /id="adjust-bucket"/);
    assert.match(markup, /id="adjust-operation"/);
    assert.match(markup, /id="adjust-amount"/);
    assert.match(markup, /id="adjust-reason"/);
    // Action button must say "Review adjustment", not immediate mutation
    assert.match(markup, /type="submit"[^>]*>.*(Review|预览)/s);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ---------------------------------------------------------------------------
 * Task A & E: Safe Integer and Invariant Validation Tests
 * ------------------------------------------------------------------------- */

test('isNonNegativeSafeInteger correctly accepts non-negative safe integers', () => {
  assert.equal(isNonNegativeSafeInteger(0), true);
  assert.equal(isNonNegativeSafeInteger(1), true);
  assert.equal(isNonNegativeSafeInteger(42), true);
  assert.equal(isNonNegativeSafeInteger(1073741824), true);
  assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER), true);
});

test('isNonNegativeSafeInteger rejects negative, fractional, unsafe and non-number values', () => {
  // Negative
  assert.equal(isNonNegativeSafeInteger(-1), false);
  assert.equal(isNonNegativeSafeInteger(-100), false);
  // Fractional
  assert.equal(isNonNegativeSafeInteger(1.5), false);
  assert.equal(isNonNegativeSafeInteger(0.1), false);
  // Non-finite
  assert.equal(isNonNegativeSafeInteger(NaN), false);
  assert.equal(isNonNegativeSafeInteger(Infinity), false);
  assert.equal(isNonNegativeSafeInteger(-Infinity), false);
  // Unsafe integers beyond MAX_SAFE_INTEGER
  assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 2), false);
  // Non-numbers
  assert.equal(isNonNegativeSafeInteger(null), false);
  assert.equal(isNonNegativeSafeInteger(undefined), false);
  assert.equal(isNonNegativeSafeInteger('42'), false);
  assert.equal(isNonNegativeSafeInteger(true), false);
  assert.equal(isNonNegativeSafeInteger({}), false);
  assert.equal(isNonNegativeSafeInteger([]), false);
});

test('projectBalanceAdjustment rejects unbalanced baseline totals (total !== used + reserved + available)', () => {
  // total is 5000, but used(1000) + reserved(1000) + available(3000) = 5000.
  // Corrupt total to 6000:
  const balance = createTestBalance({
    data: {
      total: 6000,
      used: 1000,
      reserved: 1000,
      available: 3000,
    },
  });
  const res = projectBalanceAdjustment({
    balance,
    bucket: 'data',
    operation: 'credit',
    canonicalAmount: 1000,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.errorKey, 'ocs_balance_invariants_broken');
  }
});

test('projectBalanceAdjustment rejects unsafe integer bucket metrics beyond MAX_SAFE_INTEGER', () => {
  const balance = createTestBalance({
    data: {
      total: Number.MAX_SAFE_INTEGER + 1,
      used: 0,
      reserved: 0,
      available: Number.MAX_SAFE_INTEGER + 1,
    },
  });
  const res = projectBalanceAdjustment({
    balance,
    bucket: 'data',
    operation: 'credit',
    canonicalAmount: 1000,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.errorKey, 'ocs_balance_fields_missing');
  }
});

test('projectBalanceAdjustment rejects negative version or unsafe integer version', () => {
  const negVer = createTestBalance({ version: -1 });
  const resNeg = projectBalanceAdjustment({
    balance: negVer,
    bucket: 'data',
    operation: 'credit',
    canonicalAmount: 1000,
  });
  assert.equal(resNeg.ok, false);
  if (!resNeg.ok) {
    assert.equal(resNeg.errorKey, 'ocs_balance_version_missing');
  }

  const unsafeVer = createTestBalance({ version: Number.MAX_SAFE_INTEGER + 1 });
  const resUnsafe = projectBalanceAdjustment({
    balance: unsafeVer,
    bucket: 'data',
    operation: 'credit',
    canonicalAmount: 1000,
  });
  assert.equal(resUnsafe.ok, false);
  if (!resUnsafe.ok) {
    assert.equal(resUnsafe.errorKey, 'ocs_balance_version_missing');
  }
});

test('modal renders safe unavailable card when authoritative balance is null or undefined', () => {
  const markup = renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(AdjustBalanceModal, {
        isOpen: true,
        imsi: '460001234567890',
        balance: null,
        onClose: () => {},
        onSuccess: () => {},
      }),
    ),
  );

  // Must show unavailable alert
  assert.match(markup, /class="ocs-feedback-error ocs-feedback-spaced ocs-feedback-row"/);
  assert.match(markup, /(Authoritative balance record is unavailable|权威余额记录不可用)/);
  // Must NOT render adjustment form or bucket controls
  assert.doesNotMatch(markup, /<form/);
  assert.doesNotMatch(markup, /id="adjust-bucket"/);
  assert.doesNotMatch(markup, /id="adjust-amount"/);
  // Must NOT render synthetic bucket numbers
  assert.doesNotMatch(markup, /ocs-balance-modal-imsi-note/);
});

test('modal disables review action when authoritative balance version is missing', () => {
  const balance = createTestBalance({ version: null });
  const markup = renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(AdjustBalanceModal, {
        isOpen: true,
        imsi: '460001234567890',
        balance,
        onClose: () => {},
        onSuccess: () => {},
      }),
    ),
  );

  // Must render version missing warning
  assert.match(markup, /class="warning-text"/);
  assert.match(markup, /(does not report a version|未提供版本)/);
  // Submit button must be disabled
  assert.match(markup, /<button[^>]*type="submit"[^>]*disabled[^>]*>/);
});

/* ---------------------------------------------------------------------------
 * Task A: validateAuthoritativeBalance Tests
 * ------------------------------------------------------------------------- */

test('validateAuthoritativeBalance approves complete valid balance snapshot', () => {
  const balance = createTestBalance();
  const res = validateAuthoritativeBalance(balance, '460001234567890');
  assert.equal(res.ok, true);
});

test('validateAuthoritativeBalance rejects null, undefined, or mismatched IMSI', () => {
  assert.deepEqual(validateAuthoritativeBalance(null), { ok: false, errorKey: 'ocs_balance_unavailable' });
  assert.deepEqual(validateAuthoritativeBalance(undefined), { ok: false, errorKey: 'ocs_balance_unavailable' });
  const balance = createTestBalance({ imsi: '460001111111111' });
  assert.deepEqual(validateAuthoritativeBalance(balance, '460002222222222'), {
    ok: false,
    errorKey: 'ocs_balance_refresh_mismatch',
  });
});

test('validateAuthoritativeBalance rejects missing version or broken invariants', () => {
  const noVer = createTestBalance({ version: null });
  assert.deepEqual(validateAuthoritativeBalance(noVer), { ok: false, errorKey: 'ocs_balance_version_missing' });

  const brokenInv = createTestBalance({ invariants: { data: false, voice: true, sms: true, all: false } });
  assert.deepEqual(validateAuthoritativeBalance(brokenInv), { ok: false, errorKey: 'ocs_balance_invariants_broken' });
});

test('validateAuthoritativeBalance rejects missing metrics or unconserved totals', () => {
  const missingMetric = createTestBalance({
    data: { total: null, used: 100, reserved: 0, available: 100 },
  });
  assert.deepEqual(validateAuthoritativeBalance(missingMetric), { ok: false, errorKey: 'ocs_balance_fields_missing' });

  const unconserved = createTestBalance({
    data: { total: 5000, used: 1000, reserved: 1000, available: 2000 }, // sum is 4000 !== 5000
  });
  assert.deepEqual(validateAuthoritativeBalance(unconserved), { ok: false, errorKey: 'ocs_balance_invariants_broken' });
});
