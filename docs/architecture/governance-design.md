# Governance Design

> Approval governance and audit architecture.
> Detailed rules: `CLAUDE.md` §15. Current state: `AGENTS.md` §9.1, §9.2.

## Governance Modes

```text
DIRECT_GOVERNED    — execute immediately, no approval required
APPROVAL_GOVERNED  — requires approval workflow
DISABLED           — not available (no override)
RUNTIME_INTERNAL   — not available via HTTP (no override)
```

## Super Admin Override

Effective decision order:

```text
1. DISABLED → always DISABLED (even super_admin)
2. RUNTIME_INTERNAL → always RUNTIME_INTERNAL (even super_admin)
3. super_admin + APPROVAL_GOVERNED + has executor → DIRECT_GOVERNED
4. base mode applies
```

Super Admin = `root` (legacy) or `super_admin` role.

## Write Chain

```text
Handler
  → Application Service
  → Governance Policy (EvaluateOperation)
  → DIRECT: Executor + Strict Audit
  → APPROVAL: ApprovalCreator.Create() + return 202
```

## Approval Workflow

- CAS transitions (FindOneAndUpdate only)
- Pure state machine (CanTransition)
- Independent reviewer (maker-checker)
- Risk policy evaluation (approval-risk-v1)
- Action eligibility: canApprove / canReject / canCancel / canExecute

## Audit

- BestEffort mode: non-blocking, lifecycle context
- Strict mode: request + lifecycle context, bounded close
- Fresh actor revalidation before every mutation
- Frozen payload snapshots for approval requests
