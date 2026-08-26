# User lifecycle invariant (Phase 2)

The inspected deployment is MongoDB standalone (`hello`: no setName / mongos).
No transaction support is assumed. Next 16 Proxy runs on Node.js and validates
each protected request against MongoDB without an identity cache.

Every repository `updateUser` acquires the singleton `user-lifecycle` document in
`system_governance_state` using the built-in unique `_id` index and majority write
concern. Target/actor checks and the active root/super_admin count run while that
lock is held; status/role/password changes use atomic `$set` + `$inc`, never replace.
The approval ACCESS_REQUEST path also goes through this repository.

There is **no lock TTL or automatic lease takeover**. A second writer receives
503 USER_MANAGEMENT_BUSY and may retry the whole request. A business-rule rejection
releases the lock; an unknown DB error retains it because the write result could
be ambiguous. A crash can therefore stop management writes but cannot authorize
a second writer while the first might still execute. Login counters do not alter
roles/status and do not need this lock. User insertion cannot reduce the invariant.
All application role/status writes must use this repository; direct DB writes are
outside the application guarantee. Initial bootstrap must establish an active root.

## Recovery (operator controlled; never automatic)

1. Stop **all** application writer instances, background executors and bootstrap jobs.
2. Resolve DB connectivity/replication uncertainty. Confirm no old writer can resume.
3. Read the lock owner/acquiredAt, recent user audit evidence and current app_users.
   Confirm at least one account with role root or super_admin, status active,
   and locked != true. If not, use the separately authorized bootstrap/recovery process.
4. Remove only the inspected lock document, matching its exact `_id` **and owner**.
   Do not run a blanket delete or add a TTL index.
5. Restart writers; exercise a harmless user update and confirm the lock is released.

This deliberately trades availability after a crash for administrator safety.
Replication migrations can replace this with transactions, but must still serialize
through a shared invariant document: a count inside a transaction alone permits write skew.
