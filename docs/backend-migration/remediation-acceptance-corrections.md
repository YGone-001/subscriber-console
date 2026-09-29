# Controlled remediation acceptance corrections

Status: Phase 7.4 CORRECTION IMPLEMENTED / NOT FROZEN. Frozen: NO. Independent review is required.
Phase 7.3 is COMPLETE / FROZEN. Phase 7.5 is NOT STARTED / RECOVERY PENDING; Phase 8 is NOT STARTED.

Correction baseline: `eb8558ef32935cfd79e74503b3fd3970ce315f14`.
Run #142 covers that baseline only; it is not evidence for this correction.
The task final report must identify the new push CI run and its exact final SHA.

## Scope and production parity defect

The acceptance suite is `scripts/test-phase-7-system-heal-parity.mjs`.
It registers all required IDs before execution and rejects missing/duplicate IDs
both before and after execution. Each ID calls an independent counted assertion.

Full persisted-document comparison through real Node and Go HTTP requests first
failed at SH-A07 when creating a default subscriber. The persisted default IMS
PCC rule differed:

| Field | Authoritative Node | Go before correction | Go after correction |
|---|---|---|---|
| qos.arp.pre_emption_capability | 1 | 2 | 1 |
| qos.arp.pre_emption_vulnerability | 1 | 2 | 1 |
| qos.gbr / qos.mbr | downlink and uplink, each {value:128, unit:1} | flat {value:128, unit:1} | directional fields matching Node |

Only these fields in `backend/internal/remediation/repository.go` were corrected.
`TestDefaultSubscriberPCCMatchesNodePersistence` is the focused regression.
The HTTP matrix also compares the complete resulting documents on every
missing-subscriber healing branch. Normalization retains generated-field presence
and BSON types, and masks only independently generated ObjectIds and clock values.
Node production behavior, handler APIs, routing and schemas are unchanged.

## Continuous persistent-state re-scan evidence

All five targets are established in exactly one initial fixture batch. From
PROTECTED SEQUENCE START to the final cumulative verification the harness performs
zero MongoDB writes. Each step performs a real pre-scan on both engines, asserts
the specific anomaly, sends an authorized heal HTTP request to each engine,
compares complete persisted business documents, and immediately performs a real
post-scan. Every step also re-verifies that all previously healed targets still
hold their persisted outcome, so the suite proves one evolving state machine
rather than five isolated cases. Mongo command monitoring asserts zero harness
fixture writes between steps. No manual HSS, balance, tariff, profile or
reservation repair is performed.

Executable evidence: `rs_initial_fixture_batches=1`, `rs_interstep_fixture_writes=0`,
`rs_sequence_continuous=true`, `rs_cumulative_state_verified=true`.

| ID | Type | Pre-scan | Heal HTTP | State parity | Inherited state | Manual DB repair | Post-scan Node | Post-scan Go | Result |
|---|---|---|---|---|---|---|---|---|---|
| RS01 | missing_config | observed | 200 / 200 | PASS | n/a (first step) | NO | missing_config remains | missing_config remains | PASS |
| RS02 | balance_mismatch | observed | 200 / 200 | PASS | RS01 persisted | NO | cleared | cleared | PASS |
| RS03 | invalid_tariff | observed | 200 / 200 | PASS | RS01+RS02 persisted | NO | cleared | cleared | PASS |
| RS04 | dangling_profile | observed | 200 / 200 | PASS | RS01-RS03 persisted | NO | cleared | cleared | PASS |
| RS05 | orphan_reservation | observed | 200 / 200 | PASS | RS01-RS04 persisted | NO | orphan_reservation remains | orphan_reservation remains | PASS |

### Residual scanner/remediation contracts

- RS01: the HSS scanner still finds missing security.k/security.opc, slice and
  ambr. The authoritative heal provisions OCS subscriber and balance state but
  does not populate those fields on an existing HSS subscriber. Both engines
  preserve that result. Future contract design is required if scanner closure is
  desired; no behavior extension belongs in this parity correction.
- RS05: the heal changes reservation state to released and adds released_at.
  The scanner checks missing session_id / missing referenced session regardless
  of released state, so this fixture remains anomalous. Both engines preserve
  that behavior. Whether released reservations should be ignored is a future
  contract-design issue.
- RS02 proves data_total = data_used + data_reserved + data_available after heal.
  RS03 persists plan_default_10gb. RS04 persists the default profile reference;
  that profile exists in the initial fixture, before either scan.

## Failure and malformed-item evidence

MongoDB validation rejects actual production-driver writes in random, isolated
fixture databases. MongoDB system.profile records prove the storage error on
both engines. No production fault switch, magic request selector or limiter
bypass is introduced. Audit retries complete while the validator is active;
business version=1 proves a committed single execution without rollback.

SH-F01 exercises a real rejected business write. SH-F02/BH-F02 exercise audit
persistence rejection. SH-F03/BH-F03 reject limiter storage and prove fail-open
HTTP success plus persisted business parity.

BH-F01 exercises the real batch repository helper exception that escapes its
per-item catch: a null item's imsi access throws again while formatting the error.
The first item's subscriber and OCS writes remain committed (balance version=1),
the response is HTTP 500, and the third item is not executed. Ordinary MongoDB
errors do not escape this authoritative helper; they are captured per item.

BH-M01 through BH-M07 separately print exact status, full response body and
committed IMSIs. Empty/missing-imsi/string/numeric/boolean items are captured
failures; a missing type can succeed and create the subscriber; null escapes.
Success / captured failure / subsequent success is independently checked by
BH-I07. Unknown types retain Node behavior without an enum whitelist.

## Invariants and accounting

