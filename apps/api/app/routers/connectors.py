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
    if await session.get(Project, body.project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

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
    if await session.get(Project, body.project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

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


@router.post("/connectors/slack/channels/{channel_id}/sync")
async def sync_slack_channel(
    channel_id: str,
    body: ContentSyncBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
    fetchers: Annotated[ConnectorFetchers, Depends(get_connector_fetchers)],
) -> ContentSyncResponse:
    if await session.get(Project, body.project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

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
