"""The Epic 3 generation pipeline (Issue 3.1): RawRequirements -> DraftItems.

Staged in two explicit phases (Onboarding Flow redesign follow-up — generating
15-20 items in one shot with no checkpoint made a small pasted requirement
produce more than a reviewer could sensibly triage at once):

  generate_epics()      — passes 1-2: cluster fragments by theme, then draft
                           epics from those clusters. Persists a GenerationRun
                           (stage=EPICS_PENDING_REVIEW) and only EPIC DraftItems,
                           for human approval via the existing review workflow.
  generate_downstream()  — passes 3-5, scoped to APPROVED epics only: stories +
                           tasks under each approved epic (hierarchy inferred
                           here — Issue 3.7; orphans get no parent rather than a
                           forced wrong one), supporting items (AC/tests/risks/
                           NFRs/dependencies/assumptions/questions — Issues
                           3.2/3.8, only where traceable to source), then
                           scoring + gap questions (Issues 3.4/3.6). Sets
                           stage=COMPLETE.

Every persisted item carries: promptVersion, TraceLinks to its cited fragments
(Issue 3.3 — uncited items get flags.noTrace instead of silent acceptance), an
immutable originalDraft snapshot (Issue 4.3's baseline), score detail, and duplicate
flags from the reference backlog comparison (Issue 3.5) — computed separately for
epics (in generate_epics, so a duplicate epic is flagged before review time is
spent on it) and for stories/tasks/supporting items (in generate_downstream).

Idempotency: a GenerationRun row is keyed on (projectId, sha256 of ordered fragment
texts). Re-running generate_epics against unchanged content returns the existing
run untouched, regardless of which stage it's in."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import (
    DraftItem,
    DraftItemStatus,
    DraftItemType,
    GenerationRun,
    GenerationRunStage,
    Project,
    RawRequirement,
    ReferenceItem,
    Source,
    TraceLink,
    Workspace,
)
from app.models import AuditActorType
from app.services.ai.adapter import AIAdapter, GenerationRequest, Message
from app.services.audit import record_audit_event
from app.services.ai.prompts.generation_v1 import (
    CLUSTERING_V1,
    EPICS_V1,
    GENERATION_PROMPT_VERSION,
    SCORING_V1,
    STORIES_V1,
    SUMMARIZE_FRAGMENTS_V1,
    SUPPORTING_V1,
)
from app.services.generation.chunking import (
    digest_block,
    group_fragments_for_summarization,
    needs_summarization,
)
from app.services.generation.schemas import (
    CLUSTER_SCHEMA,
    EPICS_SCHEMA,
    SCORING_SCHEMA,
    STORIES_SCHEMA,
    SUMMARIZE_SCHEMA,
    SUPPORTING_SCHEMA,
)
from app.services.generation.similarity import find_best_duplicate

_DEFAULT_DUPLICATE_THRESHOLD = 0.55
_GAP_SCORE_TRIGGER = 60  # completeness/specificity below this + a gap_question => gap flag


class GenerationError(Exception):
    """Raised when the pipeline can't run — no fragments, missing project,
    wrong-stage run, no approved epics, etc."""


@dataclass
class _Draft:
    """In-memory item before persistence."""

    type: DraftItemType
    title: str
    description: str
    payload: dict[str, object] | None
    chunk_ids: list[str]
    parent_index: int | None = None  # index into the epics list (for stories)
    parent_story_index: int | None = None  # index into the stories list (for supporting/tasks)
    score: dict[str, object] | None = None
    flags: dict[str, object] = field(default_factory=dict)


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _content_hash(fragments: list[RawRequirement]) -> str:
    joined = "\n".join(f"{f.sectionPath}:{f.text}" for f in fragments)
    return hashlib.sha256(joined.encode()).hexdigest()


def _fragments_block(fragments: list[RawRequirement]) -> str:
    return "\n".join(f"[{f.id}] ({f.sectionPath}) {f.text}" for f in fragments)


async def _call(
    adapter: AIAdapter,
    task: str,
    system: str,
    user: str,
    schema: dict[str, object],
    workspace_id: str,
    project_id: str,
) -> dict[str, object]:
    result = await adapter.generate(
        GenerationRequest(
            task=task,
            system=system,
            messages=[Message(role="user", content=user)],
            schema_=schema,
            workspace_id=workspace_id,
            project_id=project_id,
            prompt_version=GENERATION_PROMPT_VERSION,
        )
    )
    return result.data


async def _fetch_fragments(project_id: str, session: AsyncSession) -> list[RawRequirement]:
    result = await session.execute(
        select(RawRequirement)
        .join(Source, Source.id == RawRequirement.sourceId)
        .where(
            Source.projectId == project_id,
            Source.deletedAt.is_(None),
            RawRequirement.deletedAt.is_(None),
        )
        .order_by(RawRequirement.sourceId, RawRequirement.order)
    )
    return list(result.scalars())


def _row(
    project_id: str,
    run_id: str,
    draft: _Draft,
    parent_id: str | None,
    now: datetime,
) -> DraftItem:
    overall = None
    if draft.score:
        subs = [
            int(cast(int, draft.score[k]))
            for k in ("completeness", "clarity", "testability", "specificity")
            if draft.score.get(k) is not None
        ]
        overall = round(sum(subs) / len(subs)) if subs else None
    if not draft.chunk_ids:
        draft.flags["noTrace"] = True  # anomaly, never silently accepted (Issue 3.3)
    return DraftItem(
        projectId=project_id,
        type=draft.type,
        title=draft.title,
        description=draft.description,
        payload=draft.payload,
        qualityScore=overall,
        parentId=parent_id,
        status=DraftItemStatus.PENDING,
        promptVersion=GENERATION_PROMPT_VERSION,
        generationRunId=run_id,
        scoreDetail=draft.score,
        flags=draft.flags or None,
        originalDraft={
            "title": draft.title,
            "description": draft.description,
            "payload": draft.payload,
        },
        createdAt=now,
        updatedAt=now,
    )


def _persist_items(
    session: AsyncSession,
    project_id: str,
    run_id: str,
    drafts: list[_Draft],
    parent_resolution_fn: Callable[[_Draft], str | None],
    now: datetime,
) -> list[DraftItem]:
    """Builds + adds DraftItem rows for `drafts`, resolving each one's parent via
    `parent_resolution_fn`. Caller is responsible for flushing (so parent lookups
    resolve to real ids before the NEXT batch that references them)."""
    rows = [_row(project_id, run_id, d, parent_resolution_fn(d), now) for d in drafts]
    session.add_all(rows)
    return rows


def _create_trace_links(
    session: AsyncSession,
    drafts: list[_Draft],
    rows: list[DraftItem],
    fragment_source: dict[str, str],
    now: datetime,
) -> None:
    for draft, row in zip(drafts, rows, strict=True):
        for chunk_id in draft.chunk_ids:
            session.add(
                TraceLink(
                    sourceId=fragment_source[chunk_id],
                    rawRequirementId=chunk_id,
                    draftItemId=row.id,
                    createdAt=now,
                    updatedAt=now,
                )
            )


async def _apply_duplicate_flags(
    session: AsyncSession,
    project_id: str,
    workspace: Workspace,
    drafts: list[_Draft],
) -> None:
    """Duplicate detection against the reference backlog (Issue 3.5) — never
    cross-DraftItem, only against the project's synced ReferenceItem snapshot."""
    if not drafts:
        return
    references_result = await session.execute(
        select(ReferenceItem).where(ReferenceItem.projectId == project_id)
    )
    references = [
        (r.externalKey, r.tool.value, f"{r.title}\n{r.description}")
        for r in references_result.scalars()
    ]
    if not references:
        return
    threshold = (
        workspace.duplicateThreshold
        if workspace.duplicateThreshold is not None
        else settings.duplicate_similarity_threshold or _DEFAULT_DUPLICATE_THRESHOLD
    )
    for draft in drafts:
        match = find_best_duplicate(f"{draft.title}\n{draft.description}", references, threshold)
        if match:
            draft.flags["duplicate"] = {
                "key": match.external_key,
                "tool": match.tool,
                "confidence": match.confidence,
            }


