"""Claude implementation of AIAdapter. See adapter.py for the provider-agnostic contract."""

from __future__ import annotations

import json
import time
from typing import Any

import anthropic
from anthropic import AsyncAnthropic
from anthropic.types import MessageParam

from app.core.config import settings
from app.services.ai.adapter import (
    AIGenerationError,
    GenerationRequest,
    GenerationResult,
    UsageInfo,
)
from app.services.ai.config import get_task_model
from app.services.ai.pricing import calculate_cost_usd

_MAX_RETRIES = 3
_TIMEOUT_SECONDS = 60.0


class ClaudeAdapter:
    def __init__(self, client: AsyncAnthropic | None = None) -> None:
        self._client = client or AsyncAnthropic(
            api_key=settings.anthropic_api_key,
            max_retries=_MAX_RETRIES,
            timeout=_TIMEOUT_SECONDS,
        )

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        task_config = get_task_model(request.task)
        started = time.monotonic()

        messages: list[MessageParam] = [
            {"role": m.role, "content": m.content} for m in request.messages
        ]
        extra_kwargs: dict[str, Any] = {}
        if request.system is not None:
            extra_kwargs["system"] = request.system

        try:
            response = await self._client.messages.create(
                model=task_config.model,
                max_tokens=task_config.max_tokens,
                messages=messages,
                thinking={"type": "adaptive"},
                output_config={
                    "effort": task_config.effort,
                    "format": {"type": "json_schema", "schema": request.schema_},
                },
                **extra_kwargs,
            )
        except (anthropic.RateLimitError, anthropic.APIStatusError, anthropic.APIConnectionError) as exc:
            raise AIGenerationError(
                f"Claude generation failed for task={request.task!r} model={task_config.model!r}: {exc}"
            ) from exc

        latency_ms = int((time.monotonic() - started) * 1000)

        text_blocks = [block.text for block in response.content if block.type == "text"]
        raw_text = "".join(text_blocks)
        data = json.loads(raw_text)

        usage = UsageInfo(
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            cache_read_tokens=response.usage.cache_read_input_tokens or 0,
            cache_creation_tokens=response.usage.cache_creation_input_tokens or 0,
        )
        cost_usd = calculate_cost_usd(
            model=task_config.model,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cache_read_tokens=usage.cache_read_tokens,
            cache_creation_tokens=usage.cache_creation_tokens,
        )

        return GenerationResult(
            data=data,
            raw_text=raw_text,
            usage=usage,
            cost_usd=cost_usd,
            latency_ms=latency_ms,
            model=task_config.model,
            prompt_version=request.prompt_version,
        )
