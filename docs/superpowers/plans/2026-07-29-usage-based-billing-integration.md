# Usage-based billing integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Issue 10.9's metering/Stripe-reporting to real billing operations: report usage inline right after each publish (near-real-time), reconcile SpecMate's counters against Stripe's own recorded totals (catching drift, mirroring the Epic 9 drift-check pattern), and support real Stripe-side proration on mid-period tier changes.

**Architecture:** Three additive pieces on top of already-shipped 10.9 code, no new scheduler/cron. (1) A best-effort inline reporting call added to each of the 3 publish routers. (2) A new `UsageReconciliationFlag` model + `POST /billing/reconcile-usage` / `POST /billing/reconciliation-flags/{flag_id}/resolve` endpoints, structurally parallel to Epic 9's `DriftFlag`/`drift.py`. (3) `/billing/tier` extended to handle both tier directions and call Stripe's subscription-update API with `proration_behavior: 'create_prorations'` when a billed workspace's plan changes.

**Tech Stack:** FastAPI + SQLAlchemy (`apps/api`), Next.js API routes + Prisma (`apps/web`), Stripe Python SDK 15.3.0 (`stripe.StripeClient` resource-namespaced client), Stripe Node SDK, pytest, vitest.

---

### Task 1: `UsageReconciliationFlag` model (Prisma + SQLAlchemy)

**Files:**

- Modify: `apps/web/prisma/schema.prisma`
- Modify: `apps/api/app/models.py`
- Create: Prisma migration (via `npx prisma migrate dev`)

- [ ] **Step 1: Add the Prisma model**

In `apps/web/prisma/schema.prisma`, add near the existing `UsagePeriod` model:

```prisma
// One row per detected mismatch between what SpecMate recorded and what Stripe
// actually has on file for a billing period (Issue 12.5) — structurally
// parallel to DriftFlag (Issue 9.5): flag on mismatch, never silently
// auto-correct, a human resolves. "Resolved" is inferred from resolvedAt
// being non-null, same convention as DriftFlag's resolution-nullability.
model UsageReconciliationFlag {
  id              String    @id @default(cuid())
  usagePeriodId   String    @unique
  workspaceId     String
  internalCount   Int
  stripeCount     Int
  detectedAt      DateTime  @default(now())
  resolvedAt      DateTime?
  resolvedByUserId String?

  usagePeriod UsagePeriod @relation(fields: [usagePeriodId], references: [id])
  workspace   Workspace   @relation(fields: [workspaceId], references: [id])
}
```

Add the reverse relations: on `UsagePeriod`, add `reconciliationFlag UsageReconciliationFlag?`; on `Workspace`, add `usageReconciliationFlags UsageReconciliationFlag[]`. Read the current `UsagePeriod` and `Workspace` model blocks first to place these correctly alongside existing relation fields (e.g. next to `Workspace.usagePeriods UsagePeriod[]` if that reverse relation already exists — check).

`@@unique` is on `usagePeriodId` directly (not a compound constraint) since each `UsagePeriod` can have at most one reconciliation flag — this differs from `DriftFlag`, which has no unique constraint because a `PublishedItem` can accumulate multiple _resolved_ flags over time; here, re-reconciling the same period should update the existing flag rather than create a new one each time (see Task 3's upsert logic).

- [ ] **Step 2: Generate and apply the migration**

```bash
cd apps/web && npx prisma migrate dev --name add_usage_reconciliation_flag
```

Expected: migration file created under `apps/web/prisma/migrations/`, applied to the local dev DB without error.

- [ ] **Step 3: Add the SQLAlchemy mirror**

In `apps/api/app/models.py`, near the existing `UsagePeriod` class, add:

```python
class UsageReconciliationFlag(Base):
    __tablename__ = "UsageReconciliationFlag"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_cuid)
    usagePeriodId: Mapped[str] = mapped_column(ForeignKey("UsagePeriod.id"), unique=True)
    workspaceId: Mapped[str] = mapped_column(ForeignKey("Workspace.id"))
    internalCount: Mapped[int] = mapped_column(Integer)
    stripeCount: Mapped[int] = mapped_column(Integer)
    detectedAt: Mapped[datetime] = mapped_column(DateTime)
    resolvedAt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolvedByUserId: Mapped[str | None] = mapped_column(String, nullable=True)
```

Check the exact imports already present at the top of `models.py` (`Mapped`, `mapped_column`, `ForeignKey`, `Integer`, `DateTime`, `String`, `datetime`, `_cuid`) — reuse them, don't reimport. Match the exact style of the neighboring `UsagePeriod` class (e.g. does it use `Mapped[int]` with `default=0` anywhere relevant — `internalCount`/`stripeCount` here have no default since they're always set at creation).

- [ ] **Step 4: Verify both sides agree**

```bash
cd apps/api && uv run python -c "from app.models import UsageReconciliationFlag; print(UsageReconciliationFlag.__table__.columns.keys())"
```

Expected: prints all 8 column names, no import error.

- [ ] **Step 5: Commit**

