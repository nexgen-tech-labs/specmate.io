"""Tier -> requests-per-minute limits for API rate limiting (Issue 12.1)."""

from __future__ import annotations

from app.models import PricingTier

_LIMITS: dict[PricingTier, int] = {
    PricingTier.STARTER: 60,
    PricingTier.ENTERPRISE: 600,
}


def requests_per_minute_for_tier(tier: PricingTier) -> int:
    try:
        return _LIMITS[tier]
    except KeyError as exc:
        raise ValueError(
            f"No rate limit configured for pricing tier {tier!r} — add it to _LIMITS."
        ) from exc
