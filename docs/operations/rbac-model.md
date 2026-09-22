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
| **`admin`** | 管理员 / Administrator | Full administration privileges: user management, role assignments, audit export & full source-IP inspection, approval review/execution, and direct business mutations. |
| **`operator`** | 操作员 / Operator | Operational execution privileges: direct business mutations (subscribers, balances, profiles, tariffs, rating), core operation/configuration, and audit viewing. Cannot manage users, cannot export audits. |
| **`viewer`** | 查看员 / Viewer | Read-only inspection privileges: viewing subscribers, profiles, tariffs, balances, and audit logs. All mutations, administration, and exports are strictly denied. |

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
| `audit_view` | **allow** | **allow** | **allow** | Read audit logs |
| `audit_export` | **export** | deny | deny | Export CSV/JSON logs |
| `user_admin` | **allow** | deny | deny | Manage users & assign roles |
| `approval_review` | **allow** | deny | deny | Reserved administrative duty |
| `approval_execute` | **allow** | deny | deny | Reserved administrative duty |

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
| `audit.read` | ✓ | ✓ | ✓ |
| `audit.export` | ✓ | ✗ | ✗ |
| `audit.source-ip.read-full` | ✓ | ✗ | ✗ |

---

## 5. Operations & Migration Utility

For environments desiring database hygiene where all historical `role` values are updated to canonical strings, the repository includes a migration script:

```bash
# Dry run: view affected accounts without modifying the database
node scripts/migrate-rbac-roles.mjs

# Apply: execute migration, commit updates, and record audit evidence
node scripts/migrate-rbac-roles.mjs --apply
```
