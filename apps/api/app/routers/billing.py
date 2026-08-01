"""Usage metering + Stripe reporting endpoints (Issue 10.9).

No real job scheduler exists yet in this codebase (see architecture.md — parsing
and generation are synchronous-per-request too), so these are invoked
on-demand rather than on a cron. `POST /billing/meter-usage` is intended to be
called periodically (daily) by an external scheduler once one exists; running
it more or less often is harmless — metering is idempotent per period and
reporting only ever sends the delta.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import UsagePeriod, UsageReconciliationFlag
from app.services.billing.metering import (
    current_period_bounds,
    meter_all_workspaces_for_current_period,
)
from app.services.billing.reconciliation import reconcile_workspace_usage
from app.services.billing.stripe_reporting import BillingNotConfiguredError, report_usage_period

router = APIRouter()


class UsagePeriodResult(BaseModel):
    workspace_id: str
    published_item_count: int
    reported_delta: int | None


class MeterUsageResponse(BaseModel):
    results: list[UsagePeriodResult]
    stripe_reporting_skipped: bool


@router.post("/billing/meter-usage")
async def meter_usage(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> MeterUsageResponse:
    usage_periods = await meter_all_workspaces_for_current_period(session)
    await session.commit()

    results: list[UsagePeriodResult] = []
    stripe_reporting_skipped = False
    for usage_period in usage_periods:
        reported_delta: int | None = None
        try:
            reported_delta = await report_usage_period(session, usage_period)
        except BillingNotConfiguredError:
            stripe_reporting_skipped = True
        results.append(
            UsagePeriodResult(
                workspace_id=usage_period.workspaceId,
                published_item_count=usage_period.publishedItemCount,
                reported_delta=reported_delta,
            )
        )
    await session.commit()

    return MeterUsageResponse(results=results, stripe_reporting_skipped=stripe_reporting_skipped)


class ReconciliationFlagResult(BaseModel):
    workspace_id: str
    usage_period_id: str
    internal_count: int
    stripe_count: int


class ReconcileUsageResponse(BaseModel):
    checked: int
    flagged: list[ReconciliationFlagResult]
    stripe_reconciliation_skipped: bool


@router.post("/billing/reconcile-usage")
async def reconcile_usage(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ReconcileUsageResponse:
    """Manual-trigger reconciliation sweep (Issue 12.5): for every UsagePeriod row
    in the current billing period, reads back Stripe's own recorded total and
    diffs it against our reportedCount, flagging mismatches. Same
    per-workspace-error-tolerance as /billing/meter-usage: a single workspace's
    Stripe misconfiguration (e.g. STRIPE_USAGE_METER_ID unset, or a workspace
    missing a stripeCustomerId that somehow still triggers a config error)
    doesn't abort the whole sweep — it's skipped and surfaced via
    stripe_reconciliation_skipped rather than 500ing the whole request."""
    period_start, _ = current_period_bounds()
    usage_periods = (
        await session.execute(
            select(UsagePeriod).where(UsagePeriod.periodStart == period_start)
        )
    ).scalars().all()

    flagged: list[ReconciliationFlagResult] = []
    stripe_reconciliation_skipped = False
    for usage_period in usage_periods:
        try:
            flag = await reconcile_workspace_usage(session, usage_period)
        except (BillingNotConfiguredError, ValueError):
            # ValueError covers fetch_stripe_reported_total's own "no
            # stripeCustomerId" guard — unreachable today since
            # reconcile_workspace_usage already short-circuits on that same
            # condition before calling it, but caught here defensively in
            # case a future call path skips that upstream guard.
            stripe_reconciliation_skipped = True
            continue
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
    return ReconcileUsageResponse(
        checked=len(usage_periods),
        flagged=flagged,
        stripe_reconciliation_skipped=stripe_reconciliation_skipped,
    )


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
