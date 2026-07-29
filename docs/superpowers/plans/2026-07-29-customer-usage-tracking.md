# Customer-facing AI usage tracking and limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give workspace admins live visibility into their current-period published-item usage vs. their plan's quota, on the existing billing page and via a JSON API, with a soft-warn banner near/over quota — no enforcement, no new infrastructure beyond what's already built for Issue 10.9.

**Architecture:** A single shared `getWorkspaceUsageSummary(workspaceId)` function in `apps/web/src/lib/usage.ts` computes usage live (counts `PublishedItem` rows for the current UTC month directly via Prisma, joined the same way `apps/api`'s metering does), returning a plain `UsageSummary` object. Both the extended billing page and a new `GET /api/workspaces/{workspaceId}/usage` route call this one function — no duplicated period-math or query logic.

**Tech Stack:** Next.js App Router (`apps/web`), Prisma, TypeScript, Vitest, Testing Library.

---

### Task 1: `getWorkspaceUsageSummary()` — shared usage computation

**Files:**

- Create: `apps/web/src/lib/usage.ts`
- Test: `apps/web/src/lib/usage.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import { getWorkspaceUsageSummary } from './usage';

describe('getWorkspaceUsageSummary', () => {
  let starterWs: { id: string };
  let enterpriseWs: { id: string };
  let project: { id: string };
  let draftItem: { id: string };

  beforeAll(async () => {
    starterWs = await prisma.workspace.create({
      data: { name: 'Usage Test Starter', pricingTier: 'STARTER' },
    });
    enterpriseWs = await prisma.workspace.create({
      data: { name: 'Usage Test Enterprise', pricingTier: 'ENTERPRISE' },
    });
    project = await prisma.project.create({
      data: { workspaceId: starterWs.id, name: 'Usage Test Project' },
    });
    draftItem = await prisma.draftItem.create({
      data: {
        projectId: project.id,
        type: 'STORY',
        title: 'x',
        description: 'x',
        status: 'APPROVED',
      },
    });
  });

  afterAll(async () => {
    await prisma.publishedItem.deleteMany({ where: { draftItemId: draftItem.id } });
    await prisma.draftItem.deleteMany({ where: { id: draftItem.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.workspace.deleteMany({ where: { id: { in: [starterWs.id, enterpriseWs.id] } } });
  });

  it('returns zero usage with correct STARTER quota when nothing published yet', async () => {
    const summary = await getWorkspaceUsageSummary(starterWs.id);
    expect(summary.publishedItemCount).toBe(0);
    expect(summary.includedItems).toBe(50);
    expect(summary.remaining).toBe(50);
    expect(summary.overageCount).toBe(0);
    expect(summary.percentUsed).toBe(0);
    expect(summary.tier).toBe('STARTER');
  });

  it('counts PublishedItem rows created within the current UTC month for STARTER, computing remaining/overage/percent', async () => {
    await prisma.publishedItem.create({
      data: {
        draftItemId: draftItem.id,
        targetTool: 'JIRA',
        externalKey: 'KAN-1',
        externalUrl: 'https://example.atlassian.net/browse/KAN-1',
      },
    });
    const summary = await getWorkspaceUsageSummary(starterWs.id);
    expect(summary.publishedItemCount).toBe(1);
    expect(summary.remaining).toBe(49);
    expect(summary.overageCount).toBe(0);
    expect(summary.percentUsed).toBe(2); // round(1/50 * 100)
  });

  it('excludes soft-deleted PublishedItem rows from the count', async () => {
    const deleted = await prisma.publishedItem.create({
      data: {
        draftItemId: draftItem.id,
        targetTool: 'JIRA',
        externalKey: 'KAN-2',
        externalUrl: 'https://example.atlassian.net/browse/KAN-2',
        deletedAt: new Date(),
      },
    });
    const summary = await getWorkspaceUsageSummary(starterWs.id);
    expect(summary.publishedItemCount).toBe(1); // unchanged — KAN-1 only
    await prisma.publishedItem.delete({ where: { id: deleted.id } });
  });

  it('reports unlimited (null quota fields) for ENTERPRISE regardless of usage', async () => {
    const summary = await getWorkspaceUsageSummary(enterpriseWs.id);
    expect(summary.includedItems).toBeNull();
    expect(summary.remaining).toBeNull();
    expect(summary.overageCount).toBe(0);
    expect(summary.percentUsed).toBeNull();
    expect(summary.tier).toBe('ENTERPRISE');
  });

  it('reports overageCount and percentUsed over 100 when usage exceeds the STARTER quota', async () => {
    const extraItems = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        prisma.publishedItem.create({
          data: {
            draftItemId: draftItem.id,
            targetTool: 'JIRA',
            externalKey: `KAN-OVER-${i}`,
            externalUrl: `https://example.atlassian.net/browse/KAN-OVER-${i}`,
          },
        }),
      ),
    );
    const summary = await getWorkspaceUsageSummary(starterWs.id);
    expect(summary.publishedItemCount).toBe(51); // 1 (from earlier test) + 50
    expect(summary.remaining).toBe(0);
    expect(summary.overageCount).toBe(1);
    expect(summary.percentUsed).toBe(102);
    await prisma.publishedItem.deleteMany({
      where: { id: { in: extraItems.map((i) => i.id) } },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/lib/usage.test.ts`
Expected: FAIL — `Cannot find module './usage'` (or similar; the file doesn't exist yet).

- [ ] **Step 3: Read `apps/api/app/services/billing/metering.py` in full to confirm the exact period-boundary and join logic being ported**

```bash
cat apps/api/app/services/billing/metering.py
```

Confirm `current_period_bounds()`'s exact math (UTC calendar month, half-open `[periodStart, periodEnd)`) and `meter_workspace_for_period()`'s exact join/filter (`PublishedItem.deletedAt IS NULL`, `PublishedItem.createdAt >= period_start AND < period_end`, joined `PublishedItem → DraftItem → Project` on `Project.workspaceId`). Port this exactly — don't reinvent the boundary math.

- [ ] **Step 4: Write `apps/web/src/lib/usage.ts`**

```ts
/**
 * Customer-facing usage tracking (Issue 12.4) — live-computed, never read from
 * the possibly-stale UsagePeriod.publishedItemCount (which is only refreshed
 * when POST /billing/meter-usage runs in apps/api, and there's no cron for
 * that yet). Counting PublishedItem rows directly on every call guarantees
 * this always matches what apps/api's metering would compute right now, and
 * therefore always matches what's actually billed (Issue 10.9) — no risk of
 * showing customers a number that later diverges from their invoice.
 *
 * Mirrors apps/api/app/services/billing/metering.py's period-boundary and
 * join logic exactly (UTC calendar month, PublishedItem -> DraftItem ->
 * Project -> workspaceId) — this is the second, TypeScript-side, of exactly
 * two places that logic exists; keep them in sync if either changes.
 */
import { prisma } from './prisma';
import { PRICING_TIERS, type PricingTierKey } from './pricing';

export interface UsageSummary {
  periodStart: string;
  periodEnd: string;
  publishedItemCount: number;
  includedItems: number | null;
  remaining: number | null;
  overageCount: number;
  percentUsed: number | null;
  tier: PricingTierKey;
}

function currentPeriodBoundsUtc(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function getWorkspaceUsageSummary(workspaceId: string): Promise<UsageSummary> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { pricingTier: true },
  });
  const { start, end } = currentPeriodBoundsUtc();

  const publishedItemCount = await prisma.publishedItem.count({
    where: {
      deletedAt: null,
      createdAt: { gte: start, lt: end },
      draftItem: { project: { workspaceId } },
    },
  });

  const includedItems = PRICING_TIERS[workspace.pricingTier].includedItems;

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    publishedItemCount,
    includedItems,
    remaining: includedItems === null ? null : Math.max(0, includedItems - publishedItemCount),
    overageCount: includedItems === null ? 0 : Math.max(0, publishedItemCount - includedItems),
    percentUsed:
      includedItems === null ? null : Math.round((publishedItemCount / includedItems) * 100),
    tier: workspace.pricingTier,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/lib/usage.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 6: Typecheck and lint**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/lib/usage.ts src/lib/usage.test.ts
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/usage.ts src/lib/usage.test.ts
git commit -m "Add live-computed workspace usage summary (Issue #91)"
```

---

### Task 2: `GET /api/workspaces/{workspaceId}/usage` API route

**Files:**

- Create: `apps/web/src/app/api/workspaces/[workspaceId]/usage/route.ts`
- Test: `apps/web/src/app/api/workspaces/[workspaceId]/usage/route.test.ts`

- [ ] **Step 1: Write the failing tests**

Match the exact conventions in `apps/web/src/app/api/workspaces/[workspaceId]/invites/route.test.ts` (already read in full during planning): `vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }))`, real Postgres fixtures via `prisma`, `beforeAll`/`afterAll` cleanup, a `let currentSession` mutable across `it` blocks.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { GET } = await import('./route');

describe('GET /api/workspaces/[workspaceId]/usage', () => {
  let workspace: { id: string };
  let admin: { id: string };
  let viewer: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({
      data: { name: 'Usage Route Test', pricingTier: 'STARTER' },
    });
    admin = await prisma.user.create({
      data: { email: `usage-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    viewer = await prisma.user.create({
      data: { email: `usage-viewer-${Date.now()}@test.local`, name: 'Viewer', passwordHash: 'x' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: viewer.id, role: 'VIEWER' },
    });
  });

  afterAll(async () => {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, viewer.id] } } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  function makeRequest() {
    return new Request(`http://localhost/api/workspaces/${workspace.id}/usage`);
  }

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a workspace VIEWER (not ADMIN)', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 with the UsageSummary shape for a workspace ADMIN', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      publishedItemCount: 0,
      includedItems: 50,
      remaining: 50,
      overageCount: 0,
      percentUsed: 0,
      tier: 'STARTER',
    });
    expect(typeof body.periodStart).toBe('string');
    expect(typeof body.periodEnd).toBe('string');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/app/api/workspaces/\[workspaceId\]/usage/route.test.ts`
Expected: FAIL — route module doesn't exist.

- [ ] **Step 3: Write the route**

```ts
import { NextResponse } from 'next/server';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { getWorkspaceUsageSummary } from '@/lib/usage';

