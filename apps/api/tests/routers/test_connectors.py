"""Router-level connector tests — real Postgres, faked remote fetchers via the
get_connector_fetchers dependency (same sync-test + asyncio.run pattern as
test_sources.py, for the same event-loop reasons documented there)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import Project, RawRequirement, ReferenceItem, Source, Workspace
from app.routers.connectors import ConnectorFetchers, get_connector_fetchers
from app.services.connectors.confluence import ConfluencePage
from app.services.connectors.types import ReferenceItemData


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


async def _create_project() -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            workspace = Workspace(name="Connector Test WS", createdAt=_now(), updatedAt=_now())
            session.add(workspace)
            await session.flush()
            project = Project(
                workspaceId=workspace.id,
                name="Connector Test Project",
                createdAt=_now(),
                updatedAt=_now(),
            )
            session.add(project)
            await session.flush()
            ids = {"project_id": project.id, "workspace_id": workspace.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, str]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            source_ids = [
                s.id
                for s in (
                    await session.execute(
                        select(Source).where(Source.projectId == ids["project_id"])
                    )
                ).scalars()
            ]
            if source_ids:
                await session.execute(
                    delete(RawRequirement).where(RawRequirement.sourceId.in_(source_ids))
                )
                await session.execute(delete(Source).where(Source.id.in_(source_ids)))
            await session.execute(
                delete(ReferenceItem).where(ReferenceItem.projectId == ids["project_id"])
            )
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


async def _count_reference_items(project_id: str) -> int:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            result = await session.execute(
                select(ReferenceItem).where(ReferenceItem.projectId == project_id)
            )
            return len(list(result.scalars()))
    finally:
        await engine.dispose()


async def _count_sources(project_id: str) -> int:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            result = await session.execute(
                select(Source).where(Source.projectId == project_id, Source.deletedAt.is_(None))
            )
            return len(list(result.scalars()))
    finally:
        await engine.dispose()


def _fake_fetchers(items: list[ReferenceItemData]) -> ConnectorFetchers:
    async def fake_reference(_remote: str) -> list[ReferenceItemData]:
        return items

    async def fake_page(page_id: str) -> ConfluencePage:
        return ConfluencePage(
            page_id=page_id,
            title="Payments Spec",
            html="<h1>Overview</h1><p>Intro text.</p><h2>Scope</h2><p>Scope text.</p>",
        )

    async def fake_slack(_channel_id: str) -> list[dict[str, object]]:
        return [
            {"user": "U1", "text": "We need refunds.", "ts": "1751059200.0"},
            {"bot_id": "B1", "text": "bot noise", "ts": "1751059201.0"},
        ]

    from app.models import PublishTarget

    return ConnectorFetchers(
        reference={
            PublishTarget.JIRA: fake_reference,
            PublishTarget.ADO: fake_reference,
            PublishTarget.GITHUB: fake_reference,
        },
        confluence_page=fake_page,
        slack_messages=fake_slack,
    )


_ITEMS_V1 = [
    ReferenceItemData("PAY-1", "Login", "SSO login", "Story", "Open"),
    ReferenceItemData("PAY-2", "Refunds", "30-day refunds", "Story", "Open"),
]
_ITEMS_V2 = [
    ReferenceItemData("PAY-1", "Login (updated)", "SSO login v2", "Story", "In Progress"),
    ReferenceItemData("PAY-2", "Refunds", "30-day refunds", "Story", "Done"),
    ReferenceItemData("PAY-3", "Reports", "Monthly reports", "Task", "Open"),
]


def test_jira_reference_sync_then_resync_upserts_without_duplicates() -> None:
    ids = asyncio.run(_create_project())
    client = TestClient(app)
    body = {"project_id": ids["project_id"], "remote": "PAY"}

    app.dependency_overrides[get_connector_fetchers] = lambda: _fake_fetchers(_ITEMS_V1)
    try:
        first = client.post("/connectors/jira/reference-items/sync", json=body)
    finally:
        app.dependency_overrides.pop(get_connector_fetchers, None)
        _dispose_app_engine()
    assert first.status_code == 200
    assert first.json() == {"tool": "jira", "created": 2, "updated": 0, "total": 2}

    app.dependency_overrides[get_connector_fetchers] = lambda: _fake_fetchers(_ITEMS_V2)
    try:
        second = client.post("/connectors/jira/reference-items/sync", json=body)
    finally:
        app.dependency_overrides.pop(get_connector_fetchers, None)
        _dispose_app_engine()
    assert second.status_code == 200
    assert second.json() == {"tool": "jira", "created": 1, "updated": 2, "total": 3}

    assert asyncio.run(_count_reference_items(ids["project_id"])) == 3
    asyncio.run(_cleanup(ids))


def test_unknown_connector_tool_returns_400() -> None:
    client = TestClient(app)
    response = client.post(
        "/connectors/trello/reference-items/sync", json={"project_id": "x", "remote": "y"}
    )
    _dispose_app_engine()
    assert response.status_code == 400


def test_confluence_page_resync_updates_source_without_duplicating_it() -> None:
    ids = asyncio.run(_create_project())
    client = TestClient(app)
    body = {"project_id": ids["project_id"]}

    for _ in range(2):
        app.dependency_overrides[get_connector_fetchers] = lambda: _fake_fetchers([])
        try:
            response = client.post("/connectors/confluence/pages/12345/sync", json=body)
        finally:
            app.dependency_overrides.pop(get_connector_fetchers, None)
            _dispose_app_engine()
        assert response.status_code == 200
        assert response.json()["chunk_count"] == 2
        assert response.json()["name"] == "Payments Spec"

    assert asyncio.run(_count_sources(ids["project_id"])) == 1
    asyncio.run(_cleanup(ids))


def test_slack_channel_sync_creates_source_with_filtered_chunks() -> None:
    ids = asyncio.run(_create_project())
    client = TestClient(app)

    app.dependency_overrides[get_connector_fetchers] = lambda: _fake_fetchers([])
    try:
        response = client.post(
            "/connectors/slack/channels/C123/sync",
            json={"project_id": ids["project_id"], "channel_name": "payments"},
        )
    finally:
        app.dependency_overrides.pop(get_connector_fetchers, None)
        _dispose_app_engine()

    assert response.status_code == 200
    payload = response.json()
    assert payload["name"] == "#payments"
    assert payload["chunk_count"] == 1  # bot message filtered out

    asyncio.run(_cleanup(ids))
