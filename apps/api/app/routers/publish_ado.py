"""Azure DevOps publishing endpoints (Epic 6). Mirrors publish.py's Jira shape —
discovery, mapping config (incl. format mode), health, and the publish action."""

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
    DraftItem,
    DraftItemStatus,
    Project,
    PublishedItem,
    PublishMapping,
    PublishTarget,
    TicketFormatMode,
    TraceLink,
    Workspace,
)
from app.services.connectors.ado_auth import AdoConnection, check_connection_health, get_ado_connection
from app.services.connectors.ado_publish import (
    AdoPublishOutcome,
    build_candidate,
    create_work_item,
    discover_project_meta,
    discover_projects,
    sort_for_hierarchy,
    validate_required_fields,
)
from app.services.connectors.format_adapter import FormatMode
from app.services.connectors.types import ConnectorError

router = APIRouter()

_DEFAULT_TYPE_SUGGESTIONS: dict[str, list[str]] = {
    "EPIC": ["Epic"],
    "STORY": ["Issue", "User Story", "Task"],
    "TASK": ["Task"],
    "SUBTASK": ["Task"],
    "ACCEPTANCE_CRITERIA": ["Task"],
    "TEST": ["Test Case", "Task"],
    "RISK": ["Task", "Issue"],
    "NFR": ["Task", "Issue"],
    "DEPENDENCY": ["Task", "Issue"],
    "ASSUMPTION": ["Task"],
    "QUESTION": ["Task"],
}


@dataclass
class AdoPublishGateway:
    connection: Callable[[], AdoConnection] = get_ado_connection
    projects: Callable[[AdoConnection], Awaitable[list[dict[str, str]]]] = discover_projects
    meta: Callable[[AdoConnection, str], Awaitable[dict[str, object]]] = discover_project_meta
    create: Callable[..., Awaitable[AdoPublishOutcome]] = create_work_item
    health: Callable[[AdoConnection], Awaitable[dict[str, object]]] = dc_field(
        default=check_connection_health
    )


def get_ado_gateway() -> AdoPublishGateway:
    """FastAPI dependency — overridden in tests to fake the ADO API."""
    return AdoPublishGateway()


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@router.get("/connectors/ado/health")
async def ado_health(gateway: Annotated[AdoPublishGateway, Depends(get_ado_gateway)]) -> dict[str, object]:
    try:
        connection = gateway.connection()
    except ConnectorError as exc:
        return {"ok": False, "reason": str(exc)}
    return await gateway.health(connection)


@router.get("/connectors/ado/projects")
async def ado_projects(
    gateway: Annotated[AdoPublishGateway, Depends(get_ado_gateway)],
) -> list[dict[str, str]]:
    try:
        return await gateway.projects(gateway.connection())
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class AdoMappingBody(BaseModel):
    remote_project: str
    type_map: dict[str, str] | None = None
    field_defaults: dict[str, object] | None = None
    format_mode: TicketFormatMode = TicketFormatMode.HUMAN
    area_path: str | None = None
    iteration_path: str | None = None


