"""Usage metering (Issue 10.9) — the metered component of the hybrid pricing
model: base subscription + per-published-item overage.

`meter_workspace_for_period` counts PublishedItem rows created within a UTC
calendar-month window for one workspace, joined through DraftItem -> Project to
reach workspaceId (PublishedItem doesn't carry it directly). Upserts a
UsagePeriod row — idempotent per (workspaceId, periodStart), so re-running
metering for an already-counted period just recomputes the count rather than
double-counting or erroring.

Reporting the count to Stripe as a usage record is a separate step
(stripe_reporting.py) — metering and reporting are split so metering can run
(and be tested) without any Stripe dependency at all.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DraftItem, Project, PublishedItem, UsagePeriod, Workspace
from app.services.billing.stripe_reporting import report_usage_period

logger = logging.getLogger(__name__)


def current_period_bounds(now: datetime | None = None) -> tuple[datetime, datetime]:
    """UTC calendar-month window: [first of this month 00:00, first of next month 00:00)."""
    now = (now or datetime.now(UTC)).replace(tzinfo=None)
    period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if period_start.month == 12:
        period_end = period_start.replace(year=period_start.year + 1, month=1)
    else:
        period_end = period_start.replace(month=period_start.month + 1)
    return period_start, period_end


async def meter_workspace_for_period(
    session: AsyncSession,
    workspace_id: str,
    period_start: datetime,
    period_end: datetime,
) -> UsagePeriod:
    count = (
        await session.execute(
            select(func.count(PublishedItem.id))
            .join(DraftItem, DraftItem.id == PublishedItem.draftItemId)
            .join(Project, Project.id == DraftItem.projectId)
            .where(
                Project.workspaceId == workspace_id,
                PublishedItem.deletedAt.is_(None),
                PublishedItem.createdAt >= period_start,
                PublishedItem.createdAt < period_end,
            )
        )
    ).scalar_one()

    existing = (
        await session.execute(
            select(UsagePeriod).where(
                UsagePeriod.workspaceId == workspace_id,
                UsagePeriod.periodStart == period_start,
            )
        )
    ).scalar_one_or_none()

    now = datetime.now(UTC).replace(tzinfo=None)
    if existing is not None:
        existing.publishedItemCount = count
        existing.updatedAt = now
        return existing

    row = UsagePeriod(
        workspaceId=workspace_id,
        periodStart=period_start,
        periodEnd=period_end,
        publishedItemCount=count,
        createdAt=now,
        updatedAt=now,
    )
    session.add(row)
    return row


async def meter_all_workspaces_for_current_period(session: AsyncSession) -> list[UsagePeriod]:
    """Meters every non-deleted workspace for the current UTC calendar month.
    Intended to run on a daily/hourly schedule (see architecture.md — no real
    job scheduler exists yet, this is invoked via a router endpoint for now,
    same synchronous-job pattern as parsing/generation)."""
    period_start, period_end = current_period_bounds()
    workspace_ids = (
        await session.execute(select(Workspace.id).where(Workspace.deletedAt.is_(None)))
    ).scalars()

    rows = []
    for workspace_id in workspace_ids:
        row = await meter_workspace_for_period(session, workspace_id, period_start, period_end)
        rows.append(row)
    return rows


async def report_workspace_current_usage(session: AsyncSession, workspace_id: str) -> None:
    """Best-effort near-real-time reporting (Issue 12.5): meters + reports just
    this one workspace's current period, called inline right after a publish.
    Never raises — a reporting hiccup must not fail the publish request that
    triggered it. The periodic /billing/meter-usage sweep is the backstop that
    catches anything an inline report missed — this function is an
    optimization for freshness, not the sole source of truth for whether usage
    eventually gets reported. This also covers BillingNotConfiguredError (raised
    when STRIPE_SECRET_KEY is unset), so local/test/dev environments without
    Stripe configured don't spam logs on every publish."""
    try:
        period_start, period_end = current_period_bounds()
        usage_period = await meter_workspace_for_period(
            session, workspace_id, period_start, period_end
        )
        await report_usage_period(session, usage_period)
        await session.commit()
    except Exception:
        logger.exception("Inline usage reporting failed for workspace %s", workspace_id)
