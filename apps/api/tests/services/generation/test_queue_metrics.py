"""Unit tests for the Issue #115 queueing-observability plumbing in
pipeline.py — _QueueMetrics accumulation and _call()'s threshold warning.
No DB needed; these exercise pure in-memory logic."""

from __future__ import annotations

import logging
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest

from app.services.ai.adapter import GenerationResult, UsageInfo
from app.services.generation.pipeline import _QueueMetrics, _call


def _fake_result(queue_wait_seconds: float, queue_depth_at_submit: int) -> GenerationResult:
    return GenerationResult(
        data={},
        raw_text="{}",
        usage=UsageInfo(1, 1, 0, 0),
        cost_usd=Decimal("0"),
        latency_ms=1,
        model="fake",
        prompt_version="v1",
        queue_wait_seconds=queue_wait_seconds,
        queue_depth_at_submit=queue_depth_at_submit,
    )


class TestQueueMetrics:
    def test_sums_wait_seconds_across_multiple_records(self) -> None:
        metrics = _QueueMetrics()
        metrics.record(0.5, 1)
        metrics.record(1.5, 3)
        assert metrics.wait_seconds_total == pytest.approx(2.0)

    def test_takes_the_max_depth_across_records_not_the_sum(self) -> None:
        metrics = _QueueMetrics()
        metrics.record(0.1, 1)
        metrics.record(0.1, 5)
        metrics.record(0.1, 2)
        assert metrics.depth_at_submit_max == 5

    def test_starts_at_zero(self) -> None:
        metrics = _QueueMetrics()
        assert metrics.wait_seconds_total == 0.0
        assert metrics.depth_at_submit_max == 0


class TestCallQueueMetricsThreading:
    @pytest.mark.asyncio
    async def test_call_records_onto_the_passed_accumulator(self) -> None:
        adapter = AsyncMock()
        adapter.generate.return_value = _fake_result(0.5, 2)
        metrics = _QueueMetrics()

        await _call(adapter, "task", "sys", "user", {}, "ws-1", "proj-1", metrics)

        assert metrics.wait_seconds_total == pytest.approx(0.5)
        assert metrics.depth_at_submit_max == 2

    @pytest.mark.asyncio
    async def test_call_is_a_no_op_without_an_accumulator(self) -> None:
        adapter = AsyncMock()
        adapter.generate.return_value = _fake_result(0.5, 2)

        data = await _call(adapter, "task", "sys", "user", {}, "ws-1", "proj-1")

        assert data == {}

    @pytest.mark.asyncio
    async def test_call_logs_a_warning_when_queue_wait_exceeds_the_threshold(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        adapter = AsyncMock()
        adapter.generate.return_value = _fake_result(15.0, 4)

        with caplog.at_level(logging.WARNING, logger="app.services.generation.pipeline"):
            await _call(adapter, "clustering", "sys", "user", {}, "ws-1", "proj-1")

        assert any("queued" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_call_does_not_log_below_the_threshold(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        adapter = AsyncMock()
        adapter.generate.return_value = _fake_result(0.5, 1)

        with caplog.at_level(logging.WARNING, logger="app.services.generation.pipeline"):
            await _call(adapter, "clustering", "sys", "user", {}, "ws-1", "proj-1")

        assert caplog.records == []