async def _maybe_summarize(
    fragments: list[RawRequirement],
    block: str,
    adapter: AIAdapter,
    workspace_id: str,
    project_id: str,
) -> str | None:
    """If `block` exceeds the character budget, batches fragments and
    summarizes each batch into a dense digest that still cites real fragment
    ids — returns the replacement block, or None if summarization wasn't
    needed (caller should fall back to the raw block in that case)."""
    if not needs_summarization(block):
        return None

    fragment_ids = {f.id for f in fragments}
    all_digests: list[dict[str, object]] = []
    for batch in group_fragments_for_summarization(fragments):
        batch_block = _fragments_block(batch)
        result = await _call(
            adapter,
            "summarization",
            SUMMARIZE_FRAGMENTS_V1,
            f"Fragments:\n{batch_block}",
            SUMMARIZE_SCHEMA,
            workspace_id,
            project_id,
        )
        for d in cast(list[dict[str, object]], result.get("digests", [])):
            raw_ids = cast(list[str], d.get("source_chunk_ids", []))
            filtered_ids = [c for c in raw_ids if c in fragment_ids]
            if not filtered_ids:
                continue  # anomaly: digest cites nothing real — drop it, never inject untraceable prose
            all_digests.append({"text": d.get("text", ""), "source_chunk_ids": filtered_ids})

    return digest_block(all_digests)


