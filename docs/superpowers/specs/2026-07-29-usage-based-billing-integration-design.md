# Usage-based billing integration (Issue #92 / 12.5) — design

## Context

Issue #92 connects Issue 10.9's already-built metering/Stripe-reporting to real billing operations: near-real-time usage reporting, reconciliation against what Stripe actually recorded, and proration on mid-period plan changes. The issue's own note flags significant overlap with 10.9 — this design scopes strictly to what 10.9 doesn't already do.

## Current state (confirmed by reading the code)

- `apps/api/app/services/billing/metering.py`: `meter_workspace_for_period()` counts `PublishedItem` rows per workspace per UTC calendar month (idempotent upsert into `UsagePeriod`). `meter_all_workspaces_for_current_period()` loops every non-deleted workspace, current month only.
- `apps/api/app/services/billing/stripe_reporting.py`: `report_usage_period()` reports only the delta since last report (`publishedItemCount - reportedCount`) via Stripe's Billing Meter Events API, idempotent via a deterministic `identifier`. Skips silently if no `stripeCustomerId` (ENTERPRISE/unbilled).
- **Trigger path**: both are only invoked by `POST /billing/meter-usage`, which has **zero callers anywhere in the codebase** — not from any publish router, not from a cron (none exists), not from the frontend. Purely a manually-triggerable endpoint today, exactly like every other "deferred scheduler" feature in this repo (parsing, drift-check).
- **No shared publish choke point**: `PublishedItem` rows are created independently in 3 separate routers (`publish.py` for Jira, `publish_ado.py`, `publish_github.py`), each with its own inline construction — no common service function to hook into.
- **No proration exists**: `POST /api/workspaces/{ws}/billing/tier` only accepts `tier: "ENTERPRISE"` (STARTER→ENTERPRISE), never touches Stripe (`prisma.workspace.update` only). No code path for ENTERPRISE→STARTER. Zero `proration`/`prorate` hits anywhere in the codebase.
- **No reconciliation capability**: `UsagePeriod` stores only what SpecMate computed/sent (`publishedItemCount`, `reportedCount`, `reportedToStripeAt`) — nothing stores what Stripe actually confirms it received. No Stripe SDK readback calls exist anywhere (only the one write call, `meter_events.create`).
- **Marketplace billing (10.2/10.3/10.4)**: all three issues are open, zero marketplace billing code exists anywhere in the repo. Safe to exclude — nothing to conflict with or build against.
- **Direct precedent**: Epic 9's drift-check (`apps/api/app/routers/drift.py`) already implements exactly the "fetch external system's actual state → diff against our last-known-recorded state → flag (never auto-correct) on mismatch → human resolves" pattern this issue's reconciliation piece needs, including the idempotent flag-refresh-not-duplicate convention and the manual-trigger-endpoint posture.

## Scope decisions (from clarifying questions)

