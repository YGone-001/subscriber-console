# Role-Based Access Control (RBAC) Model: Canonical Three-Role Architecture

Status: PRODUCTION  
Phase: 5.7-B  
Baseline: `develop`  
Target Services: Next.js Frontend (:13333), Go Production Backend (:18888), MongoDB (`xcloud`, `xcloud_ops`)

---

## 1. Overview & Architectural Principles

In **Phase 5.7-B**, the six-role RBAC model (`root`, `super_admin`, `ops_admin`, `operator`, `auditor`, `viewer`) is simplified into a **Canonical Three-Role Model** tailored for an internal Carrier Network Management System (CNMS/NMS) operating environment.

### The Canonical Three Roles

| Role | Display Name (ZH / EN) | Description |
| :--- | :--- | :--- |
| **`admin`** | 管理员 / Administrator | Full administration privileges, including user management, role assignments, and direct business mutations. |
| **`operator`** | 操作员 / Operator | Direct business mutations for subscribers, balances, profiles, tariffs, and rating. Cannot manage users. |
| **`viewer`** | 查看员 / Viewer | Read-only inspection privileges. All mutations and administration are denied. |

---

## 2. Transparent Runtime Normalization (Backward Compatibility)

To prevent breaking existing sessions or requiring downtime for database-wide schema changes, legacy role identifiers are transparently normalized at runtime by both the **Frontend** and the **Go Backend**:

```text
┌─────────────────────────────────────────────────────────────┐
│                 Runtime Normalization Map                   │
├───────────────────────────────┬─────────────────────────────┤
│ Legacy Database Role          │ Canonical Normalized Role   │
├───────────────────────────────┼─────────────────────────────┤
│ root                          │ admin                       │
│ super_admin                   │ admin                       │
│ ops_admin                     │ operator                    │
│ operator                      │ operator                    │
│ auditor                       │ viewer                      │
│ viewer                        │ viewer                      │
│ (others / undefined)          │ null (denied / fail closed) │
└───────────────────────────────┴─────────────────────────────┘
```

### Normalization Characteristics
1. **Zero Database Lockup**: Existing documents with `role: "root"` or `role: "super_admin"` continue to authenticate with full administrator permissions.
2. **Session Preservation**: Active JWT tokens containing legacy roles remain valid and normalize on each request.
3. **Fail-Closed Security**: Any unknown, malformed, or missing role is rejected immediately with authorization denial.

---

## 3. Strict Write Boundary Contract

While existing documents may contain legacy roles, **all write operations (creation and update) strictly require canonical role identifiers**:

- **User Creation** (`POST /api/auth/users`):
  Accepts only `role ∈ ['admin', 'operator', 'viewer']`.
  Any legacy role string (such as `'root'`, `'super_admin'`, `'ops_admin'`, `'auditor'`) is rejected with HTTP 400 (`code: "INVALID_ROLE"`).
- **User Modification** (`PUT` / `PATCH /api/auth/users/:username`):
  When `role` is provided, it must be one of `['admin', 'operator', 'viewer']`. Legacy roles are rejected with HTTP 400 (`code: "INVALID_ROLE"`).
- **UI Exposure**:
  Dropdown menus, creation forms (`UserCreateForm`), edit forms (`UserEditForm`), and bulk assignment toolbars present **strictly the three canonical choices**:
  - Administrator (`admin`)
  - Operator (`operator`)
  - Viewer (`viewer`)

---

## 4. Permission & Capability Matrix

### Capabilities

| Capability | `admin` | `operator` | `viewer` | Notes |
| :--- | :---: | :---: | :---: | :--- |
| `subscriber_write` | **allow** | **allow** | deny | Direct mutation (Phase 5.7-A) |
| `policy_approve` | **allow** | **allow** | deny | Direct mutation (Phase 5.7-A) |
| `balance_adjust` | **allow** | **allow** | deny | Direct mutation (Phase 5.7-A) |
| `profile_rollback` | **allow** | **allow** | deny | Direct mutation (Phase 5.7-A) |
| `rating_publish` | **allow** | **allow** | deny | Direct mutation (Phase 5.7-A) |
| `system_heal` | **allow** | **allow** | deny | Direct mutation (Phase 5.7-A) |
| `user_admin` | **allow** | deny | deny | Manage users & assign roles |

### Representative Permissions

| Permission | `admin` | `operator` | `viewer` |
| :--- | :---: | :---: | :---: |
| `users.read` | ✓ | ✗ | ✗ |
| `users.create` | ✓ | ✗ | ✗ |
| `users.update` | ✓ | ✗ | ✗ |
| `users.role.change` | ✓ | ✗ | ✗ |
| `subscribers.read` | ✓ | ✓ | ✓ |
| `subscribers.write` | ✓ | ✓ | ✗ |
| `subscribers.delete` | ✓ | ✓ | ✗ |
| `profiles.read` | ✓ | ✓ | ✓ |
| `profiles.write` | ✓ | ✓ | ✗ |
| `core.read` | ✓ | ✓ | ✓ |
| `core.operate` | ✓ | ✓ | ✗ |
| `core.configure` | ✓ | ✓ | ✗ |
| `ocs.read` | ✓ | ✓ | ✓ |
| `ocs.balance.adjust` | ✓ | ✓ | ✗ |
| `ocs.tariff.write` | ✓ | ✓ | ✗ |
| `ocs.plan.assign` | ✓ | ✓ | ✗ |
| `ocs.rating.write` | ✓ | ✓ | ✗ |

---

## 5. Operations & Migration Utility

### Authoritative Application User Collection
The authoritative user collection across the platform (Go backend, Next.js frontend, and authentication services) is:
```text
xcloud_ops.app_users
```
> [!NOTE]
> The MongoDB collection `xcloud_ops.users` is **NOT** the application user collection and must never be targeted by authentication or user administration tools.

### Role Migration Utility (`scripts/migrate-rbac-roles.mjs`)
For environments desiring database hygiene where all historical legacy role values (`root`, `super_admin`, `ops_admin`, `auditor`) are updated to canonical three-role strings (`admin`, `operator`, `viewer`), the repository includes an operational migration script:

```bash
# Dry run: view affected accounts without modifying the database (default mode)
node scripts/migrate-rbac-roles.mjs

# Apply: execute migration, commit updates, and record audit evidence
node scripts/migrate-rbac-roles.mjs --apply
```

#### Safety Guarantees
1. **Targeting**: Authoritatively targets `xcloud_ops.app_users` (never modifies `users`).
2. **Dry-Run by Default**: Without `--apply`, runs in dry-run mode performing zero database writes, zero role modifications, zero `sessionVersion` increments, and zero audit log entries.
3. **Atomic Conditional Updates**: Updates use conditional matching `{ username: candidate.username, role: candidate.currentRole }` to prevent stale race conditions.
4. **Session Invalidation**: Increments `security.sessionVersion` by exactly 1 for migrated accounts to gracefully invalidate active JWT sessions, while canonical accounts retain their current `sessionVersion`.
5. **Field Preservation**: Preserves all unrelated document fields (`displayName`, `email`, `status`, `createdAt`, credentials, metadata).
6. **Audit Trail**: Generates an audit record in `xcloud_ops.app_audit_logs` with action `users.role.migration` recording migrated account details.
7. **Replay Safe (Idempotent)**: Subsequent executions find 0 candidates, commit 0 writes, and generate no duplicate audit logs.
