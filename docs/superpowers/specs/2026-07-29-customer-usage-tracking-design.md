# Customer-facing AI usage tracking and limits (Issue #91 / 12.4) — design

## Context

Issue #91 is the customer-facing counterpart to Issue 1.6's internal cost/margin dashboard. Workspaces need visibility into their own usage against their plan's included quota, since Issue 10.9's pricing model is hybrid (base subscription + metered overage on published items).

## Current state (confirmed by reading the code)

- `UsagePeriod` (Prisma + SQLAlchemy mirror) — one row per workspace per UTC calendar month, `publishedItemCount` (computed, not incremented), `reportedCount`/`reportedToStripeAt` for Stripe delta reporting.
- `publishedItemCount` is only refreshed when `POST /billing/meter-usage` runs (`apps/api/app/services/billing/metering.py::meter_workspace_for_period()`) — counts `PublishedItem` rows via `PublishedItem → DraftItem → Project → workspaceId`, joined since `PublishedItem` has no direct `workspaceId`. No cron exists; this is on-demand/manual, same posture as parsing/generation elsewhere in the repo.
- Plan tiers: `Workspace.pricingTier` enum (`STARTER` | `ENTERPRISE`), no DB-driven `Plan` model. Quota numbers live in `apps/web/src/lib/pricing.ts`, explicitly flagged `PLACEHOLDER_PRICING = true`: `STARTER_INCLUDED_ITEMS = 50`, `STARTER_OVERAGE_PER_ITEM_USD = 2`, `STARTER_BASE_USD = 99`. ENTERPRISE has `includedItems: null` (unlimited/custom).
- `/internal/ai-costs` (Issue 1.6 + 10.9 margin extension) is a **staff-only** dashboard (`isInternalAdmin()` gate) showing cost-to-revenue margin across all workspaces. Not customer-facing, must not be duplicated — Issue #91 differs in audience only, and should reuse the same `UsagePeriod`/`estimateStarterMonthlyUsd` data model rather than re-derive it.
- `/workspaces/{workspaceId}/billing` (ADMIN-gated via `requireWorkspaceRole`) currently shows only plan/subscription **state** (a static tier badge) — zero usage/quota visibility today.
- No notification infrastructure exists anywhere in the repo: no `Notification` model, no email/Slack integration. The closest existing pattern is `nextInviteNeedsBilling()` (`apps/web/src/lib/billing-gate.ts`) — a synchronous, page-load proactive warning, not a persisted/dispatched notification.
- Billing stays workspace-scoped (not org-scoped), per the explicit decision recorded in Issues 12.10/12.11 — consistent with keeping this feature on the existing `/workspaces/{ws}/billing` page.

## Scope decisions (from clarifying questions)

1. **Quota numbers**: reuse the existing placeholder constants from `pricing.ts` (`STARTER_INCLUDED_ITEMS = 50`, etc.) — consistent with the rest of the app's placeholder-pricing convention. Not a business decision made by this issue.
2. **Data freshness**: compute usage **live** on page/API load by counting `PublishedItem` rows directly (same join as `meter_workspace_for_period()`), rather than trusting the possibly-stale `UsagePeriod.publishedItemCount`. Guarantees the AC that "usage tracking units match exactly what's billed" — no risk of showing a stale number that later diverges from what Stripe actually reports.
3. **Notifications**: in-app banner only, appearing on the billing page when usage crosses a threshold. No email/Slack, no persisted `Notification` model — that's new infrastructure out of scope for this issue.
4. **Quota enforcement**: soft warn-only. Exceeding quota never blocks publishing — overage is already priced and billed via existing Stripe metering (10.9). The issue's "configurable behaviour" language is satisfied by there being exactly one behavior (soft-warn) today; no per-tier configuration mechanism is built since there's nothing to configure between yet.
5. **API exposure**: session-based JSON endpoint reusing the existing `requireWorkspaceRole(workspaceId, ['ADMIN'])` auth pattern — no new API-key mechanism (none exists in this repo).
6. **UI location**: extend the existing `/workspaces/{workspaceId}/billing` page rather than fragment usage info onto a new page.

## Design

### 1. Shared usage-computation function — `apps/web/src/lib/usage.ts` (new)

