"""Tier -> requests-per-minute mapping (Issue 12.1)."""

from __future__ import annotations

import pytest

from app.core import rate_limit_config
from app.core.rate_limit_config import requests_per_minute_for_tier
from app.models import PricingTier


def test_starter_tier_limit() -> None:
    assert requests_per_minute_for_tier(PricingTier.STARTER) == 60


def test_enterprise_tier_limit() -> None:
    assert requests_per_minute_for_tier(PricingTier.ENTERPRISE) == 600


def test_unconfigured_tier_raises_value_error_not_key_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Guards against a future PricingTier value being added without a matching
    entry in _LIMITS -- that must fail loudly with an actionable ValueError,
    not an opaque KeyError that would 500 every request for that tier."""
    monkeypatch.setattr(rate_limit_config, "_LIMITS", {})

    with pytest.raises(ValueError, match="No rate limit configured for pricing tier"):
        requests_per_minute_for_tier(PricingTier.STARTER)