type Params = { params: Promise<{ workspaceId: string }> };

// Programmatic usage monitoring (Issue 12.4 AC): same live-computed summary
// shown on the billing page, exposed as JSON for workspaces that want to poll
// it rather than check the UI.
export async function GET(_request: Request, { params }: Params) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const summary = await getWorkspaceUsageSummary(workspaceId);
  return NextResponse.json(summary);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/app/api/workspaces/\[workspaceId\]/usage/route.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Typecheck and lint**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/app/api/workspaces/\[workspaceId\]/usage/route.ts src/app/api/workspaces/\[workspaceId\]/usage/route.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/app/api/workspaces/\[workspaceId\]/usage/
git commit -m "Add GET /api/workspaces/[workspaceId]/usage endpoint (Issue #91)"
```

---

### Task 3: Billing page — usage section + threshold banners

**Files:**

- Modify: `apps/web/src/app/workspaces/[workspaceId]/billing/page.tsx`
- Modify: `apps/web/src/app/workspaces/[workspaceId]/billing/billing-settings.tsx`
- Test: `apps/web/src/app/workspaces/[workspaceId]/billing/billing-settings.test.tsx` (create if it doesn't exist — check first)

- [ ] **Step 1: Check whether a test file already exists for `billing-settings.tsx`**

```bash
ls apps/web/src/app/workspaces/\[workspaceId\]/billing/
```

If `billing-settings.test.tsx` exists, read it in full and match its exact conventions (render props, mocking style). If not, follow the conventions used by `apps/web/src/components/onboarding/onboarding-wizard.test.tsx` (already read earlier this session: `vi.stubGlobal('fetch', ...)`, `render`, `screen`, `fireEvent`, `waitFor` from Testing Library).

- [ ] **Step 2: Write the failing tests**

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BillingSettings } from './billing-settings';

function mockUsageFetch(summary: Partial<Record<string, unknown>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2026-08-01T00:00:00.000Z',
        publishedItemCount: 0,
        includedItems: 50,
        remaining: 50,
        overageCount: 0,
        percentUsed: 0,
        tier: 'STARTER',
        ...summary,
      }),
    }),
  );
}

describe('BillingSettings — usage section', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows published item count vs. included quota for a billed STARTER workspace', async () => {
    mockUsageFetch({ publishedItemCount: 32, remaining: 18, percentUsed: 64 });
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="STARTER" subscriptionStatus="ACTIVE" />,
    );
    await waitFor(() => expect(screen.getByText(/32/)).toBeDefined());
    expect(screen.getByText(/50/)).toBeDefined();
    expect(screen.getByText(/18 remaining/i)).toBeDefined();
  });

  it('shows an approaching-quota banner at 80% or more', async () => {
    mockUsageFetch({ publishedItemCount: 40, remaining: 10, percentUsed: 80 });
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="STARTER" subscriptionStatus="ACTIVE" />,
    );
    await waitFor(() =>
      expect(screen.getByText(/approaching your plan's included usage/i)).toBeDefined(),
    );
  });

  it('shows an over-quota banner at 100% or more, with overage framing', async () => {
    mockUsageFetch({ publishedItemCount: 55, remaining: 0, overageCount: 5, percentUsed: 110 });
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="STARTER" subscriptionStatus="ACTIVE" />,
    );
    await waitFor(() => expect(screen.getByText(/exceeded your included usage/i)).toBeDefined());
  });

  it('does not show a threshold banner under 80%', async () => {
    mockUsageFetch({ publishedItemCount: 10, remaining: 40, percentUsed: 20 });
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="STARTER" subscriptionStatus="ACTIVE" />,
    );
    await waitFor(() => expect(screen.getByText(/10/)).toBeDefined());
    expect(screen.queryByText(/approaching your plan's included usage/i)).toBeNull();
    expect(screen.queryByText(/exceeded your included usage/i)).toBeNull();
  });

  it('shows "Unlimited" for an ENTERPRISE workspace with no bar or banner', async () => {
    mockUsageFetch({
      includedItems: null,
      remaining: null,
      overageCount: 0,
      percentUsed: null,
      publishedItemCount: 12,
      tier: 'ENTERPRISE',
    });
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="ENTERPRISE" subscriptionStatus="NONE" />,
    );
    await waitFor(() => expect(screen.getByText(/unlimited/i)).toBeDefined());
    expect(screen.queryByText(/approaching your plan's included usage/i)).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/app/workspaces/\[workspaceId\]/billing/billing-settings.test.tsx`
