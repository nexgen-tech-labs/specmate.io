"""Targeted regeneration (Issue 9.2): scopes AI generation to only the fragments a
source-version diff (Issue 9.1) actually flagged as added or modified, instead of
re-running the whole-project pipeline (Epic 3's run_generation).

For each changed fragment:
  - modified: revise the existing DraftItem(s) traced to the fragment it supersedes
    (same shape as the single-item regenerate_item flow in routers/generation.py),
    linked via revisionOfId. If nothing was ever traced to that old fragment, treat
    it like added instead — there's nothing to revise.
  - added: draft one brand-new DraftItem from the fragment alone, unparented.
  - removed: nothing to regenerate — the previously-traced DraftItem(s) are flagged
    (flags.sourceRemoved) for reviewer decision, never auto-deleted or silently kept.
  - unchanged: untouched. Not read, not re-sent to the AI, no DraftItem touched.

Cross-project consistency (new epic per changed fragment, hierarchy drift, etc.) is an
explicit non-goal here — that's what a full run_generation pass is for. This is a
narrow, cheap top-up for incremental source edits."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AuditActorType,
    DraftItem,
    DraftItemStatus,
    DraftItemType,
    RawRequirement,
    Source,
    SourceDiff,
    TraceLink,
)
from app.services.ai.adapter import AIAdapter, GenerationRequest, Message
from app.services.ai.prompts.generation_v1 import (
    GENERATION_PROMPT_VERSION,
    NEW_FROM_FRAGMENT_V1,
    REGENERATE_V1,
)
from app.services.audit import record_audit_event
from app.services.generation.schemas import NEW_FROM_FRAGMENT_SCHEMA, REGENERATE_SCHEMA


class TargetedRegenerationError(Exception):
    """Raised when targeted regeneration can't run — no diff, source not found, etc."""


@dataclass
class TargetedRegenerationResult:
    revised_item_ids: list[str] = field(default_factory=list)
    new_item_ids: list[str] = field(default_factory=list)
    flagged_removed_item_ids: list[str] = field(default_factory=list)
    untouched_fragment_count: int = 0


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _call(
    adapter: AIAdapter,
    system: str,
    user: str,
    schema: dict[str, object],
    workspace_id: str,
    project_id: str,
) -> dict[str, object]:
    result = await adapter.generate(
        GenerationRequest(
            task="structuring",
            system=system,
            messages=[Message(role="user", content=user)],
            schema_=schema,
            workspace_id=workspace_id,
            project_id=project_id,
            prompt_version=GENERATION_PROMPT_VERSION,
        )
    )
    return result.data


async def run_targeted_regeneration(
    project_id: str,
    workspace_id: str,
    new_source_id: str,
    session: AsyncSession,
    adapter: AIAdapter,
) -> TargetedRegenerationResult:
    source = await session.get(Source, new_source_id)
    if source is None or source.projectId != project_id:
        raise TargetedRegenerationError("Source not found in this project.")

    diff = (
        await session.execute(select(SourceDiff).where(SourceDiff.sourceId == new_source_id))
    ).scalar_one_or_none()
    if diff is None:
        raise TargetedRegenerationError(
            "No diff available for this source — it has no previous version, or hasn't "
            "been (re)parsed since being linked as one."
        )

    fragments = diff.fragments
    result = TargetedRegenerationResult()
    now = _now()

    for entry in fragments:
        change_type = str(entry["changeType"])
        if change_type == "unchanged":
            result.untouched_fragment_count += 1
            continue

        if change_type == "removed":
            previous_fragment_id = cast(str, entry["previousRawRequirementId"])
            trace_result = await session.execute(
                select(TraceLink.draftItemId).where(
                    TraceLink.rawRequirementId == previous_fragment_id
                )
            )
            affected_item_ids = {row[0] for row in trace_result.all()}
            for item_id in affected_item_ids:
                item = await session.get(DraftItem, item_id)
                if item is None or item.deletedAt is not None:
                    continue
                item.flags = {**(item.flags or {}), "sourceRemoved": True}
                item.sourceVersionId = new_source_id
                item.updatedAt = now
                result.flagged_removed_item_ids.append(item.id)
            continue

        fragment_id = cast(str, entry["rawRequirementId"])
        fragment = await session.get(RawRequirement, fragment_id)
        if fragment is None:
            continue

        if change_type == "modified":
            previous_fragment_id = cast(str, entry["previousRawRequirementId"])
            trace_result = await session.execute(
                select(TraceLink.draftItemId).where(
                    TraceLink.rawRequirementId == previous_fragment_id
                )
            )
            affected_item_ids = {row[0] for row in trace_result.all()}
            active_items = [
                item
                for item_id in affected_item_ids
                if (item := await session.get(DraftItem, item_id)) is not None
                and item.deletedAt is None
            ]
            if not active_items:
                # Nothing was ever traced to the old fragment (or it's since been
                # removed) — nothing to revise, fall through to draft-as-new instead.
                await _draft_new_item(
                    project_id, workspace_id, new_source_id, fragment, adapter, session, now, result
                )
                continue
            for item in active_items:
                if item.status == DraftItemStatus.APPROVED:
                    # Approved items are locked (Epic 4 convention) — flag instead of
                    # silently superseding a signed-off item out from under the reviewer.
                    item.flags = {**(item.flags or {}), "sourceModified": True}
                    item.sourceVersionId = new_source_id
                    item.updatedAt = now
                    continue
                await _revise_item(
                    item, fragment, new_source_id, workspace_id, adapter, session, now, result
                )
            continue

        if change_type == "added":
            await _draft_new_item(
                project_id, workspace_id, new_source_id, fragment, adapter, session, now, result
            )

    await session.commit()
    return result


