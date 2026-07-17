"""Generation endpoints (Epic 3): run the pipeline, regenerate one item with
reviewer context (Issue 3.9), and query run stats (Issue 3.10). Same synchronous
execution model as parsing — a job-table/worker is still the documented follow-up."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import (
    AuditActorType,
    DraftItem,
    DraftItemStatus,
    GenerationRun,
    Project,
    RawRequirement,
    Source,
    TraceLink,
)
from app.services.audit import record_audit_event
from app.services.ai.adapter import AIAdapter, GenerationRequest, Message
from app.services.ai.claude_adapter import ClaudeAdapter
from app.services.ai.logging_adapter import LoggingAdapter
from app.services.ai.prompts.generation_v1 import GENERATION_PROMPT_VERSION, REGENERATE_V1
from app.services.generation.pipeline import GenerationError, run_generation
from app.services.generation.schemas import REGENERATE_SCHEMA
from app.services.generation.targeted import (
    TargetedRegenerationError,
    TargetedRegenerationResult,
    run_targeted_regeneration,
)

router = APIRouter()


def get_generation_adapter(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> AIAdapter:
    """FastAPI dependency — overridden in tests to inject a fake adapter."""
    return LoggingAdapter(ClaudeAdapter(), session)


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class GenerateBody(BaseModel):
    # Optional restriction of supporting item types (Issue 3.1: configurable per project).
    item_types: list[str] | None = None


class GenerateResponse(BaseModel):
    run_id: str
    reused_existing_run: bool
    stats: dict[str, object] | None


@router.post("/projects/{project_id}/generate")
async def generate(
    project_id: str,
    body: GenerateBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    adapter: Annotated[AIAdapter, Depends(get_generation_adapter)],
) -> GenerateResponse:
    before = (
        await session.execute(
            select(func.count(GenerationRun.id)).where(GenerationRun.projectId == project_id)
        )
    ).scalar_one()
    try:
        run = await run_generation(
            project_id,
            session,
            adapter,
            item_types=set(body.item_types) if body.item_types else None,
        )
    except GenerationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    after = (
        await session.execute(
            select(func.count(GenerationRun.id)).where(GenerationRun.projectId == project_id)
        )
    ).scalar_one()
    return GenerateResponse(
        run_id=run.id,
        reused_existing_run=after == before,
        stats=run.stats,
    )


class RegenerateBody(BaseModel):
    context: str
    workspace_id: str


class RegenerateResponse(BaseModel):
    new_item_id: str
    previous_item_id: str


@router.post("/draft-items/{item_id}/regenerate")
async def regenerate_item(
    item_id: str,
    body: RegenerateBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    adapter: Annotated[AIAdapter, Depends(get_generation_adapter)],
) -> RegenerateResponse:
    item = await session.get(DraftItem, item_id)
    if item is None or item.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Draft item not found.")
    if item.status == DraftItemStatus.APPROVED:
        raise HTTPException(
            status_code=409, detail="Approved items are locked — reopen before regenerating."
        )

    trace_result = await session.execute(
        select(TraceLink, RawRequirement)
        .join(RawRequirement, RawRequirement.id == TraceLink.rawRequirementId)
        .where(TraceLink.draftItemId == item_id)
    )
    trace_rows = trace_result.all()
    source_context = "\n".join(f"[{r.id}] ({r.sectionPath}) {r.text}" for _, r in trace_rows)

    user = (
        f"Item type: {item.type.value}\nTitle: {item.title}\nDescription: {item.description}\n"
        f"Source fragments:\n{source_context or '(none recorded)'}\n\n"
        f"Reviewer's additional context:\n{body.context}"
    )
    result = await adapter.generate(
        GenerationRequest(
            task="structuring",
            system=REGENERATE_V1,
            messages=[Message(role="user", content=user)],
            schema_=REGENERATE_SCHEMA,
            workspace_id=body.workspace_id,
            project_id=item.projectId,
            prompt_version=GENERATION_PROMPT_VERSION,
        )
    )

    now = _now()
    new_item = DraftItem(
        projectId=item.projectId,
        type=item.type,
        title=str(result.data.get("title", item.title)),
        description=str(result.data.get("description", item.description)),
        payload=cast(dict[str, object] | None, result.data.get("extra")) or item.payload,
        parentId=item.parentId,
        status=DraftItemStatus.PENDING,
        promptVersion=GENERATION_PROMPT_VERSION,
        generationRunId=item.generationRunId,
        flags=item.flags,
        originalDraft={
            "title": str(result.data.get("title", item.title)),
            "description": str(result.data.get("description", item.description)),
            "payload": result.data.get("extra"),
        },
        revisionOfId=item.id,
        createdAt=now,
        updatedAt=now,
    )
    session.add(new_item)
    await session.flush()

    # Original traceability carries over (Issue 3.9 AC) — the reviewer's context may
    # add knowledge, but the source citations remain those of the original fragments.
    for trace, _ in trace_rows:
        session.add(
            TraceLink(
                sourceId=trace.sourceId,
                rawRequirementId=trace.rawRequirementId,
                draftItemId=new_item.id,
                createdAt=now,
                updatedAt=now,
            )
        )

    # Previous revision leaves the active queue but is preserved (revision history).
    item.deletedAt = now
    item.updatedAt = now
    record_audit_event(
        session,
        workspace_id=body.workspace_id,
        project_id=item.projectId,
        action="draft_item.regenerated",
        entity_type="DraftItem",
        entity_id=new_item.id,
        actor_type=AuditActorType.AI,
        before={"item_id": item.id, "title": item.title, "description": item.description},
        after={"title": new_item.title, "description": new_item.description},
        metadata={"reviewer_context": body.context},
    )
    await session.commit()
    return RegenerateResponse(new_item_id=new_item.id, previous_item_id=item.id)


class TargetedRegenerateBody(BaseModel):
    workspace_id: str


class TargetedRegenerateResponse(BaseModel):
    revised_item_ids: list[str]
    new_item_ids: list[str]
    flagged_removed_item_ids: list[str]
    untouched_fragment_count: int


@router.post("/sources/{source_id}/targeted-regenerate")
async def targeted_regenerate(
    source_id: str,
    body: TargetedRegenerateBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    adapter: Annotated[AIAdapter, Depends(get_generation_adapter)],
) -> TargetedRegenerateResponse:
    """Issue 9.2: regenerate only the DraftItems affected by this source version's
    diff (Issue 9.1), leaving everything else in the project untouched."""
    source = await session.get(Source, source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found.")
    try:
        result: TargetedRegenerationResult = await run_targeted_regeneration(
            source.projectId, body.workspace_id, source_id, session, adapter
        )
    except TargetedRegenerationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return TargetedRegenerateResponse(
        revised_item_ids=result.revised_item_ids,
        new_item_ids=result.new_item_ids,
        flagged_removed_item_ids=result.flagged_removed_item_ids,
        untouched_fragment_count=result.untouched_fragment_count,
    )


@router.get("/projects/{project_id}/generation-summary")
async def generation_summary(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, object]:
    """Latest run's stats plus live item counts (Issue 3.10) — recomputed so the
    numbers stay correct after regenerations/reviews change individual items."""
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    run = (
        await session.execute(
            select(GenerationRun)
            .where(GenerationRun.projectId == project_id)
            .order_by(GenerationRun.createdAt.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    items = list(
        (
            await session.execute(
                select(DraftItem).where(
                    DraftItem.projectId == project_id, DraftItem.deletedAt.is_(None)
                )
            )
        ).scalars()
    )
    by_type: dict[str, int] = {}
    for item in items:
        by_type[item.type.value] = by_type.get(item.type.value, 0) + 1
    scores = [i.qualityScore for i in items if i.qualityScore is not None]
    flags = [i.flags for i in items if i.flags]

    total_fragments = (
        await session.execute(
            select(func.count(func.distinct(RawRequirement.id)))
            .select_from(RawRequirement)
            .join(TraceLink, TraceLink.rawRequirementId == RawRequirement.id, isouter=True)
            .join(DraftItem, DraftItem.id == TraceLink.draftItemId, isouter=True)
        )
    ).scalar_one()

    cited = (
        await session.execute(
            select(func.count(func.distinct(TraceLink.rawRequirementId)))
            .join(DraftItem, DraftItem.id == TraceLink.draftItemId)
            .where(DraftItem.projectId == project_id, DraftItem.deletedAt.is_(None))
        )
    ).scalar_one()

    return {
        "run_id": run.id if run else None,
        "run_created_at": run.createdAt.isoformat() if run else None,
        "run_stats": run.stats if run else None,
        "live": {
            "items_by_type": by_type,
            "item_count": len(items),
            "average_score": round(sum(scores) / len(scores), 1) if scores else None,
            "duplicates_flagged": sum(1 for f in flags if "duplicate" in f),
            "gaps_flagged": sum(1 for f in flags if "gap" in f),
            "untraced_items": sum(1 for f in flags if f.get("noTrace")),
            "cited_fragments": cited,
            "total_fragments": total_fragments,
        },
    }
