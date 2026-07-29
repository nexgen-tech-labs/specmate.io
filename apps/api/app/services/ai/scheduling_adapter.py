"""Wraps any AIAdapter with AIScheduler's concurrency cap + fair-use queueing
(Issue 12.3). Same decorator pattern as logging_adapter.py — a cross-cutting
concern applied at the call site, not baked into any provider implementation.
Composed as the outermost layer (see routers/generation.py's
get_generation_adapter) so it gates the call BEFORE logging/the provider call
happen, and its queue-wait stamping survives being wrapped."""

from __future__ import annotations

from dataclasses import replace

from app.services.ai.adapter import AIAdapter, GenerationRequest, GenerationResult
from app.services.ai.scheduler import AIScheduler


class SchedulingAdapter:
    def __init__(self, inner: AIAdapter, scheduler: AIScheduler) -> None:
        self._inner = inner
        self._scheduler = scheduler

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        async with self._scheduler.acquire(request.workspace_id) as ticket:
            result = await self._inner.generate(request)
            return replace(
                result,
                queue_wait_seconds=ticket.queue_wait_seconds,
                queue_depth_at_submit=ticket.queue_depth_at_submit,
            )
