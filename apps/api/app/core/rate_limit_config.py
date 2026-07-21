"""Tier -> requests-per-minute limits for API rate limiting (Issue 12.1)."""

from __future__ import annotations

from app.models import PricingTier

_LIMITS: dict[PricingTier, int] = {
    PricingTier.STARTER: 60,
    PricingTier.ENTERPRISE: 600,
}


def requests_per_minute_for_tier(tier: PricingTier) -> int:
    return _LIMITS[tier]