Expected: FAIL — no usage section rendered yet.

- [ ] **Step 4: Extend `billing-settings.tsx`**

Add a `useEffect`-driven fetch of `GET /api/workspaces/${workspaceId}/usage` on mount, rendered only inside the existing `isBilled` branch (before its closing `</div>`, right after the existing status paragraph). Read the current file in full first (already shown above during planning — reproduced here for reference) and insert the usage block; don't restructure the rest of the component.

```tsx
'use client';

import { useEffect, useState } from 'react';

const ACTIVE_STATUSES = new Set(['TRIALING', 'ACTIVE']);

interface UsageSummary {
  publishedItemCount: number;
  includedItems: number | null;
  remaining: number | null;
  overageCount: number;
  percentUsed: number | null;
}

function UsageSection({ workspaceId }: { workspaceId: string }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/workspaces/${workspaceId}/usage`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: UsageSummary | null) => {
        if (!cancelled) setUsage(data);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (!usage) return null;

  const isUnlimited = usage.includedItems === null;
  const percent = usage.percentUsed ?? 0;
  const approachingQuota = !isUnlimited && percent >= 80 && percent < 100;
  const overQuota = !isUnlimited && percent >= 100;

  return (
    <div className="mt-6 border-t border-line pt-6 text-left">
      <div className="text-sm font-semibold text-ink">Usage this period</div>
      {isUnlimited ? (
        <p className="mt-2 text-sm text-sub">
          {usage.publishedItemCount} published items — Unlimited on this plan.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-sub">
            {usage.publishedItemCount} / {usage.includedItems} published items
          </p>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-line">
            <div
              className={`h-full rounded-full ${overQuota ? 'bg-red' : 'bg-cobalt'}`}
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>
          <p className="mt-2 text-sm text-sub">
            {overQuota ? `${usage.overageCount} over quota` : `${usage.remaining} remaining`}
          </p>
          {approachingQuota ? (
            <p className="mt-3 text-sm text-amber">
              Approaching your plan&apos;s included usage for this period.
            </p>
          ) : null}
          {overQuota ? (
            <p className="mt-3 text-sm text-red">
              You&apos;ve exceeded your included usage for this period — overage charges apply.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function BillingSettings({
  workspaceId,
  pricingTier,
  subscriptionStatus,
}: {
  workspaceId: string;
  pricingTier: 'STARTER' | 'ENTERPRISE';
  subscriptionStatus: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isBilled = pricingTier === 'ENTERPRISE' || ACTIVE_STATUSES.has(subscriptionStatus);

  if (isBilled) {
    return (
      <div className="rounded-lg border border-line bg-panel p-8 text-center">
        <div className="font-mono text-sm font-bold tracking-[0.06em] text-green">
          {pricingTier === 'ENTERPRISE' ? 'ENTERPRISE PLAN' : 'STARTER PLAN — ACTIVE'}
        </div>
        <p className="mt-4 text-sm text-sub">
          {pricingTier === 'ENTERPRISE'
            ? 'This workspace is on a custom, sales-assisted plan. Contact your account manager for changes.'
            : 'This workspace has an active subscription — teammates can be invited freely.'}
        </p>
        <UsageSection workspaceId={workspaceId} />
      </div>
    );
  }

  // ... rest of the component (startCheckout, requestEnterprise, the
  // not-billed JSX) is UNCHANGED from the current file — do not modify it.
}
```

Note: use whatever color token this codebase actually has for a warning/amber state (check `tailwind.config`/existing usages of a warning color — e.g. grep for `text-amber` or similar across `apps/web/src` first; if no amber/warning token exists, use `text-sub` with bold weight instead of inventing a new color token, or reuse `text-red` at a lighter shade only if one already exists in the design system — don't add a new Tailwind color).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/app/workspaces/\[workspaceId\]/billing/billing-settings.test.tsx`
Expected: PASS, all 5 tests.

- [ ] **Step 6: Full web suite + typecheck + lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint src/app/workspaces/\[workspaceId\]/billing/
```

Expected: everything green, no regressions.

- [ ] **Step 7: Manual smoke test**

```bash
cd apps/web && pnpm dev
```

Sign in, navigate to a billed workspace's `/workspaces/{id}/billing` page, confirm the usage section renders with real numbers (or "Unlimited" for ENTERPRISE) and no console errors. Stop the dev server after confirming.

- [ ] **Step 8: Commit**

```bash
git add src/app/workspaces/\[workspaceId\]/billing/
git commit -m "Show usage vs. quota with threshold banners on the billing page (Issue #91)"
```

---

### Task 4: Full regression, documentation, close the issue

**Files:** none beyond `architecture.md`

- [ ] **Step 1: Run the full regression**

```bash
cd apps/web && npx vitest run && npx tsc --noEmit && npx eslint .
```

Expected: everything green. (No `apps/api` changes in this plan, so no Python regression needed — confirm no `apps/api` files were touched: `git diff main --stat` should show only `apps/web/**` and `docs/**`/`architecture.md`.)

- [ ] **Step 2: Update `architecture.md`**

Add a new subsection after the most recent `### ` entry under section 5 (the same numbered section the AI-rate-limit and connector-transport subsections live in), before `## 6. Deployment & Infrastructure`:

```markdown
### Customer-facing AI usage tracking (Issue 12.4, `apps/web/src/lib/usage.ts`)

The customer-facing counterpart to Issue 1.6/10.9's internal `/internal/ai-costs` margin dashboard — same underlying data, different audience. `getWorkspaceUsageSummary()` computes usage **live** (counts `PublishedItem` rows for the current UTC calendar month directly, joined `PublishedItem → DraftItem → Project → workspaceId`) rather than reading `UsagePeriod.publishedItemCount`, which is only refreshed when `POST /billing/meter-usage` runs and can lag — this guarantees the number shown to a customer can never diverge from what `apps/api`'s metering would compute if run right now, satisfying the AC that displayed usage must match what's billed. The period-boundary and join logic is intentionally duplicated (not shared) between `apps/api/app/services/billing/metering.py` and this file, since the two apps don't share an ORM — keep both in sync if either changes. Quota numbers reuse the existing placeholder constants from `pricing.ts` (`STARTER_INCLUDED_ITEMS = 50`); ENTERPRISE is always unlimited. Surfaced on the existing `/workspaces/{id}/billing` page (a "Usage this period" section with a progress bar, shown only once a workspace is billed) and via `GET /api/workspaces/{id}/usage` for programmatic polling — both same-origin, session-authenticated (`requireWorkspaceRole(..., ['ADMIN'])`), no new API-key mechanism. Enforcement is soft-warn only: a banner appears at 80% (approaching) and 100%+ (over — overage billing applies, already built in 10.9) of quota, but publishing is never blocked. No email/Slack notifications and no persisted `Notification` model — deliberately out of scope, since no notification infrastructure exists anywhere else in this repo yet.
```

- [ ] **Step 3: Commit**

```bash
git add architecture.md
git commit -m "Document customer-facing usage tracking in architecture.md"
```

- [ ] **Step 4: Close Issue #91**

```bash
gh issue close 91 --comment "$(cat <<'EOF'
Implemented as a live-computed usage summary layered on top of Issue 10.9's existing metering data model — no new tables, no new background jobs, no enforcement changes.

**Live, always-accurate usage**: `getWorkspaceUsageSummary()` (`apps/web/src/lib/usage.ts`) counts `PublishedItem` rows for the current UTC calendar month directly on every call, rather than reading the `UsagePeriod.publishedItemCount` counter (which only refreshes when `POST /billing/meter-usage` runs and has no cron yet). This guarantees the customer-facing number can never diverge from what `apps/api`'s metering would compute right now — directly satisfying the AC that usage tracking units must match exactly what's billed.

**Visibility, not just billing-time surprise**: a "Usage this period" section on the existing `/workspaces/{id}/billing` page shows published items used vs. plan quota, remaining/overage count, and a progress bar. A banner appears at 80% (approaching quota) and 100%+ (over quota, overage billing applies) — visible any time an admin checks the page, not just on the invoice.

**Programmatic access**: `GET /api/workspaces/{id}/usage` returns the same summary as JSON, session-authenticated via the existing `requireWorkspaceRole(..., ['ADMIN'])` pattern (no new API-key mechanism — none exists in this repo).

**Scope decisions** (confirmed with the user before implementation): quota numbers reuse the existing placeholder pricing constants (real numbers are a business decision, not engineering scope); enforcement is soft-warn only, no hard stop, since overage is already priced and billed; no email/Slack notifications or persisted Notification model, since no notification infrastructure exists anywhere in this repo yet — an in-app banner satisfies the "clear, actionable" AC without inventing new infrastructure.

Full regression: web test suite green, tsc/eslint clean.
EOF
)"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage**: all 3 ACs covered — live usage visibility (Task 1+3), threshold banner (Task 3), units matching billing exactly (Task 1's live-count design, explicitly not reading the possibly-stale `UsagePeriod` row).
- **Type consistency**: `UsageSummary` interface defined once in `usage.ts` (Task 1), consumed identically by the route (Task 2) and the page's local `UsageSummary` type (Task 3) — the page's local type is a subset (omits `periodStart`/`periodEnd`/`tier`, which it doesn't render), which is fine since it only destructures what it uses; no field-name mismatches between the two.
- **Regression safety**: `requireWorkspaceRole` returns 401/403 only (never 404) per `apps/web/src/lib/workspace-context.ts` — Task 2's tests were corrected to test 401/403 only, not 404, matching the function's actual contract (unlike the page-level `requireWorkspaceRole` + `notFound()` pattern used elsewhere, which converts a 403 to a 404 page-side — the API route returns the raw status, consistent with sibling routes like `billing/checkout/route.ts`).
- **No placeholders**: every step has real, complete code — no "add appropriate styling" or "write tests for the above" placeholders.
- **Deliberately scoped down**: no enforcement/blocking logic, no notification infrastructure, no org-level rollups, no historical charts — all explicitly named out of scope in the design spec and not touched by any task here.
