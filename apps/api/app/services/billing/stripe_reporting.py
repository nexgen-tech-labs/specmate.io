"""Reports metered usage to Stripe (Issue 10.9) via the Billing Meter Events API
(`stripe.billing.meterEvents.create`) — the current Stripe metered-billing
mechanism (superseded the older `usage_records.create` endpoint). Each call is
additive: Stripe accumulates meter events into the invoice's usage total, so
this reports the delta since the period's last report, not the running count,
using a deterministic `identifier` for idempotency (Stripe deduplicates by
identifier within a rolling window, so a retried report can't double-count).

Requires a Stripe Meter configured with `event_name` matching
STRIPE_USAGE_EVENT_NAME (default: "published_item"), and the Starter overage
Price configured to bill against that meter. This module has no test-mode
default it can silently proceed with — report_usage_period() raises
ConnectorError-style if Stripe isn't configured, same "fail loud, not silent"
posture as the rest of the connector code in this codebase.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import stripe
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import UsagePeriod, Workspace

USAGE_EVENT_NAME = os.environ.get("STRIPE_USAGE_EVENT_NAME", "published_item")


class BillingNotConfiguredError(Exception):
    pass


def _client() -> stripe.StripeClient:
    key = os.environ.get("STRIPE_SECRET_KEY")
    if not key:
        raise BillingNotConfiguredError(
            "STRIPE_SECRET_KEY is not set — usage cannot be reported to Stripe."
        )
    return stripe.StripeClient(key)


async def report_usage_period(session: AsyncSession, usage_period: UsagePeriod) -> int | None:
    """Reports the delta (publishedItemCount - reportedCount) as one meter event,
    then updates reportedCount/reportedToStripeAt on the row (caller commits).
    Returns the reported delta, or None if there was nothing new to report
    (delta <= 0) or the workspace has no Stripe customer yet (e.g. ENTERPRISE
    tier, not self-serve billed)."""
    workspace = await session.get(Workspace, usage_period.workspaceId)
    if workspace is None or not workspace.stripeCustomerId:
        return None

    delta = usage_period.publishedItemCount - usage_period.reportedCount
    if delta <= 0:
        return None

    client = _client()
    identifier = f"{usage_period.id}:{usage_period.publishedItemCount}"
    client.v1.billing.meter_events.create(
        params={
            "event_name": USAGE_EVENT_NAME,
            "identifier": identifier,
            "payload": {
                "stripe_customer_id": workspace.stripeCustomerId,
                "value": str(delta),
            },
        }
    )
    usage_period.reportedCount = usage_period.publishedItemCount
    usage_period.reportedToStripeAt = datetime.now(UTC).replace(tzinfo=None)
    return delta