```bash
git add apps/web/prisma/schema.prisma apps/web/prisma/migrations/ apps/api/app/models.py
git commit -m "Add UsageReconciliationFlag model (Issue #92)"
```

---

### Task 2: Near-real-time usage reporting — inline call after each publish

**Files:**

- Modify: `apps/api/app/services/billing/metering.py`
- Modify: `apps/api/app/routers/publish.py`
- Modify: `apps/api/app/routers/publish_ado.py`
- Modify: `apps/api/app/routers/publish_github.py`
- Test: `apps/api/tests/services/test_billing_metering.py` (extend)
- Test: extend `apps/api/tests/routers/test_publish.py`, `test_publish_ado.py`, `test_publish_github.py`

- [ ] **Step 1: Read `apps/api/app/services/billing/metering.py` and `stripe_reporting.py` in full to confirm exact current signatures**

```bash
cat apps/api/app/services/billing/metering.py apps/api/app/services/billing/stripe_reporting.py
```

- [ ] **Step 2: Write the failing test for the new helper**

Add to `apps/api/tests/services/test_billing_metering.py` (match its existing `_fixture`/`_cleanup`/`asyncio.run` conventions — read the file in full first):

```python
def test_report_workspace_current_usage_meters_and_reports_without_raising(monkeypatch):
    async def run():
        ids = await _fixture()
        try:
            calls = []

            async def fake_report(session, usage_period):
                calls.append(usage_period.workspaceId)
                return 1

            monkeypatch.setattr(
                "app.services.billing.metering.report_usage_period", fake_report
            )
            async with AsyncSession(engine) as session:
                await report_workspace_current_usage(session, ids["workspace_id"])
            assert calls == [ids["workspace_id"]]
        finally:
            await _cleanup(ids)
    asyncio.run(run())


def test_report_workspace_current_usage_never_raises_on_reporting_failure(monkeypatch):
    async def run():
        ids = await _fixture()
        try:
            async def fake_report_raises(session, usage_period):
                raise RuntimeError("stripe is down")

            monkeypatch.setattr(
                "app.services.billing.metering.report_usage_period", fake_report_raises
            )
            async with AsyncSession(engine) as session:
                # Must not raise — best-effort, never blocks the publish flow.
                await report_workspace_current_usage(session, ids["workspace_id"])
        finally:
            await _cleanup(ids)
    asyncio.run(run())
```

