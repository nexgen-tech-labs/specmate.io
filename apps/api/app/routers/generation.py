"""Generation endpoints (Epic 3): run the pipeline, regenerate one item with
reviewer context (Issue 3.9), and query run stats (Issue 3.10).

Generation-triggering endpoints (generate/generate-downstream/regenerate/
targeted-regenerate) enqueue a Job and return 202 immediately rather than
blocking on the underlying AI call — a large enough input's Anthropic call
can legitimately take longer than any reasonable client-side timeout or
Azure Container Apps' hard ingress timeout, which is exactly what caused a
real production 504 (see Job's model docstring for the full story). The
frontend polls GET /jobs/{job_id} (app/routers/jobs.py) until DONE/FAILED."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, cast

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_db_session
from app.models import (
    AuditActorType,
    DraftItem,
    DraftItemStatus,
    GenerationRun,
    GenerationRunStage,
    JobType,
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
from app.services.ai.scheduler import AIScheduler
from app.services.ai.scheduling_adapter import SchedulingAdapter
from app.services.generation.pipeline import generate_downstream, generate_epics
from app.services.generation.schemas import REGENERATE_SCHEMA
from app.services.generation.targeted import run_targeted_regeneration
from app.services.jobs import (
    AI_UNAVAILABLE_DETAIL,  # noqa: F401 — re-exported; existing tests still import it from here
    enqueue_job,
    run_job,
)

router = APIRouter()

_ai_scheduler = AIScheduler(max_concurrent=settings.max_concurrent_ai_calls)


def get_generation_adapter(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> AIAdapter:
    """FastAPI dependency — overridden in tests to inject a fake adapter.
    Still declared as a normal dependency (even though no endpoint in this
    file depends-injects it directly anymore, now that generation runs in a
    background task) purely so existing tests' `app.dependency_overrides
    [get_generation_adapter] = lambda: FakeAdapter()` keeps working — see
    _adapter_for_background_task below, which is what background jobs
    actually call."""
    return SchedulingAdapter(LoggingAdapter(ClaudeAdapter(), session), _ai_scheduler)


def _adapter_for_background_task(session: AsyncSession) -> AIAdapter:
    """What every background job actually calls to get an adapter. Checks
    for a test override on get_generation_adapter first (FastAPI's
    dependency_overrides is just a plain dict, readable outside an actual
    request) so existing tests overriding get_generation_adapter continue
    to inject their FakeAdapter into background-task execution without
    modification, even though the endpoint itself no longer depends-injects
    it. Falls back to the real Claude-backed adapter when no override is
    registered (production, and any test that doesn't override it)."""
    from app.main import app as _app

    override = _app.dependency_overrides.get(get_generation_adapter)
    if override is not None:
        return cast(AIAdapter, override())
    return SchedulingAdapter(LoggingAdapter(ClaudeAdapter(), session), _ai_scheduler)


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _stats_with_queue_metrics(run: GenerationRun) -> dict[str, object] | None:
    """Folds the queueing-observability columns (Issue #115) into the stats
    dict returned to callers — kept off the persisted `stats` JSONB itself
    since that column is fully overwritten by each generation phase, while
    these two columns accumulate across both."""
    if run.stats is None:
        return None
    return {
        **run.stats,
        "queue_wait_seconds_total": run.queueWaitSecondsTotal,
        "queue_depth_at_submit_max": run.queueDepthAtSubmitMax,
    }


class GenerateBody(BaseModel):
    pass


class EnqueuedJobResponse(BaseModel):
    job_id: str


async def _run_generate_epics_job(job_id: str, project_id: str) -> None:
    async def _work(session: AsyncSession) -> str:
        adapter = _adapter_for_background_task(session)
        run = await generate_epics(project_id, session, adapter)
        return run.id

    await run_job(job_id, _work)


@router.post("/projects/{project_id}/generate", status_code=202)
async def generate(
    project_id: str,
    body: GenerateBody,
    background_tasks: BackgroundTasks,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> EnqueuedJobResponse:
    """Passes 1-2 only (cluster + epics) — see generate_downstream for the
    second explicit call that generates stories/tasks/supporting items for
    whichever epics the reviewer approves.

    Enqueues a Job and returns 202 immediately — generate_epics's own AI
    calls (clustering + epics, +summarization for large inputs) run in a
    background task rather than blocking this request, since a large enough
    input can legitimately take longer than any client-side timeout or
    Azure Container Apps' hard ingress timeout allows (the exact cause of a
    real production 504). Poll GET /jobs/{job_id} for the result — DONE's
    result_ref is the GenerationRun id; fetch it via
    GET /projects/{project_id}/generation-summary or the review endpoints as
    today. Only cheap, synchronous validation happens here (project exists)
    — generate_epics' own richer validation (fragments exist, idempotency)
    still runs, just inside the job, surfacing as a FAILED job with that
    message rather than an immediate 4xx. This trades an immediate error
    response for a uniform "poll for the outcome" contract; the frontend
    already needs to poll for the success path, so a failed validation is
    just another poll result rather than a special case."""
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    job = await enqueue_job(
        session,
        type=JobType.GENERATE_EPICS,
        workspace_id=project.workspaceId,
        project_id=project_id,
    )
    background_tasks.add_task(_run_generate_epics_job, job.id, project_id)
    return EnqueuedJobResponse(job_id=job.id)


class GenerateDownstreamBody(BaseModel):
    # Optional restriction of supporting item types (Issue 3.1: configurable per project).
    item_types: list[str] | None = None


async def _run_generate_downstream_job(
    job_id: str, run_id: str, item_types: set[str] | None
) -> None:
    async def _work(session: AsyncSession) -> str:
        adapter = _adapter_for_background_task(session)
        run = await generate_downstream(run_id, session, adapter, item_types=item_types)
        return run.id

    await run_job(job_id, _work)


@router.post("/generation-runs/{run_id}/generate-downstream", status_code=202)
async def generate_downstream_endpoint(
    run_id: str,
    body: GenerateDownstreamBody,
    background_tasks: BackgroundTasks,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> EnqueuedJobResponse:
    """Passes 3-5, scoped to whichever epics from `run_id` the reviewer has
    approved. Call this once at least one epic is APPROVED (via the normal
    draft-item review/decision workflow). Enqueues a Job and returns 202 —
    see /projects/{project_id}/generate's docstring for why."""
    run = await session.get(GenerationRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Generation run not found.")
    if run.stage != GenerationRunStage.EPICS_PENDING_REVIEW:
        raise HTTPException(
            status_code=409, detail="This run has already completed downstream generation."
        )
    project = await session.get(Project, run.projectId)
    assert project is not None

    job = await enqueue_job(
        session,
        type=JobType.GENERATE_DOWNSTREAM,
        workspace_id=project.workspaceId,
        project_id=run.projectId,
        input={"item_types": body.item_types} if body.item_types else None,
    )
    item_types = set(body.item_types) if body.item_types else None
    background_tasks.add_task(_run_generate_downstream_job, job.id, run_id, item_types)
    return EnqueuedJobResponse(job_id=job.id)


class UpdateGenerationRunBody(BaseModel):
    tag: str | None = None
    name: str | None = None


class UpdateGenerationRunResponse(BaseModel):
    id: str
    tag: str | None
    name: str | None
    stage: str


@router.patch("/generation-runs/{run_id}")
async def update_generation_run(
    run_id: str,
    body: UpdateGenerationRunBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> UpdateGenerationRunResponse:
    """Lets a reviewer rename the AI-suggested tag/name for a run — display
    labels only, no uniqueness constraint or effect on idempotency."""
    run = await session.get(GenerationRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Generation run not found.")

    if body.tag is not None:
        trimmed_tag = body.tag.strip()
        if not trimmed_tag:
            raise HTTPException(status_code=422, detail="tag cannot be empty.")
        run.tag = trimmed_tag
    if body.name is not None:
        trimmed_name = body.name.strip()
        if not trimmed_name:
            raise HTTPException(status_code=422, detail="name cannot be empty.")
        run.name = trimmed_name
    run.updatedAt = _now()

    await session.commit()
    return UpdateGenerationRunResponse(id=run.id, tag=run.tag, name=run.name, stage=run.stage.value)


class RegenerateBody(BaseModel):
    context: str
    workspace_id: str


async def _regenerate_item_work(
    session: AsyncSession, item_id: str, context: str, workspace_id: str
) -> str:
    """The actual regenerate work (AI call + persistence) — runs inside the
    background job. Callers (the job wrapper) treat any raised exception as
    a job failure; the item-not-found/already-approved checks happen
    synchronously in the endpoint instead, before the job is even enqueued,
    since those are immediate 4xx/409s, not job failures."""
    adapter = _adapter_for_background_task(session)
    item = await session.get(DraftItem, item_id)
    assert item is not None  # re-checked here defensively; already validated by the endpoint

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
        f"Reviewer's additional context:\n{context}"
    )
    result = await adapter.generate(
        GenerationRequest(
            task="structuring",
            system=REGENERATE_V1,
            messages=[Message(role="user", content=user)],
            schema_=REGENERATE_SCHEMA,
            workspace_id=workspace_id,
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
        workspace_id=workspace_id,
        project_id=item.projectId,
        action="draft_item.regenerated",
        entity_type="DraftItem",
        entity_id=new_item.id,
        actor_type=AuditActorType.AI,
        before={"item_id": item.id, "title": item.title, "description": item.description},
        after={"title": new_item.title, "description": new_item.description},
        metadata={"reviewer_context": context},
    )
    await session.commit()
    return new_item.id


async def _run_regenerate_item_job(job_id: str, item_id: str, context: str, workspace_id: str) -> None:
    async def _work(session: AsyncSession) -> str:
        return await _regenerate_item_work(session, item_id, context, workspace_id)

    await run_job(job_id, _work)


@router.post("/draft-items/{item_id}/regenerate", status_code=202)
async def regenerate_item(
    item_id: str,
    body: RegenerateBody,
    background_tasks: BackgroundTasks,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> EnqueuedJobResponse:
    """Enqueues a Job and returns 202 — see /projects/{project_id}/generate's
    docstring for why. DONE's result_ref is the new DraftItem's id; the
    previous item's id is item_id itself (unchanged, just soft-deleted)."""
    item = await session.get(DraftItem, item_id)
    if item is None or item.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Draft item not found.")
    if item.status == DraftItemStatus.APPROVED:
        raise HTTPException(
            status_code=409, detail="Approved items are locked — reopen before regenerating."
        )

    job = await enqueue_job(
        session,
        type=JobType.REGENERATE_ITEM,
        workspace_id=body.workspace_id,
        project_id=item.projectId,
        input={"context": body.context},
    )
    background_tasks.add_task(
        _run_regenerate_item_job, job.id, item_id, body.context, body.workspace_id
    )
    return EnqueuedJobResponse(job_id=job.id)


class TargetedRegenerateBody(BaseModel):
    workspace_id: str


class TargetedRegenerateResponse(BaseModel):
    revised_item_ids: list[str]
    new_item_ids: list[str]
    flagged_removed_item_ids: list[str]
    untouched_fragment_count: int


async def _run_targeted_regenerate_job(
    job_id: str, project_id: str, workspace_id: str, source_id: str
) -> None:
    async def _work(session: AsyncSession) -> str:
        adapter = _adapter_for_background_task(session)
        result = await run_targeted_regeneration(project_id, workspace_id, source_id, session, adapter)
        # TargetedRegenerateResponse's shape has no single "the result" id
        # (unlike a GenerationRun or DraftItem) — resultRef holds the whole
        # structured outcome as JSON rather than a bare reference id.
        return TargetedRegenerateResponse(
            revised_item_ids=result.revised_item_ids,
            new_item_ids=result.new_item_ids,
            flagged_removed_item_ids=result.flagged_removed_item_ids,
            untouched_fragment_count=result.untouched_fragment_count,
        ).model_dump_json()

    await run_job(job_id, _work)


@router.post("/sources/{source_id}/targeted-regenerate", status_code=202)
async def targeted_regenerate(
    source_id: str,
    body: TargetedRegenerateBody,
    background_tasks: BackgroundTasks,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> EnqueuedJobResponse:
    """Issue 9.2: regenerate only the DraftItems affected by this source
    version's diff (Issue 9.1), leaving everything else in the project
    untouched. Enqueues a Job and returns 202 — see
    /projects/{project_id}/generate's docstring for why. DONE's result_ref
    is a JSON-encoded TargetedRegenerateResponse (this endpoint's result has
    no single natural id to reference, unlike the other generation jobs)."""
    source = await session.get(Source, source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found.")

    job = await enqueue_job(
        session,
        type=JobType.TARGETED_REGENERATE,
        workspace_id=body.workspace_id,
        project_id=source.projectId,
    )
    background_tasks.add_task(
        _run_targeted_regenerate_job, job.id, source.projectId, body.workspace_id, source_id
    )
    return EnqueuedJobResponse(job_id=job.id)


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
