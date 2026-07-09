"""Anthropic per-token pricing, USD per million tokens.

Static reference data — changes only when Anthropic changes prices, which is
a code deploy either way. Update alongside app.services.ai.config.DEFAULT_MODEL
if the default model changes.

Cache reads are priced at ~0.1x base input; cache writes at ~1.25x (5-minute
TTL, the only TTL this adapter uses).
"""

from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel


class ModelPricing(BaseModel):
    input_per_mtok: Decimal
    output_per_mtok: Decimal
    cache_read_per_mtok: Decimal
    cache_creation_per_mtok: Decimal


PRICING: dict[str, ModelPricing] = {
    "claude-opus-4-8": ModelPricing(
        input_per_mtok=Decimal("5.00"),
        output_per_mtok=Decimal("25.00"),
        cache_read_per_mtok=Decimal("0.50"),
        cache_creation_per_mtok=Decimal("6.25"),
    ),
    "claude-sonnet-5": ModelPricing(
        input_per_mtok=Decimal("3.00"),
        output_per_mtok=Decimal("15.00"),
        cache_read_per_mtok=Decimal("0.30"),
        cache_creation_per_mtok=Decimal("3.75"),
    ),
    "claude-haiku-4-5": ModelPricing(
        input_per_mtok=Decimal("1.00"),
        output_per_mtok=Decimal("5.00"),
        cache_read_per_mtok=Decimal("0.10"),
        cache_creation_per_mtok=Decimal("1.25"),
    ),
}

_MTOK = Decimal(1_000_000)


def calculate_cost_usd(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> Decimal:
    pricing = PRICING.get(model)
    if pricing is None:
        raise ValueError(f"No pricing configured for model {model!r}")

    return (
        Decimal(input_tokens) * pricing.input_per_mtok
        + Decimal(output_tokens) * pricing.output_per_mtok
        + Decimal(cache_read_tokens) * pricing.cache_read_per_mtok
        + Decimal(cache_creation_tokens) * pricing.cache_creation_per_mtok
    ) / _MTOK
