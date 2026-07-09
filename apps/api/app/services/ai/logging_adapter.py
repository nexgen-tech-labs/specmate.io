"""Wraps any AIAdapter to write an AiCallLog row per call, including failures.

Kept separate from ClaudeAdapter so the provider adapter has no DB dependency —
logging is a cross-cutting concern applied at the call site, not baked into
the provider implementation.
"""

from __future__ import annotations

import time
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AiCallLog
from app.services.ai.adapter import AIAdapter, AIGenerationError, GenerationRequest, GenerationResult


class LoggingAdapter:
    def __init__(self, inner: AIAdapter, session: AsyncSession) -> None:
        self._inner = inner
        self._session = session

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        started = time.monotonic()
        try:
            result = await self._inner.generate(request)
        except AIGenerationError:
            latency_ms = int((time.monotonic() - started) * 1000)
            self._session.add(
                AiCallLog(
                    workspaceId=request.workspace_id,
                    projectId=request.project_id,
                    task=request.task,
                    model="unknown",
                    promptVersion=request.prompt_version,
                    inputTokens=0,
                    outputTokens=0,
                    cacheReadTokens=0,
                    cacheCreationTokens=0,
                    costUsd=Decimal("0"),
                    latencyMs=latency_ms,
                )
            )
            await self._session.commit()
            raise

        self._session.add(
            AiCallLog(
                workspaceId=request.workspace_id,
                projectId=request.project_id,
                task=request.task,
                model=result.model,
                promptVersion=result.prompt_version,
                inputTokens=result.usage.input_tokens,
                outputTokens=result.usage.output_tokens,
                cacheReadTokens=result.usage.cache_read_tokens,
                cacheCreationTokens=result.usage.cache_creation_tokens,
                costUsd=result.cost_usd,
                latencyMs=result.latency_ms,
            )
        )
        await self._session.commit()
        return result