async def generate_epics(
    project_id: str,
    session: AsyncSession,
    adapter: AIAdapter,
) -> GenerationRun:
    """Passes 1-2 only: cluster fragments, then draft epics from those clusters.
    Persists a GenerationRun (stage=EPICS_PENDING_REVIEW) and only EPIC
    DraftItems — stories/tasks/supporting items are generated separately, once
    a human has approved which epics to proceed with (generate_downstream).

    Idempotent exactly as the old single-shot pipeline was: unchanged content
    (by sha256 of ordered fragment texts) returns the existing run untouched,
    regardless of whether it's still pending review or already complete."""
    project = await session.get(Project, project_id)
    if project is None:
        raise GenerationError("Project not found.")
    workspace = await session.get(Workspace, project.workspaceId)
    assert workspace is not None

    fragments = await _fetch_fragments(project_id, session)
    if not fragments:
        raise GenerationError("Project has no ingested requirements to generate from.")

    content_hash = _content_hash(fragments)
    existing_run = (
        await session.execute(
            select(GenerationRun).where(
                GenerationRun.projectId == project_id,
                GenerationRun.contentHash == content_hash,
            )
        )
    ).scalar_one_or_none()
    if existing_run is not None:
        return existing_run  # idempotent: unchanged content, nothing regenerated

    fragment_ids = {f.id for f in fragments}
    fragment_source = {f.id: f.sourceId for f in fragments}
    raw_block = _fragments_block(fragments)
    ws_id = project.workspaceId

    # Chunking/summarization pre-pass (only for genuinely large sources — see
    # chunking.py's character budget) — summarize once here, cache the digest
    # on the run, and generate_downstream reuses it instead of re-summarizing.
    summarized_block = await _maybe_summarize(fragments, raw_block, adapter, ws_id, project_id)
    block = summarized_block or raw_block

    # Pass 1: cluster
    cluster_data = await _call(
        adapter, "clustering", CLUSTERING_V1, f"Fragments:\n{block}", CLUSTER_SCHEMA, ws_id, project_id
    )
    clusters = cast(list[dict[str, object]], cluster_data.get("clusters", []))

    # Pass 2: epics
    clusters_text = json.dumps(clusters, ensure_ascii=False)
    epics_data = await _call(
        adapter,
        "structuring",
        EPICS_V1,
        f"Clusters:\n{clusters_text}\n\nFragments:\n{block}",
        EPICS_SCHEMA,
        ws_id,
        project_id,
    )
    epics_raw = cast(list[dict[str, object]], epics_data.get("epics", []))
    epics = [
        _Draft(
            type=DraftItemType.EPIC,
            title=str(e.get("title", "")),
            description=str(e.get("description", "")),
            payload={"business_value": e.get("business_value", "")},
            chunk_ids=[c for c in cast(list[str], e.get("source_chunk_ids", [])) if c in fragment_ids],
        )
        for e in epics_raw
    ]

    # Duplicate detection for epics happens now, not deferred to generate_downstream —
    # a duplicate epic should be flagged before the reviewer spends time on it.
    await _apply_duplicate_flags(session, project_id, workspace, epics)

    run = GenerationRun(
        projectId=project_id,
        contentHash=content_hash,
        promptVersion=GENERATION_PROMPT_VERSION,
        stage=GenerationRunStage.EPICS_PENDING_REVIEW,
        summarizedFragmentsBlock=summarized_block,
    )
    session.add(run)
    await session.flush()

    now = _now()
    epic_rows = _persist_items(session, project_id, run.id, epics, lambda _d: None, now)
    await session.flush()
    _create_trace_links(session, epics, epic_rows, fragment_source, now)

    by_type: dict[str, int] = {"EPIC": len(epic_rows)}
    scores = [r.qualityScore for r in epic_rows if r.qualityScore is not None]
    run.stats = {
        "items_by_type": by_type,
        "item_count": len(epic_rows),
        "average_score": round(sum(scores) / len(scores), 1) if scores else None,
        "duplicates_flagged": sum(1 for d in epics if "duplicate" in d.flags),
        "gaps_flagged": 0,  # scoring hasn't run yet — that's pass 5, in generate_downstream
        "untraced_items": sum(1 for d in epics if d.flags.get("noTrace")),
        "source_coverage": None,  # unknown until downstream passes cite the remaining fragments
        "fragment_count": len(fragments),
    }
    record_audit_event(
        session,
        workspace_id=project.workspaceId,
        project_id=project_id,
        action="generation.epics_completed",
        entity_type="GenerationRun",
        entity_id=run.id,
        actor_type=AuditActorType.AI,
        after=dict(run.stats),
    )
    await session.commit()
    return run