```ts
export interface UsageSummary {
  periodStart: string; // ISO
  periodEnd: string; // ISO
  publishedItemCount: number;
  includedItems: number | null; // null = unlimited (ENTERPRISE)
  remaining: number | null; // null when unlimited
  overageCount: number; // max(0, publishedItemCount - includedItems), 0 when unlimited
  percentUsed: number | null; // null when unlimited; 0-100+ otherwise
  tier: PricingTier;
}

export async function getWorkspaceUsageSummary(workspaceId: string): Promise<UsageSummary>;
```

Computes the current UTC calendar-month period bounds (mirroring `metering.py::current_period_bounds()` — reuse `margin.ts`'s existing `startOfCurrentMonthUtc()` if it already does this, else add an equivalent helper), then counts `PublishedItem` rows live via Prisma using the same `PublishedItem → DraftItem → Project → workspaceId` join `meter_workspace_for_period()` uses, filtered to `deletedAt: null` and `createdAt` within the period. This is a live count, not a read of the `UsagePeriod` row — guarantees the displayed number never diverges from what metering would compute if run right now.

For `STARTER`: `includedItems = STARTER_INCLUDED_ITEMS`, `remaining = max(0, includedItems - publishedItemCount)`, `overageCount = max(0, publishedItemCount - includedItems)`, `percentUsed = round(publishedItemCount / includedItems * 100)`.
For `ENTERPRISE`: `includedItems = null`, `remaining = null`, `overageCount = 0`, `percentUsed = null`.

### 2. Billing page extension — `apps/web/src/app/workspaces/[workspaceId]/billing/billing-settings.tsx`

Add a "Usage this period" section (only rendered when the workspace has an active/trialing subscription or is ENTERPRISE — i.e. wherever the page currently shows the plan badge):

- Published items used this period vs. included quota (e.g. "32 / 50 published items").
- A progress bar reflecting `percentUsed`, capped visually at 100% with an "over quota" state beyond that.
- Remaining count (`"18 remaining"`) when under quota, or overage count + estimated overage cost (`estimateStarterMonthlyUsd`, already exists) when over.
- A warning banner at `percentUsed >= 80` ("Approaching your plan's included usage") and a distinct banner at `percentUsed >= 100` ("You've exceeded your included usage — overage charges apply", STARTER only, informational framing, no blocking language since nothing is blocked).
- ENTERPRISE workspaces show "Unlimited" with the raw published-item count, no bar/banner.

### 3. New API route — `GET /api/workspaces/{workspaceId}/usage`

`apps/web/src/app/api/workspaces/[workspaceId]/usage/route.ts`, gated by `requireWorkspaceRole(workspaceId, ['ADMIN'])` (same 401/403/404 shape as sibling routes). Returns the `UsageSummary` JSON shape from `getWorkspaceUsageSummary()`. This satisfies the "usage data exposed via API" AC — a script can poll this while authenticated as a workspace admin.

### 4. No changes to publishing/enforcement logic

Publishing is never blocked by quota state. No changes to `apps/api`'s publish routers or the existing Stripe overage billing — that's already correct and unaffected by this issue.

## Testing

- Unit tests for `getWorkspaceUsageSummary()`: period boundary correctness (reuse/adapt existing period-boundary test patterns if any exist for `margin.ts`), STARTER math (remaining/overage/percentUsed at under-quota, exactly-at-quota, and over-quota counts), ENTERPRISE unlimited handling (all quota fields null/zero, no percent).
- Route test for `GET /api/workspaces/{workspaceId}/usage`: auth gating (non-member 404, non-admin member 403, admin 200 with correct shape), correct numbers for a workspace with known `PublishedItem` rows.
- Page-level test for the billing page's new usage section: renders correct numbers, shows the 80%/100% banners at the right thresholds and hides them under 80%, renders "Unlimited" correctly for ENTERPRISE.

## Out of scope

- Real (non-placeholder) pricing numbers — a business decision, not engineering scope.
- Hard quota enforcement or blocking publishes at quota.
- Configurable per-tier enforcement modes (hard-stop / auto-upgrade-prompt) — only soft-warn exists today; no config mechanism built for modes that don't exist yet.
- Email/Slack notifications or a persisted `Notification` model — new infrastructure, not part of this issue.
- Org-level usage rollups — billing stays workspace-scoped per the existing 12.10/12.11 decision.
- Historical usage-over-time charts/graphs — current period only, matching what's actually billed.
- Any change to `apps/api`'s metering/Stripe-reporting logic (10.9) — this issue is read-only visibility on top of it.
