"""Reference/demo route proving Issue #1.4's acceptance criterion #1: a single
function call can generate structured JSON output matching a defined schema.
Not a product route — delete once Epic 2/3 add real extraction endpoints."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.services.ai.adapter import AIAdapter, GenerationRequest, Message
from app.services.ai.claude_adapter import ClaudeAdapter
from app.services.ai.logging_adapter import LoggingAdapter
from app.services.ai.prompts.extraction_v1 import EXTRACTION_V1

router = APIRouter()


def get_ai_adapter(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> AIAdapter:
    """FastAPI dependency — overridden in tests to inject a mock adapter."""
    return LoggingAdapter(ClaudeAdapter(), session)

_DEMO_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "priority": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["title", "priority"],
    "additionalProperties": False,
}


class DemoExtractBody(BaseModel):
    text: str
    workspace_id: str
    project_id: str


class DemoExtractResponse(BaseModel):
    title: str
    priority: Literal["low", "medium", "high"]
    model: str
    cost_usd: str
    latency_ms: int


@router.post("/ai/demo-extract")
async def demo_extract(
    body: DemoExtractBody,
    adapter: Annotated[AIAdapter, Depends(get_ai_adapter)],
) -> DemoExtractResponse:
    result = await adapter.generate(
        GenerationRequest(
            task="extraction",
            system=EXTRACTION_V1,
            messages=[Message(role="user", content=body.text)],
            schema_=_DEMO_SCHEMA,
            workspace_id=body.workspace_id,
            project_id=body.project_id,
            prompt_version="extraction_v1",
        )
    )
    priority = result.data["priority"]
    if priority not in ("low", "medium", "high"):
        raise ValueError(f"Unexpected priority value from model: {priority!r}")

    return DemoExtractResponse(
        title=str(result.data["title"]),
        priority=priority,
        model=result.model,
        cost_usd=str(result.cost_usd),
        latency_ms=result.latency_ms,
    )
