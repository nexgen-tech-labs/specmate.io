"""Connector sync endpoints (Issues #12-16).

- Backlog reference sync (Jira/ADO/GitHub): upserts read-only ReferenceItem rows by
  (projectId, tool, externalKey) — re-sync never duplicates.
- Content sync (Confluence page, Slack channel): upserts a Source row by
  (projectId, externalRef) and replaces its RawRequirements — re-sync updates the
  same Source instead of creating a new one.

All remote fetchers are injected via an overridable dependency so tests fake the
network boundary, mirroring the blob-downloader pattern in sources.py."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.core.rate_limit import enforce_rate_limit
from app.models import Project, PublishTarget, ReferenceItem, Source, SourceKind, SourceStatus
from app.routers.sources import replace_raw_requirements
from app.services.connectors.ado import fetch_ado_work_items
from app.services.connectors.confluence import (
    ConfluencePage,
    extract_confluence_chunks,
    fetch_confluence_page,
)
from app.services.connectors.github import fetch_github_issues
from app.services.connectors.jira import fetch_jira_issues
from app.services.connectors.registry import CONNECTOR_REGISTRY
from app.services.connectors.slack import (
    fetch_slack_messages,
    fetch_user_names,
    filter_and_chunk_messages,
)
from app.services.connectors.types import ConnectorError, ReferenceItemData

router = APIRouter()

ReferenceFetcher = Callable[[str], Awaitable[list[ReferenceItemData]]]


@dataclass
class ConnectorFetchers:
    reference: dict[PublishTarget, ReferenceFetcher] = field(
        default_factory=lambda: {
            PublishTarget.JIRA: fetch_jira_issues,
            PublishTarget.ADO: fetch_ado_work_items,
            PublishTarget.GITHUB: fetch_github_issues,
        }
    )
    confluence_page: Callable[[str], Awaitable[ConfluencePage]] = fetch_confluence_page
    slack_messages: Callable[[str], Awaitable[list[dict[str, object]]]] = fetch_slack_messages
    slack_user_names: Callable[[set[str]], Awaitable[dict[str, str]]] = fetch_user_names


def get_connector_fetchers() -> ConnectorFetchers:
    """FastAPI dependency — overridden in tests to fake the remote APIs."""
    return ConnectorFetchers()


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


_TOOLS = {"jira": PublishTarget.JIRA, "ado": PublishTarget.ADO, "github": PublishTarget.GITHUB}


class ReferenceSyncBody(BaseModel):
    project_id: str
    # Jira: project key; ADO: project name; GitHub: "owner/repo".
    remote: str


class ReferenceSyncResponse(BaseModel):
    tool: str
    created: int
    updated: int
    total: int


@router.post("/connectors/{tool}/reference-items/sync")
async def sync_reference_items(
    tool: str,
    body: ReferenceSyncBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    fetchers: Annotated[ConnectorFetchers, Depends(get_connector_fetchers)],
) -> ReferenceSyncResponse:
    target = _TOOLS.get(tool)
    if target is None:
        raise HTTPException(
            status_code=400, detail=f"Unknown connector '{tool}' — expected jira, ado, or github."
        )
    project = await session.get(Project, body.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    await enforce_rate_limit(session, project.workspaceId)

    try:
        items = await fetchers.reference[target](body.remote)
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    existing_result = await session.execute(
        select(ReferenceItem).where(
            ReferenceItem.projectId == body.project_id, ReferenceItem.tool == target
        )
    )
    existing = {row.externalKey: row for row in existing_result.scalars()}

    now = _now()
    created = updated = 0
    for item in items:
        row = existing.get(item.external_key)
        if row is None:
            session.add(
                ReferenceItem(
                    projectId=body.project_id,
                    tool=target,
                    externalKey=item.external_key,
                    title=item.title,
                    description=item.description,
                    itemType=item.item_type,
                    state=item.state,
                    url=item.url,
                    syncedAt=now,
                    createdAt=now,
                    updatedAt=now,
                )
            )
            created += 1
        else:
            row.title = item.title
            row.description = item.description
            row.itemType = item.item_type
            row.state = item.state
            row.url = item.url
            row.syncedAt = now
            row.updatedAt = now
            updated += 1

    await session.commit()
    return ReferenceSyncResponse(tool=tool, created=created, updated=updated, total=len(items))


class ContentSyncBody(BaseModel):
    project_id: str
    # Slack only — human-readable channel name used in location pointers.
    channel_name: str | None = None


class ContentSyncResponse(BaseModel):
    source_id: str
    name: str
    status: str
    chunk_count: int


async def _upsert_content_source(
    session: AsyncSession,
    project_id: str,
    external_ref: str,
    name: str,
    kind: SourceKind,
) -> Source:
    result = await session.execute(
        select(Source).where(
            Source.projectId == project_id, Source.externalRef == external_ref
        )
    )
    source = result.scalar_one_or_none()
    if source is None:
        source = Source(
            projectId=project_id,
            name=name,
            kind=kind,
            externalRef=external_ref,
            createdAt=_now(),
            updatedAt=_now(),
        )
        session.add(source)
        await session.flush()
    else:
        source.name = name
        source.deletedAt = None
    return source


@router.post("/connectors/confluence/pages/{page_id}/sync")
async def sync_confluence_page(
    page_id: str,
    body: ContentSyncBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    fetchers: Annotated[ConnectorFetchers, Depends(get_connector_fetchers)],
) -> ContentSyncResponse:
    project = await session.get(Project, body.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    await enforce_rate_limit(session, project.workspaceId)

    try:
        page = await fetchers.confluence_page(page_id)
        chunks = extract_confluence_chunks(page.title, page.html)
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    source = await _upsert_content_source(
        session, body.project_id, f"confluence:{page_id}", page.title, SourceKind.CONFLUENCE
    )
    await replace_raw_requirements(session, source.id, chunks)
    source.status = SourceStatus.PARSED
    source.parseError = None
    source.updatedAt = _now()
    await session.commit()

    return ContentSyncResponse(
        source_id=source.id,
        name=source.name,
        status=SourceStatus.PARSED.value,
        chunk_count=len(chunks),
    )


# --- Setup wizard endpoints (Issue #101) ---------------------------------
#
# Distinct from the sync endpoints above: these never write ReferenceItem/Source
# rows, and test_connection specifically never writes a PublishMapping row either
# — it's a read-only probe the wizard uses to preview scopes/types before the
# user commits to a mapping (see publish.py's upsert_mapping for the endpoint
# that actually persists one).


class ConnectorCapabilitiesResponse(BaseModel):
    supports_native_hierarchy: bool
    type_system: str
    parent_link_strategy: str


class ConnectorDefinitionResponse(BaseModel):
    tool_key: str
    display_name: str
    auth_methods: list[str]
    scope_picker_type: str
    capabilities: ConnectorCapabilitiesResponse


class ListConnectorsResponse(BaseModel):
    connectors: list[ConnectorDefinitionResponse]


@router.get("/connectors")
async def list_connectors() -> ListConnectorsResponse:
    return ListConnectorsResponse(
        connectors=[
            ConnectorDefinitionResponse(
                tool_key=c.tool_key,
                display_name=c.display_name,
                auth_methods=list(c.auth_methods),
                scope_picker_type=c.scope_picker_type,
                capabilities=ConnectorCapabilitiesResponse(
                    supports_native_hierarchy=c.capabilities.supports_native_hierarchy,
                    type_system=c.capabilities.type_system,
                    parent_link_strategy=c.capabilities.parent_link_strategy,
                ),
            )
            for c in CONNECTOR_REGISTRY.values()
        ]
    )


class TestConnectionBody(BaseModel):
    # Optional — omitted on the first wizard step before a scope is chosen, the
    # same pattern MappingBody uses in publish.py (a request body rather than a
    # query param, since this is a POST and the codebase already has precedent
    # for that shape).
    remote_project: str | None = None


class TestConnectionResponse(BaseModel):
    scope_options: list[dict[str, str]]
    item_types: list[dict[str, object]] | None
    extras: dict[str, object]


@router.post("/workspaces/{workspace_id}/projects/{project_id}/connectors/{tool_key}/test")
async def test_connection(
    workspace_id: str,
    project_id: str,
    tool_key: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    body: TestConnectionBody = TestConnectionBody(),
) -> TestConnectionResponse:
    connector = CONNECTOR_REGISTRY.get(tool_key)
    if connector is None:
        raise HTTPException(status_code=404, detail=f"Unknown connector '{tool_key}'.")

    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    connection = await _resolve_connection(session, tool_key, workspace_id)

    try:
        result = await connector.discovery_fn(connection, body.remote_project)
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — surfaced as a clean 502, not a raw crash
        raise HTTPException(status_code=502, detail=f"Connection test failed: {exc}") from exc

    return TestConnectionResponse(
        scope_options=[{"id": o.id, "label": o.label} for o in result.scope_options],
        item_types=(
            [
                {
                    "id": it.id,
                    "name": it.name,
                    "supports_children": it.supports_children,
                    "fields": [
                        {"id": f.id, "name": f.name, "required": f.required, "has_default": f.has_default}
                        for f in it.fields
                    ],
                }
                for it in result.item_types
            ]
            if result.item_types is not None
            else None
        ),
        extras=result.extras,
    )


async def _resolve_connection(session: AsyncSession, tool_key: str, workspace_id: str) -> object:
    """Per-workspace connection resolution (Issue #101; Jira fast-follow to #101).
    GitHub and Jira prefer a stored OAuth Connection for this workspace, falling
    back to the env-configured connection. ADO has no per-workspace Connection
    support yet (see design doc) — it stays on the existing single-tenant
    env-configured resolver unchanged."""
    if tool_key == "jira":
        from app.services.connectors.jira_auth import resolve_jira_connection

        return await resolve_jira_connection(session, workspace_id)
    if tool_key == "ado":
        from app.services.connectors.ado_auth import get_ado_connection

        return get_ado_connection()
    if tool_key == "github":
        from app.services.connectors.github_auth import resolve_github_connection

        return await resolve_github_connection(session, workspace_id)
    raise HTTPException(status_code=404, detail=f"Unknown connector '{tool_key}'.")


@router.post("/connectors/slack/channels/{channel_id}/sync")
async def sync_slack_channel(
    channel_id: str,
    body: ContentSyncBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    fetchers: Annotated[ConnectorFetchers, Depends(get_connector_fetchers)],
) -> ContentSyncResponse:
    project = await session.get(Project, body.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    await enforce_rate_limit(session, project.workspaceId)

    channel_label = body.channel_name or channel_id
    try:
        messages = await fetchers.slack_messages(channel_id)
        user_ids = {
            str(m.get("user"))
            for m in messages
            if m.get("user") and not m.get("bot_id") and not m.get("subtype")
        }
        user_names = await fetchers.slack_user_names(user_ids)
        chunks = filter_and_chunk_messages(messages, channel_label, user_names)
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    source = await _upsert_content_source(
        session, body.project_id, f"slack:{channel_id}", f"#{channel_label}", SourceKind.SLACK
    )
    await replace_raw_requirements(session, source.id, chunks)
    source.status = SourceStatus.PARSED
    source.parseError = None
    source.updatedAt = _now()
    await session.commit()

    return ContentSyncResponse(
        source_id=source.id,
        name=source.name,
        status=SourceStatus.PARSED.value,
        chunk_count=len(chunks),
    )
