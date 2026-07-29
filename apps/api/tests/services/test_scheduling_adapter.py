"""SchedulingAdapter (Issue 12.3): wraps any AIAdapter, gating every generate()
call through an AIScheduler and stamping the result with queue-wait info."""

from __future__ import annotations

import asyncio

from app.services.ai.adapter import GenerationRequest, GenerationResult, Message, UsageInfo
from app.services.ai.scheduler import AIScheduler
from app.services.ai.scheduling_adapter import SchedulingAdapter
from decimal import Decimal


class _FakeInnerAdapter:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        self.calls += 1
        await asyncio.sleep(0.01)
        return GenerationResult(
            data={},
            raw_text="{}",
            usage=UsageInfo(input_tokens=1, output_tokens=1, cache_read_tokens=0, cache_creation_tokens=0),
            cost_usd=Decimal("0"),
            latency_ms=1,
            model="test-model",
            prompt_version=None,
        )


def _request(workspace_id: str) -> GenerationRequest:
    return GenerationRequest(
        task="clustering",
        messages=[Message(role="user", content="x")],
        schema_={},
        workspace_id=workspace_id,
        project_id="proj-1",
    )


async def test_delegates_to_the_inner_adapter_and_preserves_its_result_fields() -> None:
    inner = _FakeInnerAdapter()
    scheduler = AIScheduler(max_concurrent=2)
    adapter = SchedulingAdapter(inner, scheduler)

    result = await adapter.generate(_request("ws-a"))

    assert inner.calls == 1
    assert result.model == "test-model"
    # An uncontended acquire still awaits an asyncio.Event once, so
    # queue_wait_seconds is a tiny nonzero duration rather than exactly 0 —
    # assert it's negligible (no real queueing happened) instead of == 0.0.
    assert result.queue_wait_seconds < 0.05
    assert result.queue_depth_at_submit == 0


async def test_stamps_nonzero_queue_wait_when_a_call_had_to_wait_for_a_slot() -> None:
    inner = _FakeInnerAdapter()
    scheduler = AIScheduler(max_concurrent=1)
    adapter = SchedulingAdapter(inner, scheduler)

    results: list[GenerationResult] = []

    async def call(workspace_id: str) -> None:
        results.append(await adapter.generate(_request(workspace_id)))

    await asyncio.gather(call("ws-a"), call("ws-b"))

    assert inner.calls == 2
    assert any(r.queue_wait_seconds > 0 for r in results)
