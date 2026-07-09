"""Provider-agnostic AI generation interface.

Any provider implementation (Claude today, others later) satisfies AIAdapter's
Protocol. Call sites depend only on this module, never on a concrete provider
SDK — swapping providers means writing a new class here, not touching callers.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Protocol

from pydantic import BaseModel


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class GenerationRequest(BaseModel):
    task: str
    """Looked up in TASK_MODELS (app.services.ai.config) to pick model/effort."""

    messages: list[Message]
    schema_: dict[str, object]
    """JSON schema the structured output must match."""

    workspace_id: str
    project_id: str
    system: str | None = None
    prompt_version: str | None = None


@dataclass(frozen=True, slots=True)
class UsageInfo:
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int


@dataclass(frozen=True, slots=True)
class GenerationResult:
    data: dict[str, object]
    raw_text: str
    usage: UsageInfo
    cost_usd: Decimal
    latency_ms: int
    model: str
    prompt_version: str | None


class AIGenerationError(Exception):
    """Raised when a generation call fails after retries are exhausted."""


class AIAdapter(Protocol):
    async def generate(self, request: GenerationRequest) -> GenerationResult: ...