1. **"Near-real-time" reporting**: report inline, synchronously, right after each `PublishedItem` is created — added independently to all 3 publish routers (mirrors this codebase's existing per-router duplication rather than forcing a new shared abstraction just for this). Best-effort: a reporting failure is caught and logged, never blocks or fails the publish request itself.
2. **Reconciliation**: mirrors the Epic 9 drift-check pattern exactly — read back Stripe's own recorded usage, diff against SpecMate's internal `reportedCount`, flag mismatches (never silently auto-correct), human resolves. This is the one genuinely new piece of work in this issue.
3. **Proration**: real Stripe integration, not a stub. Extend `/billing/tier` to handle both tier-change directions, and call `stripe.subscriptions.update(..., proration_behavior: 'create_prorations')` on any change to a workspace with an active subscription.
4. **No new scheduler/cron infrastructure** — reconciliation stays on-demand (a `POST` endpoint), consistent with `/billing/meter-usage` and `/drift-check`'s existing posture and every other issue this session.
5. **Marketplace billing reconciliation excluded** — 10.2/10.3/10.4 aren't built yet; nothing exists to reconcile against.

## Design

### 1. Near-real-time reporting — `apps/api/app/services/billing/metering.py` (extend) + 3 publish routers

New function in `metering.py` (or a new small module if it grows — start colocated):

```python
async def report_workspace_current_usage(session: AsyncSession, workspace_id: str) -> None:
    """Best-effort near-real-time reporting (Issue 12.5): meters + reports just this
    one workspace's current period, called inline right after a publish. Never
    raises — a reporting hiccup must not fail the publish request that triggered
    it; the periodic /billing/meter-usage sweep is the backstop that catches
    anything a failed inline report missed."""
    try:
        period_start, period_end = current_period_bounds()
        usage_period = await meter_workspace_for_period(session, workspace_id, period_start, period_end)
        await report_usage_period(session, usage_period)
        await session.commit()
    except Exception:
        logger.exception("Inline usage reporting failed for workspace %s", workspace_id)
```

Called from each of `publish.py`, `publish_ado.py`, `publish_github.py`, right after the `PublishedItem` is flushed/committed — `await report_workspace_current_usage(session, workspace_id)` as the last step before returning the publish response. Added independently to each router (matching the existing lack of a shared publish choke point) rather than introducing a new cross-tool abstraction as a side effect of this issue.

### 2. Reconciliation — new `apps/api/app/services/billing/reconciliation.py` + `UsageReconciliationFlag` model

New Prisma + SQLAlchemy model, structurally parallel to `DriftFlag`:

```prisma
model UsageReconciliationFlag {
  id              String    @id @default(cuid())
  usagePeriodId   String
  workspaceId     String
  internalCount   Int       // our reportedCount at flag time
  stripeCount     Int       // what Stripe's meter summary actually shows
  status          String    @default("OPEN") // OPEN | RESOLVED
  resolvedAt      DateTime?
  resolvedByUserId String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  usagePeriod UsagePeriod @relation(fields: [usagePeriodId], references: [id])
  workspace   Workspace   @relation(fields: [workspaceId], references: [id])

  @@unique([usagePeriodId])
}
```

`apps/api/app/services/billing/reconciliation.py`:

```python
async def reconcile_workspace_usage(session: AsyncSession, usage_period: UsagePeriod) -> UsageReconciliationFlag | None:
    """Reads Stripe's own recorded meter total for this workspace/period (via
    Stripe's meter event summaries API — new capability, no prior readback
    existed) and diffs it against our reportedCount. On mismatch, creates or
    refreshes (never duplicates) a UsageReconciliationFlag — same
    flag-don't-autocorrect convention as drift.py's DriftFlag. Returns None
    when counts match (no flag needed)."""
```

`POST /billing/reconcile-usage` (new router endpoint, same file as `/billing/meter-usage`): loops all billed workspaces' current `UsagePeriod` rows, calls `reconcile_workspace_usage` for each, returns a summary (`{"reconciled": N, "flagged": M}`). Manual-trigger only, same posture as `/billing/meter-usage` and `/drift-check`.

`POST /billing/reconciliation-flags/{flag_id}/resolve`: marks a flag `RESOLVED`, records `resolvedByUserId`. Mirrors `DriftFlag`'s resolve endpoint shape (no "adopt Stripe's number" auto-correction path in this issue — resolution is an acknowledgment, not a data mutation, since blindly overwriting `reportedCount` from a diverged Stripe read could mask an actual bug rather than fix one).

### 3. Proration — extend `/api/workspaces/{ws}/billing/tier`

`apps/web/src/app/api/workspaces/[workspaceId]/billing/tier/route.ts`: accept both `"STARTER"` and `"ENTERPRISE"` (currently only `"ENTERPRISE"`). For a workspace with an active `stripeSubscriptionId`, call:

```ts
await stripe.subscriptions.update(workspace.stripeSubscriptionId, {
  items: [{ id: subscriptionItemId, price: newPriceId }],
  proration_behavior: 'create_prorations',
});
```

Stripe computes and invoices the prorated amount automatically — no manual proration math in application code. For a workspace with no active subscription (e.g. still free-while-solo), the tier flip stays a plain `prisma.workspace.update` as today (nothing to prorate). ENTERPRISE→STARTER additionally requires resolving which Starter Price IDs to use (reuse the existing `STRIPE_STARTER_PRICE_ID`/`STRIPE_STARTER_OVERAGE_PRICE_ID` env vars already defined for the checkout flow).

## Testing

- `report_workspace_current_usage()`: unit test with a mocked Stripe client confirming it meters + reports the single workspace and never raises even when the mocked report call throws.
- Each publish router: extend existing publish tests to confirm `PublishedItem` creation still succeeds even when usage reporting is mocked to fail (best-effort, non-blocking) — and a happy-path test confirming the reporting call happens.
- `reconcile_workspace_usage()`: mocked Stripe meter-summary responses for match (no flag), mismatch (flag created), and repeat-mismatch (flag refreshed, not duplicated — same `@@unique` idempotency test style as `DriftFlag`).
- Proration route: both tier-change directions, mocked `stripe.subscriptions.update`, asserting `proration_behavior: 'create_prorations'` is always passed and the correct target price is selected.
- Full regression for both apps.

## Out of scope

- Marketplace billing reconciliation (Atlassian/GitHub/ADO) — Issues 10.2/10.3/10.4, not built yet.
- Any new job scheduler/cron infrastructure — reconciliation and near-real-time reporting both stay request-triggered (inline for reporting, manual-endpoint for reconciliation), consistent with this repo's established posture.
- Historical/past-period reconciliation — current period only, matching 10.9's existing metering scope.
- Auto-correcting `reportedCount` from a reconciliation mismatch — flags are for human review, not automatic data mutation.
- Real Stripe account verification — same caveat as 10.9: built and unit-tested against Stripe's API shape, never run against a live (even test-mode) account.
