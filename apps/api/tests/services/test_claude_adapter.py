from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import anthropic
import httpx
import pytest

from app.services.ai.adapter import AIGenerationError, GenerationRequest, Message
from app.services.ai.claude_adapter import ClaudeAdapter


def _fake_response(
    text: str = '{"title": "Do the thing", "priority": "medium"}',
    input_tokens: int = 100,
    output_tokens: int = 20,
    cache_read: int = 0,
    cache_creation: int = 0,
) -> SimpleNamespace:
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_input_tokens=cache_read,
            cache_creation_input_tokens=cache_creation,
        ),
    )


def _make_request(**overrides: object) -> GenerationRequest:
    defaults: dict[str, object] = {
        "task": "extraction",
        "messages": [Message(role="user", content="extract this")],
        "schema_": {"type": "object", "properties": {}},
        "workspace_id": "ws_1",
        "project_id": "proj_1",
    }
    defaults.update(overrides)
    return GenerationRequest(**defaults)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_generate_builds_request_with_output_config_and_task_model() -> None:
    mock_client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(return_value=_fake_response())))
    adapter = ClaudeAdapter(client=mock_client)  # type: ignore[arg-type]

    result = await adapter.generate(_make_request())

    call_kwargs = mock_client.messages.create.call_args.kwargs
    assert call_kwargs["model"] == "claude-opus-4-8"
    assert call_kwargs["thinking"] == {"type": "adaptive"}
    assert call_kwargs["output_config"]["effort"] == "low"  # extraction task config
    assert call_kwargs["output_config"]["format"]["type"] == "json_schema"
    assert result.data == {"title": "Do the thing", "priority": "medium"}
    assert result.model == "claude-opus-4-8"


@pytest.mark.asyncio
async def test_generate_computes_usage_and_cost() -> None:
    mock_client = SimpleNamespace(
        messages=SimpleNamespace(
            create=AsyncMock(
                return_value=_fake_response(input_tokens=1_000_000, output_tokens=1_000_000)
            )
        )
    )
    adapter = ClaudeAdapter(client=mock_client)  # type: ignore[arg-type]

    result = await adapter.generate(_make_request())

    assert result.usage.input_tokens == 1_000_000
    assert result.usage.output_tokens == 1_000_000
    assert result.cost_usd == Decimal("30.00")
    assert result.latency_ms >= 0


@pytest.mark.asyncio
async def test_generate_threads_prompt_version_through() -> None:
    mock_client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(return_value=_fake_response())))
    adapter = ClaudeAdapter(client=mock_client)  # type: ignore[arg-type]

    result = await adapter.generate(_make_request(prompt_version="extraction_v1"))

    assert result.prompt_version == "extraction_v1"


@pytest.mark.asyncio
async def test_generate_raises_ai_generation_error_on_rate_limit() -> None:
    fake_httpx_response = httpx.Response(
        status_code=429,
        request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"),
    )
    rate_limit_error = anthropic.RateLimitError(
        message="rate limited",
        response=fake_httpx_response,
        body=None,
    )
    mock_client = SimpleNamespace(
        messages=SimpleNamespace(create=AsyncMock(side_effect=rate_limit_error))
    )
    adapter = ClaudeAdapter(client=mock_client)  # type: ignore[arg-type]

    with pytest.raises(AIGenerationError):
        await adapter.generate(_make_request())