async def _revise_item(
    item: DraftItem,
    fragment: RawRequirement,
    new_source_id: str,
    workspace_id: str,
    adapter: AIAdapter,
    session: AsyncSession,
    now: datetime,
    result: TargetedRegenerationResult,
) -> None:
    """Same shape as routers/generation.py's regenerate_item, driven by the new
    fragment text instead of reviewer-supplied context."""
    user = (
        f"Item type: {item.type.value}\nTitle: {item.title}\nDescription: {item.description}\n\n"
        f"The source document changed. Updated fragment "
        f"[{fragment.id}] ({fragment.sectionPath}): {fragment.text}"
    )
    data = await _call(
        adapter, REGENERATE_V1, user, REGENERATE_SCHEMA, workspace_id, item.projectId
    )

    new_item = DraftItem(
        projectId=item.projectId,
        type=item.type,
        title=str(data.get("title", item.title)),
        description=str(data.get("description", item.description)),
        payload=cast(dict[str, object] | None, data.get("extra")) or item.payload,
        parentId=item.parentId,
        status=DraftItemStatus.PENDING,
        promptVersion=GENERATION_PROMPT_VERSION,
        generationRunId=item.generationRunId,
        flags=item.flags,
        originalDraft={
            "title": str(data.get("title", item.title)),
            "description": str(data.get("description", item.description)),
            "payload": data.get("extra"),
        },
        revisionOfId=item.id,
        sourceVersionId=new_source_id,
        createdAt=now,
        updatedAt=now,
    )
    session.add(new_item)
    await session.flush()

    session.add(
        TraceLink(
            sourceId=fragment.sourceId,
            rawRequirementId=fragment.id,
            draftItemId=new_item.id,
            createdAt=now,
            updatedAt=now,
        )
    )

    item.deletedAt = now
    item.updatedAt = now
    record_audit_event(
        session,
        workspace_id=workspace_id,
        project_id=item.projectId,
        action="draft_item.targeted_regenerated",
        entity_type="DraftItem",
        entity_id=new_item.id,
        actor_type=AuditActorType.AI,
        before={"item_id": item.id, "title": item.title},
        after={"title": new_item.title, "source_fragment_id": fragment.id},
    )
    result.revised_item_ids.append(new_item.id)


async def _draft_new_item(
    project_id: str,
    workspace_id: str,
    new_source_id: str,
    fragment: RawRequirement,
    adapter: AIAdapter,
    session: AsyncSession,
    now: datetime,
    result: TargetedRegenerationResult,
) -> None:
    user = f"New fragment [{fragment.id}] ({fragment.sectionPath}): {fragment.text}"
    data = await _call(
        adapter,
        NEW_FROM_FRAGMENT_V1,
        user,
        NEW_FROM_FRAGMENT_SCHEMA,
        workspace_id,
        project_id,
    )
    type_name = str(data.get("type", "STORY"))
    if type_name not in DraftItemType.__members__:
        type_name = "STORY"

    new_item = DraftItem(
        projectId=project_id,
        type=DraftItemType[type_name],
        title=str(data.get("title", "")),
        description=str(data.get("description", "")),
        payload=cast(dict[str, object] | None, data.get("extra")) or None,
        parentId=None,
        status=DraftItemStatus.PENDING,
        promptVersion=GENERATION_PROMPT_VERSION,
        originalDraft={
            "title": data.get("title", ""),
            "description": data.get("description", ""),
            "payload": data.get("extra"),
        },
        sourceVersionId=new_source_id,
        createdAt=now,
        updatedAt=now,
    )
    session.add(new_item)
    await session.flush()

    session.add(
        TraceLink(
            sourceId=fragment.sourceId,
            rawRequirementId=fragment.id,
            draftItemId=new_item.id,
            createdAt=now,
            updatedAt=now,
        )
    )
    record_audit_event(
        session,
        workspace_id=workspace_id,
        project_id=project_id,
        action="draft_item.targeted_generated",
        entity_type="DraftItem",
        entity_id=new_item.id,
        actor_type=AuditActorType.AI,
        after={"title": new_item.title, "source_fragment_id": fragment.id},
    )
    result.new_item_ids.append(new_item.id)