async def generate_downstream(
    run_id: str,
    session: AsyncSession,
    adapter: AIAdapter,
    item_types: set[str] | None = None,
) -> GenerationRun:
    """Passes 3-5 for a run currently in EPICS_PENDING_REVIEW: stories+tasks,
    supporting items, then scoring — scoped to only the run's APPROVED epic
    DraftItems (read fresh from the DB, since this may run in a separate
    request from generate_epics, after human review). Sets stage=COMPLETE.

    item_types optionally restricts which supporting types are generated
    (stories/tasks are always produced)."""
    run = await session.get(GenerationRun, run_id)
    if run is None:
        raise GenerationError("Generation run not found.")
    if run.stage != GenerationRunStage.EPICS_PENDING_REVIEW:
        raise GenerationError("This run has already completed downstream generation.")

    project = await session.get(Project, run.projectId)
    if project is None:
        raise GenerationError("Project not found.")
    workspace = await session.get(Workspace, project.workspaceId)
    assert workspace is not None
    project_id = run.projectId
    ws_id = project.workspaceId

    epic_rows = list(
        (
            await session.execute(
                select(DraftItem)
                .where(
                    DraftItem.generationRunId == run_id,
                    DraftItem.type == DraftItemType.EPIC,
                    DraftItem.status == DraftItemStatus.APPROVED,
                    DraftItem.deletedAt.is_(None),
                )
                .order_by(DraftItem.createdAt)
            )
        ).scalars()
    )
    if not epic_rows:
        raise GenerationError("No approved epics to generate from — approve at least one epic first.")

    fragments = await _fetch_fragments(project_id, session)
    fragment_ids = {f.id for f in fragments}
    fragment_source = {f.id: f.sourceId for f in fragments}
    # Reuse the digest generate_epics already computed and cached (if
    # summarization was triggered) rather than re-summarizing — avoids extra
    # cost/latency and any risk of the two phases seeing different summaries
    # of the same source.
    block = run.summarizedFragmentsBlock or _fragments_block(fragments)

    # Pass 3: stories + tasks, scoped to approved epics only.
    epics_text = "\n".join(f"[{i}] {e.title}" for i, e in enumerate(epic_rows))
    stories_data = await _call(
        adapter,
        "structuring",
        STORIES_V1,
        f"Epics:\n{epics_text}\n\nFragments:\n{block}",
        STORIES_SCHEMA,
        ws_id,
        project_id,
    )
    stories: list[_Draft] = []
    tasks: list[_Draft] = []
    for s in cast(list[dict[str, object]], stories_data.get("stories", [])):
        epic_index = int(cast(int, s.get("epic_index", -1)))
        story = _Draft(
            type=DraftItemType.STORY,
            title=str(s.get("title", "")),
            description=str(s.get("description", "")),
            payload=None,
            chunk_ids=[c for c in cast(list[str], s.get("source_chunk_ids", [])) if c in fragment_ids],
            parent_index=epic_index if 0 <= epic_index < len(epic_rows) else None,
        )
        stories.append(story)
        story_idx = len(stories) - 1
        for t in cast(list[dict[str, object]], s.get("tasks", [])):
            tasks.append(
                _Draft(
                    type=DraftItemType.TASK,
                    title=str(t.get("title", "")),
                    description=str(t.get("description", "")),
                    payload=None,
                    chunk_ids=story.chunk_ids,
                    parent_story_index=story_idx,
                )
            )

    # Pass 4: supporting items
    stories_text = "\n".join(f"[{i}] {s.title}" for i, s in enumerate(stories))
    supporting_data = await _call(
        adapter,
        "structuring",
        SUPPORTING_V1,
        f"Stories:\n{stories_text}\n\nFragments:\n{block}",
        SUPPORTING_SCHEMA,
        ws_id,
        project_id,
    )
    supporting: list[_Draft] = []
    wanted = item_types  # None => all
    for item in cast(list[dict[str, object]], supporting_data.get("items", [])):
        type_name = str(item.get("type", ""))
        if type_name not in DraftItemType.__members__:
            continue
        if wanted is not None and type_name not in wanted:
            continue
        story_index = int(cast(int, item.get("story_index", -1)))
        supporting.append(
            _Draft(
                type=DraftItemType[type_name],
                title=str(item.get("title", "")),
                description=str(item.get("description", "")),
                payload=cast(dict[str, object] | None, item.get("extra")) or None,
                chunk_ids=[
                    c for c in cast(list[str], item.get("source_chunk_ids", [])) if c in fragment_ids
                ],
                parent_story_index=story_index if 0 <= story_index < len(stories) else None,
            )
        )

    downstream_drafts: list[_Draft] = [*stories, *tasks, *supporting]

    # Pass 5: scoring + gap questions
    items_text = "\n".join(
        f"[{i}] ({d.type.value}) {d.title} — {d.description}"
        for i, d in enumerate(downstream_drafts)
    )
    scoring_data = await _call(
        adapter, "scoring", SCORING_V1, f"Items:\n{items_text}", SCORING_SCHEMA, ws_id, project_id
    )
    for score in cast(list[dict[str, object]], scoring_data.get("scores", [])):
        idx = int(cast(int, score.get("item_index", -1)))
        if not 0 <= idx < len(downstream_drafts):
            continue
        draft = downstream_drafts[idx]
        draft.score = {
            "completeness": score.get("completeness"),
            "clarity": score.get("clarity"),
            "testability": score.get("testability"),
            "specificity": score.get("specificity"),
            "rationale": score.get("rationale"),
        }
        gap_question = score.get("gap_question")
        low = min(
            int(cast(int, score.get("completeness", 100))),
            int(cast(int, score.get("specificity", 100))),
        )
        if gap_question and low < _GAP_SCORE_TRIGGER:
            draft.flags["gap"] = {"question": str(gap_question)}

    await _apply_duplicate_flags(session, project_id, workspace, downstream_drafts)

    now = _now()
    story_rows = _persist_items(
        session,
        project_id,
        run_id,
        stories,
        lambda d: epic_rows[d.parent_index].id if d.parent_index is not None else None,
        now,
    )
    await session.flush()

    def _story_parent(draft: _Draft) -> str | None:
        if draft.parent_story_index is not None:
            return story_rows[draft.parent_story_index].id
        return None

    other_rows = _persist_items(session, project_id, run_id, [*tasks, *supporting], _story_parent, now)
    await session.flush()

    downstream_rows = [*story_rows, *other_rows]
    _create_trace_links(session, downstream_drafts, downstream_rows, fragment_source, now)

    # Final stats — recomputed across every item belonging to this run (epics
    # persisted earlier by generate_epics, plus everything just persisted here),
    # not just this call's in-memory drafts, since the epic pass ran separately.
    all_run_items = list(
        (
            await session.execute(
                select(DraftItem).where(
                    DraftItem.generationRunId == run_id, DraftItem.deletedAt.is_(None)
                )
            )
        ).scalars()
    )
    cited_ids = {c for d in downstream_drafts for c in d.chunk_ids} | {
        tl.rawRequirementId
        for tl in (
            await session.execute(
                select(TraceLink).where(TraceLink.draftItemId.in_([r.id for r in epic_rows]))
            )
        ).scalars()
    }
    by_type: dict[str, int] = {}
    for run_item in all_run_items:
        by_type[run_item.type.value] = by_type.get(run_item.type.value, 0) + 1
    scores_all = [r.qualityScore for r in all_run_items if r.qualityScore is not None]
    flags_all = [run_item.flags or {} for run_item in all_run_items]
    run.stats = {
        "items_by_type": by_type,
        "item_count": len(all_run_items),
        "average_score": round(sum(scores_all) / len(scores_all), 1) if scores_all else None,
        "duplicates_flagged": sum(1 for f in flags_all if "duplicate" in f),
        "gaps_flagged": sum(1 for f in flags_all if "gap" in f),
        "untraced_items": sum(1 for f in flags_all if f.get("noTrace")),
        "source_coverage": round(len(cited_ids) / len(fragments), 3) if fragments else 0,
        "fragment_count": len(fragments),
    }
    run.stage = GenerationRunStage.COMPLETE
    run.updatedAt = now

    if workspace.firstGenerationAt is None:
        workspace.firstGenerationAt = datetime.now(UTC).replace(tzinfo=None)
    record_audit_event(
        session,
        workspace_id=project.workspaceId,
        project_id=project_id,
        action="generation.run_completed",
        entity_type="GenerationRun",
        entity_id=run.id,
        actor_type=AuditActorType.AI,
        after=dict(run.stats),
    )
    await session.commit()
    return run