@router.post("/projects/{project_id}/publish-mapping/ado")
async def upsert_ado_mapping(
    project_id: str,
    body: AdoMappingBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    gateway: Annotated[AdoPublishGateway, Depends(get_ado_gateway)],
) -> dict[str, object]:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    try:
        metadata = await gateway.meta(gateway.connection(), body.remote_project)
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    raw_types = metadata.get("work_item_types")
    available = {
        str(t.get("name"))
        for t in (raw_types if isinstance(raw_types, list) else [])
        if isinstance(t, dict)
    }
    type_map = body.type_map or {
        specmate_type: next((s for s in suggestions if s in available), "")
        for specmate_type, suggestions in _DEFAULT_TYPE_SUGGESTIONS.items()
    }
    field_defaults = dict(body.field_defaults or {})
    if body.area_path:
        field_defaults["System.AreaPath"] = body.area_path
    if body.iteration_path:
        field_defaults["System.IterationPath"] = body.iteration_path

    existing = (
        await session.execute(
            select(PublishMapping).where(
                PublishMapping.projectId == project_id, PublishMapping.tool == PublishTarget.ADO
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        existing = PublishMapping(
            projectId=project_id,
            tool=PublishTarget.ADO,
            remoteProject=body.remote_project,
            typeMap=dict(type_map),
            fieldDefaults=field_defaults,
            metadata_=metadata,
            formatMode=body.format_mode,
            createdAt=_now(),
            updatedAt=_now(),
        )
        session.add(existing)
    else:
        existing.remoteProject = body.remote_project
        existing.typeMap = dict(type_map)
        existing.fieldDefaults = field_defaults
        existing.metadata_ = metadata
        existing.formatMode = body.format_mode
        existing.updatedAt = _now()
    await session.commit()
    return {
        "remote_project": body.remote_project,
        "type_map": type_map,
        "format_mode": body.format_mode.value,
        "metadata": metadata,
    }


@router.get("/projects/{project_id}/publish-mapping/ado")
async def get_ado_mapping(
    project_id: str, session: Annotated[AsyncSession, Depends(get_db_session)]
) -> dict[str, object]:
    mapping = (
        await session.execute(
            select(PublishMapping).where(
                PublishMapping.projectId == project_id, PublishMapping.tool == PublishTarget.ADO
            )
        )
    ).scalar_one_or_none()
    if mapping is None:
        raise HTTPException(status_code=404, detail="No ADO publish mapping configured.")
    return {
        "remote_project": mapping.remoteProject,
        "type_map": mapping.typeMap,
        "field_defaults": mapping.fieldDefaults,
        "format_mode": mapping.formatMode.value,
        "metadata": mapping.metadata_,
    }


class AdoPublishBody(BaseModel):
    item_ids: list[str]


class AdoPublishItemResult(BaseModel):
    item_id: str
    ok: bool
    key: str | None = None
    url: str | None = None
    error: str | None = None
    blocked: bool = False


class AdoPublishResponse(BaseModel):
    results: list[AdoPublishItemResult]
    succeeded: int
    failed: int


@router.post("/projects/{project_id}/publish/ado")
async def publish_to_ado(
    project_id: str,
    body: AdoPublishBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    gateway: Annotated[AdoPublishGateway, Depends(get_ado_gateway)],
) -> AdoPublishResponse:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    workspace = await session.get(Workspace, project.workspaceId)
    assert workspace is not None

    mapping = (
        await session.execute(
            select(PublishMapping).where(
                PublishMapping.projectId == project_id, PublishMapping.tool == PublishTarget.ADO
            )
        )
    ).scalar_one_or_none()
    if mapping is None:
        raise HTTPException(
            status_code=400,
            detail="No ADO publish mapping configured — set one up in project settings first.",
        )
    if mapping.formatMode == TicketFormatMode.BOTH:
        raise HTTPException(
            status_code=400,
            detail="Ticket format mode 'BOTH' is not yet supported by publishing.",
        )
    field_defaults = dict(mapping.fieldDefaults or {})
    type_map = dict(mapping.typeMap)
    area_path = field_defaults.pop("System.AreaPath", None)
    iteration_path = field_defaults.pop("System.IterationPath", None)
    mode = FormatMode(mapping.formatMode.value)

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
            PublishedItem.targetTool == PublishTarget.ADO,
            PublishedItem.deletedAt.is_(None),
        )
    )
    published: dict[str, tuple[str, str]] = {
        row.draftItemId: (row.externalKey, row.externalUrl) for row in published_result.scalars()
    }

    def work_item_api_url(key: str) -> str:
        # key is "AB#123"; ADO's relation payload needs the _apis resource URL, not
        # the human browse URL stored on PublishedItem.externalUrl.
        numeric_id = key.split("#", 1)[1]
        return f"{gateway.connection().org_url()}/_apis/wit/workItems/{numeric_id}"

    results: list[AdoPublishItemResult] = []
    candidates = []

    for item_id in body.item_ids:
        item = items.get(item_id)
        if item is None:
            results.append(AdoPublishItemResult(item_id=item_id, ok=False, error="Item not found."))
            continue
        if item_id in published:
            key, url = published[item_id]
            results.append(
                AdoPublishItemResult(
                    item_id=item_id, ok=False, blocked=True, key=key, error=f"Already published as {key}."
                )
            )
            continue
        if item.status != DraftItemStatus.APPROVED:
            results.append(
                AdoPublishItemResult(item_id=item_id, ok=False, error="Only approved items can be published.")
            )
            continue
        if workspace.approvalStages >= 2 and item.signedOffByUserId is None:
            results.append(
                AdoPublishItemResult(item_id=item_id, ok=False, error="Awaiting sign-off (two-stage approval).")
            )
            continue
        work_item_type = str(type_map.get(item.type.value) or "")
        if not work_item_type:
            results.append(
                AdoPublishItemResult(
                    item_id=item_id, ok=False, error=f"No ADO work item type mapped for {item.type.value}."
                )
            )
            continue
        validation_error = validate_required_fields(work_item_type, mapping.metadata_, field_defaults)
        if validation_error:
            results.append(AdoPublishItemResult(item_id=item_id, ok=False, error=validation_error))
            continue
        candidates.append(build_candidate(item, mode, item.parentId))

    connection = None
    if candidates:
        try:
            connection = gateway.connection()
        except ConnectorError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    now = _now()
    for candidate in sort_for_hierarchy(candidates):
        item = items[candidate.item_id]
        parent_url: str | None = None
        if candidate.parent_item_id:
            parent_entry = published.get(candidate.parent_item_id)
            if parent_entry is None:
                results.append(
                    AdoPublishItemResult(
                        item_id=candidate.item_id,
                        ok=False,
                        blocked=True,
                        error="Parent item is not published yet — publish the parent first.",
                    )
                )
                continue
            parent_url = work_item_api_url(parent_entry[0])

        assert connection is not None
        outcome = await gateway.create(
            connection,
            mapping.remoteProject,
            type_map[candidate.item_type],
            candidate,
            parent_url,
            area_path,
            iteration_path,
            field_defaults,
        )

        flags = dict(item.flags or {})
        if outcome.ok and outcome.key:
            row = PublishedItem(
                draftItemId=candidate.item_id,
                targetTool=PublishTarget.ADO,
                externalKey=outcome.key,
                externalUrl=outcome.url or "",
                createdAt=now,
            )
            session.add(row)
            await session.flush()
            trace_rows = await session.execute(
                select(TraceLink).where(TraceLink.draftItemId == candidate.item_id)
            )
            for trace in trace_rows.scalars():
                trace.publishedItemId = row.id
                trace.updatedAt = now
            published[candidate.item_id] = (outcome.key, outcome.url or "")
            flags.pop("publishError", None)
            item.flags = flags or None
            results.append(
                AdoPublishItemResult(item_id=candidate.item_id, ok=True, key=outcome.key, url=outcome.url)
            )
        else:
            flags["publishError"] = outcome.error
            item.flags = flags
            results.append(AdoPublishItemResult(item_id=candidate.item_id, ok=False, error=outcome.error))
        item.updatedAt = now
        await session.commit()

    return AdoPublishResponse(
        results=results,
        succeeded=sum(1 for r in results if r.ok),
        failed=sum(1 for r in results if not r.ok),
    )
