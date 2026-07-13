"""The Epic 3 generation pipeline (Issue 3.1): RawRequirements -> DraftItems.

Multi-pass, all through the provider-agnostic AIAdapter:
  1. cluster fragments by theme
  2. epics from clusters
  3. stories + tasks under epics (hierarchy inferred here — Issue 3.7; orphans get
     no parent rather than a forced wrong one)
  4. supporting items (AC/tests/risks/NFRs/dependencies/assumptions/questions —
     Issues 3.2/3.8), only where traceable to source
  5. scoring + gap questions (Issues 3.4/3.6)

Every persisted item carries: promptVersion, TraceLinks to its cited fragments
(Issue 3.3 — uncited items get flags.noTrace instead of silent acceptance), an
immutable originalDraft snapshot (Issue 4.3's baseline), score detail, and duplicate
flags from the reference backlog comparison (Issue 3.5).

Idempotency: a GenerationRun row is keyed on (projectId, sha256 of ordered fragment
texts). Re-running against unchanged content returns the existing run untouched."""

from __future__ import annotations

import hashlib
import json
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
    SUPPORTING_V1,
)
from app.services.generation.schemas import (
    CLUSTER_SCHEMA,
    EPICS_SCHEMA,
    SCORING_SCHEMA,
    STORIES_SCHEMA,
    SUPPORTING_SCHEMA,
)
from app.services.generation.similarity import find_best_duplicate

_DEFAULT_DUPLICATE_THRESHOLD = 0.55
_GAP_SCORE_TRIGGER = 60  # completeness/specificity below this + a gap_question => gap flag


class GenerationError(Exception):
    """Raised when the pipeline can't run — no fragments, missing project, etc."""


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


async def run_generation(
    project_id: str,
    session: AsyncSession,
    adapter: AIAdapter,
    item_types: set[str] | None = None,
) -> GenerationRun:
    """Runs the full pipeline for a project. item_types optionally restricts which
    supporting types are generated (epics/stories/tasks are always produced)."""
    project = await session.get(Project, project_id)
    if project is None:
        raise GenerationError("Project not found.")
    workspace = await session.get(Workspace, project.workspaceId)
    assert workspace is not None

    fragments_result = await session.execute(
        select(RawRequirement)
        .join(Source, Source.id == RawRequirement.sourceId)
        .where(
            Source.projectId == project_id,
            Source.deletedAt.is_(None),
            RawRequirement.deletedAt.is_(None),
        )
        .order_by(RawRequirement.sourceId, RawRequirement.order)
    )
    fragments = list(fragments_result.scalars())
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
    block = _fragments_block(fragments)
    ws_id = project.workspaceId

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

    # Pass 3: stories + tasks
    epics_text = "\n".join(f"[{i}] {e.title}" for i, e in enumerate(epics))
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
            parent_index=epic_index if 0 <= epic_index < len(epics) else None,
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

    all_drafts: list[_Draft] = [*epics, *stories, *tasks, *supporting]

    # Pass 5: scoring + gap questions
    items_text = "\n".join(
        f"[{i}] ({d.type.value}) {d.title} — {d.description}" for i, d in enumerate(all_drafts)
    )
    scoring_data = await _call(
        adapter, "scoring", SCORING_V1, f"Items:\n{items_text}", SCORING_SCHEMA, ws_id, project_id
    )
    for score in cast(list[dict[str, object]], scoring_data.get("scores", [])):
        idx = int(cast(int, score.get("item_index", -1)))
        if not 0 <= idx < len(all_drafts):
            continue
        draft = all_drafts[idx]
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

    # Duplicate detection against the reference backlog (Issue 3.5)
    references_result = await session.execute(
        select(ReferenceItem).where(ReferenceItem.projectId == project_id)
    )
    references = [
        (r.externalKey, r.tool.value, f"{r.title}\n{r.description}")
        for r in references_result.scalars()
    ]
    threshold = (
        workspace.duplicateThreshold
        if workspace.duplicateThreshold is not None
        else settings.duplicate_similarity_threshold or _DEFAULT_DUPLICATE_THRESHOLD
    )
    if references:
        for draft in all_drafts:
            match = find_best_duplicate(f"{draft.title}\n{draft.description}", references, threshold)
            if match:
                draft.flags["duplicate"] = {
                    "key": match.external_key,
                    "tool": match.tool,
                    "confidence": match.confidence,
                }

    # Persist: run row, items (two passes so parents get IDs first), trace links.
    run = GenerationRun(
        projectId=project_id,
        contentHash=content_hash,
        promptVersion=GENERATION_PROMPT_VERSION,
    )
    session.add(run)
    await session.flush()

    now = _now()

    def _row(draft: _Draft, parent_id: str | None) -> DraftItem:
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
            generationRunId=run.id,
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

    epic_rows = [_row(e, None) for e in epics]
    session.add_all(epic_rows)
    await session.flush()

    story_rows = [
        _row(s, epic_rows[s.parent_index].id if s.parent_index is not None else None)
        for s in stories
    ]
    session.add_all(story_rows)
    await session.flush()

    def _story_parent(draft: _Draft) -> str | None:
        if draft.parent_story_index is not None:
            return story_rows[draft.parent_story_index].id
        return None

    other_rows = [_row(d, _story_parent(d)) for d in [*tasks, *supporting]]
    session.add_all(other_rows)
    await session.flush()

    all_rows = [*epic_rows, *story_rows, *other_rows]
    for draft, row in zip(all_drafts, all_rows, strict=True):
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

    # Stats (Issue 3.10) incl. source coverage.
    cited_ids = {c for d in all_drafts for c in d.chunk_ids}
    by_type: dict[str, int] = {}
    for d in all_drafts:
        by_type[d.type.value] = by_type.get(d.type.value, 0) + 1
    scores = [r.qualityScore for r in all_rows if r.qualityScore is not None]
    run.stats = {
        "items_by_type": by_type,
        "item_count": len(all_rows),
        "average_score": round(sum(scores) / len(scores), 1) if scores else None,
        "duplicates_flagged": sum(1 for d in all_drafts if "duplicate" in d.flags),
        "gaps_flagged": sum(1 for d in all_drafts if "gap" in d.flags),
        "untraced_items": sum(1 for d in all_drafts if d.flags.get("noTrace")),
        "source_coverage": round(len(cited_ids) / len(fragments), 3) if fragments else 0,
        "fragment_count": len(fragments),
    }
    # AI-actor audit event, same transaction as the run's items/stats (Issue 8.1).
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
