"""Usage metering + Stripe reporting endpoints (Issue 10.9).

No real job scheduler exists yet in this codebase (see architecture.md — parsing
and generation are synchronous-per-request too), so these are invoked
on-demand rather than on a cron. `POST /billing/meter-usage` is intended to be
called periodically (daily) by an external scheduler once one exists; running
it more or less often is harmless — metering is idempotent per period and
reporting only ever sends the delta.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.services.billing.metering import meter_all_workspaces_for_current_period
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
