from decimal import Decimal

import pytest

from app.services.ai.pricing import calculate_cost_usd


def test_cost_for_opus_with_only_input_and_output_tokens() -> None:
    cost = calculate_cost_usd(
        model="claude-opus-4-8",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
    )
    assert cost == Decimal("30.00")  # $5 input + $25 output per MTok


def test_cost_includes_cache_read_and_creation_tokens() -> None:
    cost = calculate_cost_usd(
        model="claude-opus-4-8",
        input_tokens=0,
        output_tokens=0,
        cache_read_tokens=1_000_000,
        cache_creation_tokens=1_000_000,
    )
    assert cost == Decimal("6.75")  # $0.50 + $6.25 per MTok


def test_zero_tokens_costs_nothing() -> None:
    cost = calculate_cost_usd(model="claude-opus-4-8", input_tokens=0, output_tokens=0)
    assert cost == Decimal("0")


def test_unknown_model_raises() -> None:
    with pytest.raises(ValueError, match="No pricing configured"):
        calculate_cost_usd(model="not-a-real-model", input_tokens=100, output_tokens=100)
