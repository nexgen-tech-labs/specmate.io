"""Tier -> requests-per-minute mapping (Issue 12.1)."""

from __future__ import annotations

from app.core.rate_limit_config import requests_per_minute_for_tier
from app.models import PricingTier


def test_starter_tier_limit() -> None:
    assert requests_per_minute_for_tier(PricingTier.STARTER) == 60


def test_enterprise_tier_limit() -> None:
    assert requests_per_minute_for_tier(PricingTier.ENTERPRISE) == 600
