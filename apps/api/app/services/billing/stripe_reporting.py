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

from datetime import UTC, datetime

import stripe
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import UsagePeriod, Workspace


class BillingNotConfiguredError(Exception):
    pass


def _client() -> stripe.StripeClient:
    if not settings.stripe_secret_key:
        raise BillingNotConfiguredError(
            "STRIPE_SECRET_KEY is not set — usage cannot be reported to Stripe."
        )
    return stripe.StripeClient(settings.stripe_secret_key)


async def report_usage_period(session: AsyncSession, usage_period: UsagePeriod) -> int | None:
    """Reports the delta (publishedItemCount - reportedCount) as one meter event,
    then updates and COMMITS reportedCount/reportedToStripeAt on the row itself
    (Issue #110) — not left for the caller to commit later. Returns the
    reported delta, or None if there was nothing new to report (delta <= 0) or
    the workspace has no Stripe customer yet (e.g. ENTERPRISE tier, not
    self-serve billed).

    Committing here (not just updating in-memory) closes a narrow
    double-report window: if reportedCount were only updated in-memory and the
    caller's own commit later failed or was interrupted, a retry would re-read
    the stale (pre-update) reportedCount and could recompute an overlapping
    delta — the `identifier` alone doesn't protect against this, since it's
    built from publishedItemCount, which can change between the failed
    attempt and the retry, so Stripe's own event-identifier dedup wouldn't
    necessarily catch it. Committing immediately after the Stripe call
    succeeds means a crash after this point can't lose the fact that the
    report already happened."""
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
            "event_name": settings.stripe_usage_event_name,
            "identifier": identifier,
            "payload": {
                "stripe_customer_id": workspace.stripeCustomerId,
                "value": str(delta),
            },
        }
    )
    usage_period.reportedCount = usage_period.publishedItemCount
    usage_period.reportedToStripeAt = datetime.now(UTC).replace(tzinfo=None)
    await session.commit()
    return delta


async def fetch_stripe_reported_total(workspace: Workspace, usage_period: UsagePeriod) -> int:
    """Reads back Stripe's own recorded total for this workspace/period via the
    Billing Meter Event Summaries API (Issue 12.5) — the read-side counterpart
    to report_usage_period's write-side meter_events.create call. Used only by
    reconciliation; never called from the normal reporting path. Raises
    BillingNotConfiguredError if Stripe or the meter ID isn't configured, same
    fail-loud posture as report_usage_period."""
    if not workspace.stripeCustomerId:
        raise ValueError(f"Workspace {workspace.id} has no stripeCustomerId — nothing to reconcile")
    if not settings.stripe_usage_meter_id:
        raise BillingNotConfiguredError("STRIPE_USAGE_METER_ID is not set.")
    client = _client()

    start_ts = int(usage_period.periodStart.replace(tzinfo=UTC).timestamp())
    end_ts = int(usage_period.periodEnd.replace(tzinfo=UTC).timestamp())
    summaries = client.v1.billing.meters.event_summaries.list(
        id=settings.stripe_usage_meter_id,
        params={
            "customer": workspace.stripeCustomerId,
            "start_time": start_ts,
            "end_time": end_ts,
        },
    )
    return int(sum(s.aggregated_value for s in summaries.data))
