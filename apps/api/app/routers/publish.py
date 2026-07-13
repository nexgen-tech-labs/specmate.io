"""Publishing endpoints (Epic 5: Jira). Discovery, mapping config, health, and the
publish action itself. Remote calls go through an injectable gateway (tests fake it,
same pattern as connectors.py/sources.py)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field as dc_field
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import (
    AuditActorType,
    DraftItem,
    DraftItemStatus,
    Project,
    PublishedItem,
    PublishMapping,
    PublishTarget,
    TraceLink,
    Workspace,
)
from app.services.audit import record_audit_event
from app.services.connectors.jira_auth import (
    JiraConnection,
    check_connection_health,
    get_jira_connection,
)
from app.services.connectors.jira_publish import (
    PublishCandidate,
    PublishOutcome,
    create_issue,
    discover_project_meta,
    discover_projects,
    sort_for_hierarchy,
    validate_required_fields,
)
from app.services.connectors.types import ConnectorError

router = APIRouter()

# Default SpecMate -> Jira issue type suggestions, intersected with what discovery
# actually finds in the project (Issue 5.3's sensible default mapping).
_DEFAULT_TYPE_SUGGESTIONS: dict[str, list[str]] = {
    "EPIC": ["Epic"],
    "STORY": ["Story", "Task"],
    "TASK": ["Task"],
    "SUBTASK": ["Sub-task", "Subtask", "Task"],
    "ACCEPTANCE_CRITERIA": ["Task"],
    "TEST": ["Task"],
    "RISK": ["Task"],
    "NFR": ["Task"],
    "DEPENDENCY": ["Task"],
    "ASSUMPTION": ["Task"],
    "QUESTION": ["Task"],
}


@dataclass
class PublishGateway:
    connection: Callable[[], JiraConnection] = get_jira_connection
    projects: Callable[[JiraConnection], Awaitable[list[dict[str, str]]]] = discover_projects
    meta: Callable[[JiraConnection, str], Awaitable[dict[str, object]]] = discover_project_meta
    create: Callable[..., Awaitable[PublishOutcome]] = create_issue
    health: Callable[[JiraConnection], Awaitable[dict[str, object]]] = dc_field(
        default=check_connection_health
    )


def get_publish_gateway() -> PublishGateway:
    """FastAPI dependency — overridden in tests to fake the Jira API."""
    return PublishGateway()


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@router.get("/connectors/jira/health")
async def jira_health(
    gateway: Annotated[PublishGateway, Depends(get_publish_gateway)],
) -> dict[str, object]:
    try:
        connection = gateway.connection()
    except ConnectorError as exc:
        return {"ok": False, "reason": str(exc)}
    return await gateway.health(connection)


@router.get("/connectors/jira/projects")
async def jira_projects(
    gateway: Annotated[PublishGateway, Depends(get_publish_gateway)],
) -> list[dict[str, str]]:
    try:
        return await gateway.projects(gateway.connection())
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class MappingBody(BaseModel):
    remote_project: str
    type_map: dict[str, str] | None = None  # omitted -> defaults suggested from discovery
    field_defaults: dict[str, object] | None = None


@router.post("/projects/{project_id}/publish-mapping/jira")
async def upsert_mapping(
    project_id: str,
    body: MappingBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    gateway: Annotated[PublishGateway, Depends(get_publish_gateway)],
) -> dict[str, object]:
    """Creates/refreshes the mapping, re-running discovery so the metadata snapshot
    (and default type suggestions) reflect the project's current Jira config."""
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    try:
        metadata = await gateway.meta(gateway.connection(), body.remote_project)
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    raw_types = metadata.get("issue_types")
    available = {
        str(t.get("name"))
        for t in (raw_types if isinstance(raw_types, list) else [])
        if isinstance(t, dict)
    }
    type_map = body.type_map or {
        specmate_type: next((s for s in suggestions if s in available), "")
        for specmate_type, suggestions in _DEFAULT_TYPE_SUGGESTIONS.items()
    }

    existing = (
        await session.execute(
            select(PublishMapping).where(
                PublishMapping.projectId == project_id,
                PublishMapping.tool == PublishTarget.JIRA,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        existing = PublishMapping(
            projectId=project_id,
            tool=PublishTarget.JIRA,
            remoteProject=body.remote_project,
            typeMap=type_map,
            fieldDefaults=body.field_defaults,
            metadata_=metadata,
            createdAt=_now(),
            updatedAt=_now(),
        )
        session.add(existing)
    else:
        existing.remoteProject = body.remote_project
        existing.typeMap = dict(type_map)
        existing.fieldDefaults = body.field_defaults
        existing.metadata_ = metadata
        existing.updatedAt = _now()
    await session.commit()
    return {"remote_project": body.remote_project, "type_map": type_map, "metadata": metadata}


@router.get("/projects/{project_id}/publish-mapping/jira")
async def get_mapping(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, object]:
    mapping = (
        await session.execute(
            select(PublishMapping).where(
                PublishMapping.projectId == project_id,
                PublishMapping.tool == PublishTarget.JIRA,
            )
        )
    ).scalar_one_or_none()
    if mapping is None:
        raise HTTPException(status_code=404, detail="No Jira publish mapping configured.")
    return {
        "remote_project": mapping.remoteProject,
        "type_map": mapping.typeMap,
        "field_defaults": mapping.fieldDefaults,
        "metadata": mapping.metadata_,
    }


class PublishBody(BaseModel):
    item_ids: list[str]
    # Forwarded by the web proxy from the authenticated session (Issue 8.1 —
    # publish audit events carry the human who triggered them).
    actor_user_id: str | None = None


class PublishItemResult(BaseModel):
    item_id: str
    ok: bool
    key: str | None = None
    url: str | None = None
    error: str | None = None
    blocked: bool = False


class PublishResponse(BaseModel):
    results: list[PublishItemResult]
    succeeded: int
    failed: int


def _flatten_payload(payload: dict[str, object] | None) -> str:
    if not payload:
        return ""
    lines = [f"{key}: {value}" for key, value in payload.items() if value]
    return "\n".join(lines)


@router.post("/projects/{project_id}/publish/jira")
async def publish_to_jira(
    project_id: str,
    body: PublishBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    gateway: Annotated[PublishGateway, Depends(get_publish_gateway)],
) -> PublishResponse:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    workspace = await session.get(Workspace, project.workspaceId)
    assert workspace is not None

    mapping = (
        await session.execute(
            select(PublishMapping).where(
                PublishMapping.projectId == project_id,
                PublishMapping.tool == PublishTarget.JIRA,
            )
        )
    ).scalar_one_or_none()
    if mapping is None:
        raise HTTPException(
            status_code=400,
            detail="No Jira publish mapping configured — set one up in project settings first.",
        )
    field_defaults = dict(mapping.fieldDefaults or {})
    type_map = dict(mapping.typeMap)

    items_result = await session.execute(
        select(DraftItem).where(
            DraftItem.id.in_(body.item_ids),
            DraftItem.projectId == project_id,
            DraftItem.deletedAt.is_(None),
        )
    )
    items = {item.id: item for item in items_result.scalars()}

    published_result = await session.execute(
        select(PublishedItem).where(
            PublishedItem.draftItemId.in_(
                list(items.keys()) + [i.parentId for i in items.values() if i.parentId]
            ),
            PublishedItem.deletedAt.is_(None),
        )
    )
    published_keys: dict[str, str] = {
        row.draftItemId: row.externalKey for row in published_result.scalars()
    }

    results: list[PublishItemResult] = []
    candidates: list[PublishCandidate] = []

    for item_id in body.item_ids:
        item = items.get(item_id)
        if item is None:
            results.append(
                PublishItemResult(item_id=item_id, ok=False, error="Item not found in project.")
            )
            continue
        if item_id in published_keys:
            # Idempotency (Issue 5.4): re-publish is blocked, never duplicated.
            results.append(
                PublishItemResult(
                    item_id=item_id,
                    ok=False,
                    blocked=True,
                    key=published_keys[item_id],
                    error=f"Already published as {published_keys[item_id]}.",
                )
            )
            continue
        if item.status != DraftItemStatus.APPROVED:
            results.append(
                PublishItemResult(
                    item_id=item_id, ok=False, error="Only approved items can be published."
                )
            )
            continue
        if workspace.approvalStages >= 2 and item.signedOffByUserId is None:
            results.append(
                PublishItemResult(
                    item_id=item_id, ok=False, error="Awaiting sign-off (two-stage approval)."
                )
            )
            continue
        issue_type = str(type_map.get(item.type.value) or "")
        if not issue_type:
            results.append(
                PublishItemResult(
                    item_id=item_id,
                    ok=False,
                    error=f"No Jira issue type mapped for {item.type.value}.",
                )
            )
            continue
        validation_error = validate_required_fields(issue_type, mapping.metadata_, field_defaults)
        if validation_error:
            results.append(PublishItemResult(item_id=item_id, ok=False, error=validation_error))
            continue
        candidates.append(
            PublishCandidate(
                item_id=item_id,
                item_type=item.type.value,
                title=item.title,
                description=item.description,
                parent_item_id=item.parentId,
                extra_description=_flatten_payload(item.payload),
            )
        )

    connection = None
    if candidates:
        try:
            connection = gateway.connection()
        except ConnectorError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    now = _now()
    for candidate in sort_for_hierarchy(candidates):
        item = items[candidate.item_id]
        parent_key: str | None = None
        if candidate.parent_item_id:
            parent_key = published_keys.get(candidate.parent_item_id)
            if parent_key is None:
                # Parents publish first (Issue 5.6) — a child whose parent isn't
                # published (and isn't earlier in this batch) is blocked, never
                # created as an orphaned Jira issue.
                results.append(
                    PublishItemResult(
                        item_id=candidate.item_id,
                        ok=False,
                        blocked=True,
                        error="Parent item is not published yet — publish the parent first.",
                    )
                )
                continue

        assert connection is not None
        outcome = await gateway.create(
            connection,
            mapping.remoteProject,
            type_map[candidate.item_type],
            candidate,
            parent_key,
            field_defaults,
        )

        flags = dict(item.flags or {})
        if outcome.ok and outcome.key:
            published = PublishedItem(
                draftItemId=candidate.item_id,
                targetTool=PublishTarget.JIRA,
                externalKey=outcome.key,
                externalUrl=outcome.url or "",
                createdAt=now,
            )
            session.add(published)
            await session.flush()
            # Forward-trace write-back (Issue 5.5): Source -> fragment -> item -> Jira key.
            trace_rows = await session.execute(
                select(TraceLink).where(TraceLink.draftItemId == candidate.item_id)
            )
            for trace in trace_rows.scalars():
                trace.publishedItemId = published.id
                trace.updatedAt = now
            published_keys[candidate.item_id] = outcome.key
            flags.pop("publishError", None)
            item.flags = flags or None
            item.updatedAt = now
            results.append(
                PublishItemResult(
                    item_id=candidate.item_id, ok=True, key=outcome.key, url=outcome.url
                )
            )
            record_audit_event(
                session,
                workspace_id=workspace.id,
                project_id=project_id,
                action="draft_item.published",
                entity_type="DraftItem",
                entity_id=candidate.item_id,
                actor_user_id=body.actor_user_id,
                actor_type=AuditActorType.USER,
                after={"tool": "JIRA", "key": outcome.key, "url": outcome.url},
            )
        else:
            # Persisted so a page refresh doesn't lose failure visibility (Issue 5.7);
            # individually retriable by re-running publish for this item.
            flags["publishError"] = outcome.error
            item.flags = flags
            item.updatedAt = now
            results.append(
                PublishItemResult(item_id=candidate.item_id, ok=False, error=outcome.error)
            )
            record_audit_event(
                session,
                workspace_id=workspace.id,
                project_id=project_id,
                action="draft_item.publish_failed",
                entity_type="DraftItem",
                entity_id=candidate.item_id,
                actor_user_id=body.actor_user_id,
                actor_type=AuditActorType.USER,
                after={"tool": "JIRA", "error": outcome.error},
            )
        await session.commit()

    return PublishResponse(
        results=results,
        succeeded=sum(1 for r in results if r.ok),
        failed=sum(1 for r in results if not r.ok),
    )
