"""Materialize-connector-backlog-as-Source endpoint (Onboarding Flow redesign's
"pull from a connected tool" ingestion option) — mirrors test_connectors.py's
confluence-sync test shape, since both reuse _upsert_content_source +
replace_raw_requirements."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import Organization, Project, RawRequirement, Source, Workspace
from app.services.connectors.types import ReferenceItemData


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


async def _create_project_with_org_async() -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            org = Organization(name="Connector Source Test Org", createdAt=_now(), updatedAt=_now())
            session.add(org)
            await session.flush()
            workspace = Workspace(
                name="Connector Source Test WS",
                organizationId=org.id,
                createdAt=_now(),
                updatedAt=_now(),
            )
            session.add(workspace)
            await session.flush()
            project = Project(
                workspaceId=workspace.id,
                name="Connector Source Test Project",
                createdAt=_now(),
                updatedAt=_now(),
            )
            session.add(project)
            await session.flush()
            ids = {"organization_id": org.id, "workspace_id": workspace.id, "project_id": project.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _create_project_without_org_async() -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            workspace = Workspace(name="No Org WS", createdAt=_now(), updatedAt=_now())
            session.add(workspace)
            await session.flush()
            project = Project(
                workspaceId=workspace.id, name="No Org Project", createdAt=_now(), updatedAt=_now()
            )
            session.add(project)
            await session.flush()
            ids = {"workspace_id": workspace.id, "project_id": project.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup_async(ids: dict[str, str]) -> None:
    from sqlalchemy import delete

    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            source_ids = [
                s.id
                for s in (
                    await session.execute(select(Source).where(Source.projectId == ids["project_id"]))
                ).scalars()
            ]
            for sid in source_ids:
                await session.execute(delete(RawRequirement).where(RawRequirement.sourceId == sid))
            await session.execute(delete(Source).where(Source.projectId == ids["project_id"]))
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            if "organization_id" in ids:
                await session.execute(delete(Organization).where(Organization.id == ids["organization_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def _cleanup(ids: dict[str, str]) -> None:
    asyncio.run(_cleanup_async(ids))


async def _count_sources_async(project_id: str) -> int:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            rows = (await session.execute(select(Source).where(Source.projectId == project_id))).scalars().all()
            return len(rows)
    finally:
        await engine.dispose()


def _count_sources(project_id: str) -> int:
    return asyncio.run(_count_sources_async(project_id))


_FAKE_ISSUES = [
    ReferenceItemData(
        external_key="PAY-1", title="Add saved-card payment", description="Details here.", item_type="Story", state="To Do"
    ),
    ReferenceItemData(
        external_key="PAY-2", title="Refund flow", description="More details.", item_type="Story", state="Done"
    ),
]


def test_returns_404_for_unsupported_tool() -> None:
    ids = asyncio.run(_create_project_with_org_async())
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.post(
            f"/projects/{ids['project_id']}/sources/from-connector/ado", json={"remote": "Foo"}
        )
        assert res.status_code == 404
    finally:
        _cleanup(ids)


def test_returns_404_for_unknown_project() -> None:
    _dispose_app_engine()
    client = TestClient(app)
    res = client.post(
        "/projects/nonexistent/sources/from-connector/jira", json={"remote": "PAY"}
    )
    assert res.status_code == 404


def test_returns_400_when_workspace_has_no_organization() -> None:
    ids = asyncio.run(_create_project_without_org_async())
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.post(
            f"/projects/{ids['project_id']}/sources/from-connector/jira", json={"remote": "PAY"}
        )
        assert res.status_code == 400
    finally:
        _cleanup(ids)


def test_returns_422_when_no_org_connection_exists() -> None:
    ids = asyncio.run(_create_project_with_org_async())
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.post(
            f"/projects/{ids['project_id']}/sources/from-connector/jira", json={"remote": "PAY"}
        )
        assert res.status_code == 422
    finally:
        _cleanup(ids)


def test_creates_source_with_issues_materialized_as_raw_requirements() -> None:
    ids = asyncio.run(_create_project_with_org_async())
    try:
        with (
            patch(
                "app.routers.connectors.resolve_jira_connection",
                new=AsyncMock(return_value=object()),
            ),
            patch(
                "app.routers.connectors.fetch_jira_issues",
                new=AsyncMock(return_value=_FAKE_ISSUES),
            ),
        ):
            _dispose_app_engine()
            client = TestClient(app)
            res = client.post(
                f"/projects/{ids['project_id']}/sources/from-connector/jira", json={"remote": "PAY"}
            )
        assert res.status_code == 200
        body = res.json()
        assert body["chunk_count"] == 2
        assert body["status"] == "PARSED"
        assert "PAY" in body["name"]

        assert _count_sources(ids["project_id"]) == 1

        # Re-sync updates the existing Source rather than duplicating it.
        with (
            patch(
                "app.routers.connectors.resolve_jira_connection",
                new=AsyncMock(return_value=object()),
            ),
            patch(
                "app.routers.connectors.fetch_jira_issues",
                new=AsyncMock(return_value=_FAKE_ISSUES[:1]),
            ),
        ):
            _dispose_app_engine()
            res2 = TestClient(app).post(
                f"/projects/{ids['project_id']}/sources/from-connector/jira", json={"remote": "PAY"}
            )
        assert res2.status_code == 200
        assert res2.json()["chunk_count"] == 1
        assert _count_sources(ids["project_id"]) == 1
    finally:
        _cleanup(ids)
