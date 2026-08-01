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