Adjust the exact fixture/helper names (`_fixture`, `_cleanup`, `engine`, `AsyncSession` import path) to match what's ACTUALLY in the current file — read it first, don't assume. Add `import logging` / a `caplog` assertion if you want to confirm the failure is actually logged (recommended: assert `"Inline usage reporting failed"` appears in `caplog.text` for the second test, using pytest's `caplog` fixture).

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/services/test_billing_metering.py -v -k report_workspace_current_usage
```

Expected: FAIL — `report_workspace_current_usage` doesn't exist yet.

- [ ] **Step 4: Add `report_workspace_current_usage` to `metering.py`**

```python
import logging

logger = logging.getLogger(__name__)


async def report_workspace_current_usage(session: AsyncSession, workspace_id: str) -> None:
    """Best-effort near-real-time reporting (Issue 12.5): meters + reports just
    this one workspace's current period, called inline right after a publish.
    Never raises — a reporting hiccup must not fail the publish request that
    triggered it. The periodic /billing/meter-usage sweep (and, if configured,
    an external scheduler calling it) is the backstop that catches anything an
    inline report missed — this function is an optimization for freshness, not
    the sole source of truth for whether usage eventually gets reported."""
    try:
        period_start, period_end = current_period_bounds()
        usage_period = await meter_workspace_for_period(
            session, workspace_id, period_start, period_end
        )
        await report_usage_period(session, usage_period)
        await session.commit()
    except Exception:
        logger.exception("Inline usage reporting failed for workspace %s", workspace_id)
```

Add the `from app.services.billing.stripe_reporting import report_usage_period` import if not already present in `metering.py` (check first — it may currently only be imported by `billing.py`, not by `metering.py` itself, to avoid a circular import; if `stripe_reporting.py` imports anything from `metering.py`, importing the reverse direction here could create a cycle — check `stripe_reporting.py`'s imports before adding this, and if there's a cycle risk, do a local import inside the function body instead of a top-of-file import).

Note: `BillingNotConfiguredError` (raised by `report_usage_period` when `STRIPE_SECRET_KEY` is unset) is also caught by the broad `except Exception` here — this is intentional: in local/test environments without Stripe configured, inline reporting silently no-ops rather than spamming logs on every publish. This differs from `/billing/meter-usage`'s router-level handling (which surfaces `stripe_reporting_skipped` in its response) — that's fine, since this inline call has no response to report back through; it's fire-and-forget from the publish caller's perspective.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/api && uv run pytest tests/services/test_billing_metering.py -v -k report_workspace_current_usage
```

Expected: PASS, both new tests.

- [ ] **Step 6: Wire the call into all 3 publish routers**

Read `apps/api/app/routers/publish.py`, `publish_ado.py`, `publish_github.py` in full first, to find the exact line where `PublishedItem` is added/flushed/committed and the workspace ID is available (likely via `project.workspaceId` or similar — the exact variable name will differ per router; confirm from the actual code, don't guess).

In each router, add right before the return of the publish endpoint (after the `PublishedItem` row and any commit already happens):

```python
from app.services.billing.metering import report_workspace_current_usage

# ... inside the endpoint function, after PublishedItem is created/committed ...
await report_workspace_current_usage(session, workspace_id)
```

Match each router's existing variable name for the workspace id (read the actual code — it may be `project.workspaceId`, a separately-fetched `workspace.id`, etc.). Add the import at the top of each of the 3 files, in the same import-grouping style already used there.

- [ ] **Step 7: Extend each publish router's tests to confirm inline reporting doesn't break the publish flow**

For each of `test_publish.py`, `test_publish_ado.py`, `test_publish_github.py`, add ONE test confirming a publish still succeeds (200, `PublishedItem` created) even though Stripe isn't configured in the test environment (i.e., `report_workspace_current_usage`'s internal `except Exception` swallows the `BillingNotConfiguredError` and the publish response is unaffected). Since `STRIPE_SECRET_KEY` is not set in the test environment by default (confirm this assumption by checking `apps/api/tests/conftest.py` or the test `.env` — if Stripe IS configured in test env, you'll need to monkeypatch `app.services.billing.stripe_reporting._client` to raise instead), this should already be implicitly true — write a test that publishes an item and asserts success, to lock in this behavior as a regression guard rather than leaving it implicit.

Example addition to `test_publish.py` (adapt exactly to its existing test/fixture style — read the file first):

```python
def test_publish_succeeds_even_when_stripe_is_not_configured():
    async def run():
        ids = await _fixture()
        try:
            await _dispose()
            client = TestClient(app)
            fake = _FakeJira()
            app.dependency_overrides[get_publish_gateway] = fake.gateway
            try:
                res = client.post(f"/draft-items/{ids['draft_item_id']}/publish", json={...})
                assert res.status_code == 200
            finally:
                app.dependency_overrides.pop(get_publish_gateway, None)
        finally:
            await _cleanup(ids)
    asyncio.run(run())
```

Fill in the actual request body shape and endpoint path from the existing tests in the same file — don't guess the payload shape.

- [ ] **Step 8: Run each publish router's full test file + the metering test file**

```bash
cd apps/api
uv run pytest tests/routers/test_publish.py tests/routers/test_publish_ado.py tests/routers/test_publish_github.py tests/services/test_billing_metering.py -v
```

Expected: all pass, no regressions from baseline (check current pass count first via `uv run pytest -q --collect-only 2>&1 | tail -3` before making changes, then confirm baseline+new after).

- [ ] **Step 9: Full API regression + typecheck + lint**

```bash
cd apps/api
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 10: Commit**

```bash
git add apps/api/app/services/billing/metering.py apps/api/app/routers/publish.py apps/api/app/routers/publish_ado.py apps/api/app/routers/publish_github.py apps/api/tests/
git commit -m "Report usage to Stripe inline after each publish (Issue #92)"
```

---

### Task 3: Reconciliation — Stripe readback, flag model, endpoints

**Files:**

- Modify: `apps/api/app/services/billing/stripe_reporting.py` (add the meter-ID config + readback helper)
- Create: `apps/api/app/services/billing/reconciliation.py`
- Modify: `apps/api/app/routers/billing.py`
- Modify: `apps/api/app/core/config.py`
- Modify: `apps/api/.env.example`
- Test: `apps/api/tests/services/test_reconciliation.py` (new)
- Test: extend `apps/api/tests/routers/` with a new `test_billing.py` if one doesn't exist (check — per research, no router-level billing test file exists today)

- [ ] **Step 1: Add `stripe_usage_meter_id` config**

Stripe's meter-summary readback API (`client.v1.billing.meters.event_summaries.list(id=meter_id, params=...)`) requires the Stripe **Meter object ID** (e.g. `mtr_...`), which is DIFFERENT from `STRIPE_USAGE_EVENT_NAME` (the event name string) already configured. This is a genuinely new piece of required config — add it.

In `apps/api/app/core/config.py`, add near the existing Stripe settings:

```python
    stripe_usage_meter_id: str = ""
```

In `apps/api/.env.example`, add near the existing `STRIPE_USAGE_EVENT_NAME` line:

```
# Stripe Meter object ID (mtr_...) for the "published_item" meter — distinct from
# STRIPE_USAGE_EVENT_NAME (the event name string). Required for reconciliation
# readback (Issue 12.5); find it in the Stripe Dashboard under the meter's
# details page, or via `stripe billing_meters list`.
STRIPE_USAGE_METER_ID=""
```

- [ ] **Step 2: Write the failing test for the readback helper**

Create `apps/api/tests/services/test_reconciliation.py`. First read `apps/api/tests/services/test_billing_metering.py` in full to match its exact `_fixture`/`_cleanup`/`asyncio.run` conventions (real Postgres, no ORM-level test doubles for the DB layer).

```python
import asyncio
from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import engine
from app.models import UsageReconciliationFlag, UsagePeriod
from app.services.billing.reconciliation import reconcile_workspace_usage

# ... reuse or adapt the _fixture/_cleanup helpers from test_billing_metering.py,
# extended to also create a UsagePeriod row directly (not via meter_workspace_for_period,
# to keep this test focused on reconciliation logic alone) ...


def test_reconcile_creates_no_flag_when_counts_match(monkeypatch):
    async def run():
        ids = await _fixture()
        try:
            async with AsyncSession(engine) as session:
                usage_period = await session.get(UsagePeriod, ids["usage_period_id"])
                # usage_period.reportedCount is set to e.g. 5 in the fixture

                async def fake_fetch_stripe_total(workspace, usage_period):
                    return 5  # matches reportedCount exactly

                monkeypatch.setattr(
                    "app.services.billing.reconciliation._fetch_stripe_reported_total",
                    fake_fetch_stripe_total,
                )
                flag = await reconcile_workspace_usage(session, usage_period)
                await session.commit()
                assert flag is None

                remaining = (
                    await session.execute(
                        select(UsageReconciliationFlag).where(
                            UsageReconciliationFlag.usagePeriodId == usage_period.id
                        )
                    )
                ).scalar_one_or_none()
                assert remaining is None
        finally:
            await _cleanup(ids)
    asyncio.run(run())


def test_reconcile_creates_a_flag_on_mismatch(monkeypatch):
    async def run():
        ids = await _fixture()
        try:
            async with AsyncSession(engine) as session:
                usage_period = await session.get(UsagePeriod, ids["usage_period_id"])

                async def fake_fetch_stripe_mismatch(workspace, usage_period):
                    return 3  # doesn't match reportedCount (5 in fixture)

                monkeypatch.setattr(
                    "app.services.billing.reconciliation._fetch_stripe_reported_total",
                    fake_fetch_stripe_mismatch,
                )
                flag = await reconcile_workspace_usage(session, usage_period)
                await session.commit()
                assert flag is not None
                assert flag.internalCount == 5
                assert flag.stripeCount == 3
                assert flag.resolvedAt is None
        finally:
            await _cleanup(ids)
    asyncio.run(run())


def test_reconcile_refreshes_existing_flag_instead_of_duplicating(monkeypatch):
    async def run():
        ids = await _fixture()
        try:
            async def fake_fetch_first(workspace, usage_period):
                return 3

            async def fake_fetch_second(workspace, usage_period):
                return 2  # a second, different mismatch on re-run

            async with AsyncSession(engine) as session:
                usage_period = await session.get(UsagePeriod, ids["usage_period_id"])
                monkeypatch.setattr(
                    "app.services.billing.reconciliation._fetch_stripe_reported_total",
                    fake_fetch_first,
                )
                first_flag = await reconcile_workspace_usage(session, usage_period)
                await session.commit()

                monkeypatch.setattr(
                    "app.services.billing.reconciliation._fetch_stripe_reported_total",
                    fake_fetch_second,
                )
                second_flag = await reconcile_workspace_usage(session, usage_period)
                await session.commit()

                assert first_flag.id == second_flag.id  # same row, updated in place
                assert second_flag.stripeCount == 2

                all_flags = (
                    await session.execute(
                        select(UsageReconciliationFlag).where(
                            UsageReconciliationFlag.usagePeriodId == usage_period.id
                        )
                    )
                ).scalars().all()
                assert len(all_flags) == 1
        finally:
            await _cleanup(ids)
    asyncio.run(run())
```

Adjust imports/fixture details to match the real current code once you read it — this is illustrative of the required test cases (match, mismatch-creates-flag, mismatch-refreshes-not-duplicates), not necessarily exact working code.

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/api && uv run pytest tests/services/test_reconciliation.py -v
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Add the Stripe readback helper to `stripe_reporting.py`**

```python
async def fetch_stripe_reported_total(workspace: Workspace, usage_period: UsagePeriod) -> int:
    """Reads back Stripe's own recorded total for this workspace/period via the
    Billing Meter Event Summaries API (Issue 12.5) — the read-side counterpart
    to report_usage_period's write-side meter_events.create call. Used only by
    reconciliation; never called from the normal reporting path. Raises
    BillingNotConfiguredError under the same conditions report_usage_period does."""
    if not workspace.stripeCustomerId:
        raise ValueError(f"Workspace {workspace.id} has no stripeCustomerId — nothing to reconcile")
    client = _client()
    meter_id = settings.stripe_usage_meter_id
    if not meter_id:
        raise BillingNotConfiguredError("STRIPE_USAGE_METER_ID is not configured")

    start_ts = int(usage_period.periodStart.replace(tzinfo=UTC).timestamp())
    end_ts = int(usage_period.periodEnd.replace(tzinfo=UTC).timestamp())
    summaries = client.v1.billing.meters.event_summaries.list(
        id=meter_id,
        params={
            "customer": workspace.stripeCustomerId,
            "start_time": start_ts,
            "end_time": end_ts,
        },
    )
    return int(sum(s.aggregated_value for s in summaries.data))
```

Check `_client()`'s exact current signature/import needs in `stripe_reporting.py` (already reads `STRIPE_SECRET_KEY` via `os.environ.get` per earlier research — confirm whether `settings.stripe_usage_meter_id` should be read the same way (`os.environ.get("STRIPE_USAGE_METER_ID")`) for consistency with the rest of this file, or via the `Settings` object (`from app.core.config import settings`) if that's already imported elsewhere in this file — match whichever convention `stripe_reporting.py` already uses for `STRIPE_USAGE_EVENT_NAME`, read the actual current code to confirm.

Verify `MeterEventSummary.aggregated_value` is a `float` per the SDK's type stub (confirmed during research) — casting the sum to `int()` assumes published-item counts are always whole numbers, which they are (each `PublishedItem` = 1 unit), so this is safe.

- [ ] **Step 5: Add `apps/api/app/services/billing/reconciliation.py`**

```python
"""Reconciliation (Issue 12.5): reads Stripe's own recorded usage and diffs it
against SpecMate's internal reportedCount, mirroring Epic 9's drift-check
pattern (drift.py) — fetch the external system's actual state, diff against
our last-known-recorded state, flag on mismatch, never silently auto-correct.
Manual-trigger only (POST /billing/reconcile-usage), no scheduler, same
posture as /billing/meter-usage and /drift-check."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import UsagePeriod, UsageReconciliationFlag, Workspace
from app.services.billing.stripe_reporting import fetch_stripe_reported_total


async def reconcile_workspace_usage(
    session: AsyncSession, usage_period: UsagePeriod
) -> UsageReconciliationFlag | None:
    workspace = await session.get(Workspace, usage_period.workspaceId)
    if workspace is None or not workspace.stripeCustomerId:
        return None  # unbilled workspace (e.g. ENTERPRISE without Stripe) — nothing to reconcile

    stripe_total = await fetch_stripe_reported_total(workspace, usage_period)
    if stripe_total == usage_period.reportedCount:
        return None

    existing = (
        await session.execute(
            select(UsageReconciliationFlag).where(
                UsageReconciliationFlag.usagePeriodId == usage_period.id
            )
        )
    ).scalar_one_or_none()

    now = datetime.now(UTC).replace(tzinfo=None)
    if existing is not None:
        existing.internalCount = usage_period.reportedCount
        existing.stripeCount = stripe_total
        existing.detectedAt = now
        existing.resolvedAt = None
        existing.resolvedByUserId = None
        return existing

    flag = UsageReconciliationFlag(
        usagePeriodId=usage_period.id,
        workspaceId=usage_period.workspaceId,
        internalCount=usage_period.reportedCount,
        stripeCount=stripe_total,
        detectedAt=now,
    )
    session.add(flag)
    return flag
```

Note: re-flagging an already-`resolvedAt`-set flag resets it to unresolved (`existing.resolvedAt = None`) — a NEW mismatch on a previously-resolved period is a fresh problem, not something the old resolution should silently cover. This is a deliberate deviation from `DriftFlag`'s pattern (which only looks at _open_, i.e. `resolution IS NULL`, flags when deciding whether to create-vs-update) — here we look up by `usagePeriodId` unconditionally (there's at most one flag per period ever, per the `@@unique` constraint) and always refresh it, resolved or not, since a period can only be reconciled meaningfully once per actual mismatch state.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/api && uv run pytest tests/services/test_reconciliation.py -v
```

Expected: PASS, all 3 tests.

- [ ] **Step 7: Add router endpoints to `billing.py`**

Read the current full file first (already known: single `POST /billing/meter-usage` endpoint, no `HTTPException` usage, no auth dependency). Add:

```python
from fastapi import HTTPException
from sqlalchemy import select

from app.models import UsagePeriod, UsageReconciliationFlag
from app.services.billing.reconciliation import reconcile_workspace_usage


class ReconciliationFlagResult(BaseModel):
    workspace_id: str
    usage_period_id: str
    internal_count: int
    stripe_count: int


class ReconcileUsageResponse(BaseModel):
    checked: int
    flagged: list[ReconciliationFlagResult]


@router.post("/billing/reconcile-usage")
async def reconcile_usage(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ReconcileUsageResponse:
    period_start, _ = current_period_bounds()
    usage_periods = (
        await session.execute(
            select(UsagePeriod).where(UsagePeriod.periodStart == period_start)
        )
    ).scalars().all()

    flagged: list[ReconciliationFlagResult] = []
    for usage_period in usage_periods:
        flag = await reconcile_workspace_usage(session, usage_period)
        if flag is not None:
            flagged.append(
                ReconciliationFlagResult(
                    workspace_id=flag.workspaceId,
                    usage_period_id=flag.usagePeriodId,
                    internal_count=flag.internalCount,
                    stripe_count=flag.stripeCount,
                )
            )
    await session.commit()
    return ReconcileUsageResponse(checked=len(usage_periods), flagged=flagged)


class ResolveReconciliationBody(BaseModel):
    resolved_by_user_id: str | None = None


class ResolveReconciliationResponse(BaseModel):
    ok: bool


@router.post("/billing/reconciliation-flags/{flag_id}/resolve")
async def resolve_reconciliation_flag(
    flag_id: str,
    body: ResolveReconciliationBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ResolveReconciliationResponse:
    flag = await session.get(UsageReconciliationFlag, flag_id)
    if flag is None:
        raise HTTPException(status_code=404, detail="Reconciliation flag not found.")
    if flag.resolvedAt is not None:
        raise HTTPException(status_code=409, detail="Flag is already resolved.")
    flag.resolvedAt = datetime.now(UTC).replace(tzinfo=None)
    flag.resolvedByUserId = body.resolved_by_user_id
    await session.commit()
    return ResolveReconciliationResponse(ok=True)
```

This adopts `drift.py`'s `HTTPException` 404/409 convention for the resolve endpoint (matching `resolve_drift`'s exact pattern), while `reconcile_usage` itself follows `meter_usage`'s existing no-exception convention (a summary response, not per-workspace errors) — consistent with each endpoint's closest sibling in this same file/area. `resolvedByUserId` comes from the request body, not server-side auth — matching `drift.py`'s exact existing pattern (confirmed: no `current_user` dependency exists anywhere in this router area today).

Check whether `current_period_bounds` and `datetime`/`UTC` are already imported in `billing.py` — add if missing.

- [ ] **Step 8: Write router tests**

Create `apps/api/tests/routers/test_billing.py` (none exists today, per research — first test file for this router). Match `test_drift.py`'s conventions if it has router-level tests (check `apps/api/tests/routers/test_drift.py` first and copy its structure), otherwise follow `test_billing_metering.py`'s general fixture style adapted for `TestClient`.

Cover: `reconcile-usage` with matching counts (empty `flagged` list), with a mismatch (one flagged entry, `UsageReconciliationFlag` row actually persisted), and `resolve` endpoint's 404 (nonexistent flag id), 409 (already-resolved), and 200 happy path.

- [ ] **Step 9: Run tests, typecheck, lint**

```bash
cd apps/api
uv run pytest tests/services/test_reconciliation.py tests/routers/test_billing.py -v
uv run pytest -q
uv run mypy app
uv run ruff check .
```

- [ ] **Step 10: Commit**

```bash
git add apps/api/app/services/billing/ apps/api/app/routers/billing.py apps/api/app/core/config.py apps/api/.env.example apps/api/tests/
git commit -m "Add usage reconciliation against Stripe's recorded totals (Issue #92)"
```

---

### Task 4: Proration on tier change

**Files:**

- Modify: `apps/web/src/app/api/workspaces/[workspaceId]/billing/tier/route.ts`
- Test: `apps/web/src/app/api/workspaces/[workspaceId]/billing/tier/route.test.ts` (extend or create — check first)

- [ ] **Step 1: Read the current `tier/route.ts` in full**

```bash
cat "apps/web/src/app/api/workspaces/[workspaceId]/billing/tier/route.ts"
```

Confirmed from earlier research: currently only accepts `tier: "ENTERPRISE"`, rejects everything else with 400, never touches Stripe.

- [ ] **Step 2: Write the failing tests**

Check whether `tier/route.test.ts` already exists (`ls "apps/web/src/app/api/workspaces/[workspaceId]/billing/tier/"`); if so read it in full and extend it, matching its exact conventions (likely similar to `checkout/route.ts`'s sibling test, or the `invites/route.test.ts` pattern used elsewhere — check which). If it doesn't exist, follow `invites/route.test.ts`'s conventions (real Postgres fixtures, `vi.mock('@/lib/auth', ...)`).

Mock the Stripe client the same way `stripe/webhook/route.test.ts` does (read that file's mocking approach first — it's the closest existing precedent for mocking `@/lib/stripe` in this test suite) rather than inventing a new mocking convention.

Tests needed:

1. `ENTERPRISE → STARTER` on a workspace with an active `stripeSubscriptionId`: asserts `stripe.subscriptions.update` was called with `proration_behavior: 'create_prorations'` and the correct target price.
2. `STARTER → ENTERPRISE` on a workspace with an active `stripeSubscriptionId`: same assertion, opposite direction (if ENTERPRISE has no fixed price, decide in Step 3 what "switching to ENTERPRISE" actually does to the subscription — likely cancels the metered Starter subscription rather than "changing price," since ENTERPRISE per `pricing.ts` has `baseUsd: null`/custom sales-assisted pricing with no fixed Price ID to switch to. Confirm this reasoning is sound before writing the test — if ENTERPRISE truly has no Stripe Price ID, the correct proration behavior when downgrading TO enterprise from a paid Starter subscription is most likely to cancel the existing subscription (`stripe.subscriptions.update(..., cancel_at_period_end: false)` or `stripe.subscriptions.cancel(...)`) rather than "update to a new price" — adjust the plan's Step 3 code and this test accordingly once you've re-read `pricing.ts` and confirmed there's genuinely no ENTERPRISE Stripe Price ID anywhere in `.env.example`).
3. Tier change on a workspace with NO active Stripe subscription (e.g. still free-while-solo): asserts the plain Prisma update still happens, Stripe is never called (matches today's existing STARTER-has-no-subscription-yet case).
4. Invalid tier value: still 400 (unchanged existing behavior — regression guard).

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/web && npx vitest run "src/app/api/workspaces/[workspaceId]/billing/tier/route.test.ts"
```

- [ ] **Step 4: Extend `tier/route.ts`**

Read `apps/web/src/lib/stripe.ts`'s `getStripeClient()`/`isStripeConfigured()` and `apps/web/src/app/api/stripe/webhook/route.ts`'s existing `customer.subscription.updated` handling (already confirmed: it generically re-derives `subscriptionBaseUsd` from whichever line item is non-metered — a Stripe-side subscription-item update will flow through this existing handler correctly with NO webhook changes needed, per research finding #6).

Sketch (fill in exact current file structure — imports, auth check, error response shapes — from Step 1's read):

```ts
import { getStripeClient, isStripeConfigured } from '@/lib/stripe';

// ... existing imports/auth check unchanged ...

const VALID_TIERS = new Set(['STARTER', 'ENTERPRISE']);

export async function POST(request: Request, { params }: Params) {
  // ... existing auth check unchanged ...
  const body = await request.json();
  if (!VALID_TIERS.has(body.tier)) {
    return NextResponse.json({ error: 'Invalid tier.' }, { status: 400 });
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });

  if (workspace.stripeSubscriptionId && isStripeConfigured()) {
    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(workspace.stripeSubscriptionId);
    const overageItem = subscription.items.data.find(
      (item) => item.price.recurring?.usage_type === 'metered',
    );
    if (body.tier === 'STARTER' && overageItem) {
      const basePriceId = process.env.STRIPE_STARTER_PRICE_ID;
      const overagePriceId = process.env.STRIPE_STARTER_OVERAGE_PRICE_ID;
      const baseItem = subscription.items.data.find((item) => item.id !== overageItem.id);
      await stripe.subscriptions.update(workspace.stripeSubscriptionId, {
        items: [
          { id: baseItem?.id, price: basePriceId },
          { id: overageItem.id, price: overagePriceId },
        ],
        proration_behavior: 'create_prorations',
      });
    } else if (body.tier === 'ENTERPRISE') {
      // ENTERPRISE has no fixed Stripe Price (custom/sales-assisted, per pricing.ts) —
      // moving a paid Starter workspace to Enterprise cancels the metered
      // subscription rather than switching to a new price. Stripe still prorates
      // the cancellation's final invoice automatically.
      await stripe.subscriptions.update(workspace.stripeSubscriptionId, {
        cancel_at_period_end: false,
        proration_behavior: 'create_prorations',
      });
      await stripe.subscriptions.cancel(workspace.stripeSubscriptionId);
    }
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data:
      body.tier === 'ENTERPRISE'
        ? { pricingTier: 'ENTERPRISE', subscriptionStatus: 'NONE' }
        : { pricingTier: 'STARTER' },
  });

  return NextResponse.json({ ok: true });
}
```

This sketch is illustrative, not final — re-derive the exact subscription-item-swap shape once you've read Stripe Node SDK's actual `subscriptions.update` type signature (check `node_modules/stripe`'s installed type defs the same way the Python research checked the installed Python SDK — don't guess the TS shape either) and confirm whether swapping BOTH items in one `update` call (as sketched) is correct Stripe API usage, or whether the base-price item should stay untouched (only the overage item ever needs to change if base/overage price IDs don't change between calls — reconsider whether the base-item swap in the STARTER branch is even necessary, since if STARTER's price IDs are constant, only ENTERPRISE→STARTER needs the base item ADDED, not swapped — trace this carefully against actual current subscription state rather than the illustrative sketch above).

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run "src/app/api/workspaces/[workspaceId]/billing/tier/route.test.ts"
```

- [ ] **Step 6: Full web regression, typecheck, lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint "src/app/api/workspaces/[workspaceId]/billing/tier/"
```

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/workspaces/[workspaceId]/billing/tier/"
git commit -m "Support both tier-change directions with Stripe proration (Issue #92)"
```

---

### Task 5: Full regression, documentation, close the issue

**Files:** none beyond `architecture.md`

- [ ] **Step 1: Full regression for both apps**

```bash
cd apps/api && uv run pytest -q && uv run mypy app && uv run ruff check .
cd ../web && npx vitest run && npx tsc --noEmit && npx eslint .
```

- [ ] **Step 2: Manual smoke test**

```bash
cd apps/api && uv run uvicorn app.main:app --port 8010 &
sleep 3
curl -s http://localhost:8010/health
kill %1
```

Confirms the new `UsageReconciliationFlag` model and `billing.py` router changes don't break app startup.

- [ ] **Step 3: Update `architecture.md`**

Add a new subsection after the most recent `### ` entry under section 5, before `## 6. Deployment & Infrastructure`:

```markdown
### Usage-based billing integration (Issue 12.5, `apps/api/app/services/billing/reconciliation.py`)

Connects Issue 10.9's metering/reporting to real billing operations, without adding a job scheduler. **Near-real-time reporting**: each of the 3 publish routers (Jira/ADO/GitHub) calls `report_workspace_current_usage()` inline right after creating a `PublishedItem` — best-effort, never blocks or fails the publish response (a reporting hiccup is logged, not surfaced), with the existing `/billing/meter-usage` sweep as the backstop for anything an inline report missed. **Reconciliation**: `POST /billing/reconcile-usage` mirrors Epic 9's drift-check pattern exactly — reads Stripe's own recorded usage via the Billing Meter Event Summaries API (`fetch_stripe_reported_total()`, a genuinely new readback capability; requires the new `STRIPE_USAGE_METER_ID` config, distinct from the existing `STRIPE_USAGE_EVENT_NAME`), diffs it against SpecMate's internal `reportedCount`, and creates/refreshes (never duplicates, never auto-corrects) a `UsageReconciliationFlag` on mismatch. A human resolves via `POST /billing/reconciliation-flags/{flag_id}/resolve`, same `resolvedByUserId`-from-request-body convention as `DriftFlag` (no server-side auth dependency exists in this router area). **Proration**: `/billing/tier` now handles both STARTER↔ENTERPRISE directions; a tier change on a workspace with an active Stripe subscription calls `stripe.subscriptions.update(..., proration_behavior: 'create_prorations')` (or cancels the subscription when moving to ENTERPRISE, which has no fixed Stripe Price per `pricing.ts`'s custom/sales-assisted model) — Stripe computes the prorated invoice automatically, no manual proration math in application code. The existing Stripe webhook's `customer.subscription.updated` handler already covers the resulting subscription-state sync with no changes needed. **Not built**: marketplace billing reconciliation (Atlassian/GitHub/ADO — Issues 10.2–10.4, still unbuilt, nothing to reconcile against yet), any new scheduler/cron (reconciliation stays a manually-triggered endpoint, same posture as `/billing/meter-usage` and `/drift-check`), historical/past-period reconciliation (current period only).
```

- [ ] **Step 4: Commit**

```bash
git add architecture.md
git commit -m "Document usage-based billing integration in architecture.md"
```

- [ ] **Step 5: Close Issue #92**

```bash
gh issue close 92 --comment "$(cat <<'EOF'
Implemented as three additions on top of Issue 10.9's already-shipped metering/Stripe-reporting — no new job scheduler, no new cron.

**Near-real-time reporting**: each publish router (Jira/ADO/GitHub) now calls `report_workspace_current_usage()` inline right after creating a `PublishedItem`, best-effort (never blocks or fails the publish response on a reporting hiccup). The existing `/billing/meter-usage` periodic sweep remains the backstop for anything an inline report missed.

**Reconciliation**: `POST /billing/reconcile-usage` mirrors Epic 9's drift-check pattern — reads Stripe's own recorded usage via the Billing Meter Event Summaries API (a new readback capability this codebase didn't have before), diffs against SpecMate's internal counters, and flags mismatches for human review rather than silently auto-correcting. `POST /billing/reconciliation-flags/{flag_id}/resolve` closes a flag.

**Proration**: `/billing/tier` now supports both STARTER↔ENTERPRISE directions (previously only STARTER→ENTERPRISE existed) and calls Stripe's real subscription-update API with `proration_behavior: 'create_prorations'` for workspaces with an active subscription — Stripe computes the prorated invoice, no manual math in application code.

**Explicitly out of scope** (confirmed with the user before implementation): marketplace billing reconciliation (Issues 10.2–10.4 aren't built yet — nothing exists to reconcile against), any new scheduler/cron infrastructure (reconciliation stays a manually-triggered endpoint, consistent with every other "deferred scheduler" feature in this repo), historical/past-period reconciliation.

Full regression: both apps' test suites green, mypy/ruff/tsc/eslint clean.
EOF
)"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage**: all 3 ACs covered — near-real-time reporting (Task 2), reconciliation catching drift (Task 3), correctly prorated mid-period changes (Task 4).
- **Type consistency**: `UsageReconciliationFlag`'s fields are identical across the Prisma model (Task 1), the SQLAlchemy mirror (Task 1), and every consumer (`reconciliation.py`'s `reconcile_workspace_usage`, `billing.py`'s two new endpoints) — `internalCount`/`stripeCount`/`resolvedAt`/`resolvedByUserId` field names used consistently throughout.
- **Regression safety**: Task 2's inline reporting call is explicitly designed and tested to never break the publish flow even when Stripe is unconfigured (the default state in dev/test) — this is the load-bearing safety net for retrofitting a new side effect into 3 already-shipped, tested publish routers.
- **No placeholders**: every step has real code; Task 4's proration sketch is explicitly flagged as illustrative-not-final with instructions to verify against the actual installed Stripe Node SDK types before finalizing — this is an honest acknowledgment of genuine API-shape uncertainty (not a placeholder for something knowable that was skipped), consistent with how Task 1 of the AI-rate-limit-handling plan earlier this session flagged its own scheduler sketch as unverified.
- **Deliberately scoped down**: marketplace billing, new scheduler infrastructure, and historical reconciliation are explicitly out of scope and not touched by any task — confirmed via the clarifying questions before this plan was written.