- Required IDs: 96; executed: 96; missing: 0; duplicate: 0.
- Single: 52; batch: 44; continuous RS steps: 5; distinct invariants: 5.
- RS01-RS05 run as one continuous persistent-state sequence: initial fixture
  batches: 1; inter-step harness fixture writes: 0; cumulative state verified.
- Corrected local suite: TOTAL 106, PASS 106, FAIL 0, SKIP 0.
- Protected collections use count plus stable content digest, including document
  identities, dates and nested fields. app_approvals remains empty and unchanged.
- Static production call-site checks and a dynamic scan/idle probe preserve
  explicit authenticated remediation, with no automatic scan-to-heal path.
- CUTOVER_TABLE=36; ACTUALLY_ROUTED=36; Phase 7 production cutover=0.
- Both remediation production owners remain Node. No fallback or dual write.

## Independently executed mandatory inventory

Every row below comes from the corrected local suite's actual PASS output.

| ID | Case | Result |
|---|---|---|
| SH-A01 | no token | PASS |
| SH-A02 | invalid token | PASS |
| SH-A03 | expired token | PASS |
| SH-A04 | revoked session | PASS |
| SH-A05 | disabled account | PASS |
| SH-A06 | locked account | PASS |
| SH-A07 | admin | PASS |
| SH-A08 | operator | PASS |
| SH-A09 | viewer | PASS |
| SH-A10 | root | PASS |
| SH-A11 | super_admin | PASS |
| SH-A12 | ops_admin | PASS |
| SH-A13 | auditor | PASS |
| BH-A01 | no token | PASS |
| BH-A02 | invalid token | PASS |
| BH-A03 | expired token | PASS |
| BH-A04 | revoked session | PASS |
| BH-A05 | disabled account | PASS |
| BH-A06 | locked account | PASS |
| BH-A07 | admin | PASS |
| BH-A08 | operator | PASS |
| BH-A09 | viewer | PASS |
| BH-A10 | root | PASS |
| BH-A11 | super_admin | PASS |
| BH-A12 | ops_admin | PASS |
| BH-A13 | auditor | PASS |
| SH-V01 | malformed JSON | PASS |
| SH-V02 | empty object | PASS |
| SH-V03 | missing imsi | PASS |
| SH-V04 | missing type | PASS |
| SH-V05 | imsi empty | PASS |
| SH-V06 | type empty | PASS |
| SH-V07 | 14-digit IMSI | PASS |
| SH-V08 | 16-digit IMSI | PASS |
| SH-V09 | whitespace IMSI | PASS |
| SH-V10 | lowercase unknown | PASS |
| SH-V11 | uppercase UNKNOWN | PASS |
| SH-V12 | numeric 15-digit IMSI | PASS |
| BH-V01 | malformed JSON | PASS |
| BH-V02 | anomalies missing | PASS |
| BH-V03 | anomalies null | PASS |
| BH-V04 | anomalies object | PASS |
| BH-V05 | anomalies empty array | PASS |
| SH-P01 | omitted | PASS |
| SH-P02 | empty | PASS |
| SH-P03 | whitespace | PASS |
| SH-P04 | valid profile | PASS |
| SH-P05 | non-existent profile | PASS |
| SH-P06 | numeric profileName | PASS |
| BH-P01 | omitted | PASS |
| BH-P02 | empty | PASS |
| BH-P03 | valid profile | PASS |
| BH-P04 | non-existent profile | PASS |
| BH-P05 | numeric profileName | PASS |
| SH-T01 | orphan_ocs existing | PASS |
| SH-T02 | orphan_ocs missing | PASS |
| SH-T03 | missing_config existing | PASS |
| SH-T04 | missing_config missing | PASS |
| SH-T05 | balance_mismatch existing | PASS |
| SH-T06 | balance_mismatch missing | PASS |
| SH-T07 | invalid_tariff matching | PASS |
| SH-T08 | invalid_tariff no OCS match | PASS |
| SH-T09 | dangling_profile explicit | PASS |
| SH-T10 | dangling_profile fallback | PASS |
| SH-T11 | orphan_reservation one row | PASS |
| SH-T12 | orphan_reservation multiple rows | PASS |
| SH-T13 | orphan_reservation no row | PASS |
| SH-T14 | unknown type existing | PASS |
| SH-T15 | unknown type missing | PASS |
| BH-I01 | one valid anomaly | PASS |
| BH-I02 | multiple valid anomalies | PASS |
| BH-I03 | mixed remediation types | PASS |
| BH-I04 | duplicate anomalies | PASS |
| BH-I05 | unknown type | PASS |
| BH-I06 | partial item failure | PASS |
| BH-I07 | first success / second fail / third success | PASS |
| BH-M01 | empty object item | PASS |
| BH-M02 | missing imsi item | PASS |
| BH-M03 | missing type item | PASS |
| BH-M04 | null item | PASS |
| BH-M05 | string item | PASS |
| BH-M06 | numeric item | PASS |
| BH-M07 | boolean item | PASS |
| SH-F01 | real business repository failure | PASS |
| BH-F01 | batch repository helper escaping failure after committed first item | PASS |
| SH-F02 | audit persistence failure remains best-effort | PASS |
| SH-F03 | rate-limit storage failure preserves fail-open business execution | PASS |
| BH-F02 | audit persistence failure remains best-effort | PASS |
| BH-F03 | rate-limit storage failure preserves fail-open business execution | PASS |
| SH-R01 | 20/60 allowed boundary | PASS |
| SH-R02 | 21 request denied | PASS |
| SH-R03 | per-user isolation | PASS |
| BH-R01 | 10/60 allowed boundary | PASS |
| BH-R02 | 11 request denied | PASS |
| BH-R03 | per-user isolation | PASS |
| BH-R04 | single/batch limiter independence | PASS |
