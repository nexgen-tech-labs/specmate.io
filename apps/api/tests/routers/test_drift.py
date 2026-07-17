"""Drift detection tests (Issue 9.5) — real Postgres, monkeypatched connector fetch
functions (no real Jira/ADO/GitHub call needed to prove the diff/flag logic)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import DraftItem, DriftFlag, Project, PublishedItem, Workspace
from app.services.connectors.jira_auth import CloudTokenConnection
from app.services.connectors.jira_publish import RemoteIssueState
from tests.audit_cleanup import purge_audit_events


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose() -> None:
    asyncio.run(db_module.engine.dispose())


async def _fixture(last_known: dict[str, object] | None) -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(name="Drift WS", createdAt=_now(), updatedAt=_now())
            session.add(ws)
            await session.flush()
            project = Project(workspaceId=ws.id, name="Drift Project", createdAt=_now(), updatedAt=_now())
            session.add(project)
            await session.flush()

            item = DraftItem(
                projectId=project.id, type="STORY", title="Saved card story",
                description="d", status="APPROVED", createdAt=_now(), updatedAt=_now(),
            )
            session.add(item)
            await session.flush()

            published = PublishedItem(
                draftItemId=item.id, targetTool="JIRA", externalKey="KAN-101",
                externalUrl="https://x/browse/KAN-101", lastKnownState=last_known,
                lastSyncedAt=_now(), createdAt=_now(),
            )
            session.add(published)
            await session.flush()

            ids = {
                "workspace_id": ws.id, "project_id": project.id,
                "item_id": item.id, "published_item_id": published.id,
            }
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, str]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(delete(DriftFlag).where(DriftFlag.publishedItemId == ids["published_item_id"]))
            await session.execute(delete(PublishedItem).where(PublishedItem.id == ids["published_item_id"]))
            await session.execute(delete(DraftItem).where(DraftItem.id == ids["item_id"]))
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await purge_audit_events(session, ids["workspace_id"])
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def test_drift_check_flags_a_changed_title(monkeypatch: pytest.MonkeyPatch) -> None:
    ids = asyncio.run(_fixture({"title": "Saved card story", "description": "d"}))

    async def fake_fetch(_conn: object, _key: str) -> RemoteIssueState:
        return RemoteIssueState(key="KAN-101", title="Manually renamed in Jira", description="d", status="To Do")

    monkeypatch.setattr(
        "app.routers.drift.get_jira_connection", lambda: CloudTokenConnection("e", "t", "https://x")
    )
    monkeypatch.setattr("app.routers.drift.jira_fetch_issue", fake_fetch)

    client = TestClient(app)
    try:
        response = client.post(f"/projects/{ids['project_id']}/drift-check")
    finally:
        _dispose()

    assert response.status_code == 200
    body = response.json()
    assert body["drifted_count"] == 1
    result = body["results"][0]
    assert result["drifted"] is True
    assert result["diff"]["title"]["before"] == "Saved card story"
    assert result["diff"]["title"]["after"] == "Manually renamed in Jira"

    async def fetch_flag_count() -> int:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                rows = list(
                    (
                        await session.execute(
                            DriftFlag.__table__.select().where(
                                DriftFlag.publishedItemId == ids["published_item_id"]
                            )
                        )
                    ).fetchall()
                )
                return len(rows)
        finally:
            await engine.dispose()

    assert asyncio.run(fetch_flag_count()) == 1

    asyncio.run(_cleanup(ids))


def test_drift_check_reports_clean_when_nothing_changed(monkeypatch: pytest.MonkeyPatch) -> None:
    ids = asyncio.run(_fixture({"title": "Saved card story", "description": "d"}))

    async def fake_fetch(_conn: object, _key: str) -> RemoteIssueState:
        return RemoteIssueState(key="KAN-101", title="Saved card story", description="d", status="To Do")

    monkeypatch.setattr(
        "app.routers.drift.get_jira_connection", lambda: CloudTokenConnection("e", "t", "https://x")
    )
    monkeypatch.setattr("app.routers.drift.jira_fetch_issue", fake_fetch)

    client = TestClient(app)
    try:
        response = client.post(f"/projects/{ids['project_id']}/drift-check")
    finally:
        _dispose()

    assert response.status_code == 200
    body = response.json()
    assert body["drifted_count"] == 0
    assert body["results"][0]["drifted"] is False

    asyncio.run(_cleanup(ids))


def test_repeated_drift_check_does_not_duplicate_open_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    ids = asyncio.run(_fixture({"title": "Saved card story", "description": "d"}))

    async def fake_fetch(_conn: object, _key: str) -> RemoteIssueState:
        return RemoteIssueState(key="KAN-101", title="Renamed again", description="d", status="To Do")

    monkeypatch.setattr(
        "app.routers.drift.get_jira_connection", lambda: CloudTokenConnection("e", "t", "https://x")
    )
    monkeypatch.setattr("app.routers.drift.jira_fetch_issue", fake_fetch)

    client = TestClient(app)
    try:
        client.post(f"/projects/{ids['project_id']}/drift-check")
        _dispose()
        client.post(f"/projects/{ids['project_id']}/drift-check")
    finally:
        _dispose()

    async def fetch_flag_count() -> int:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                rows = list(
                    (
                        await session.execute(
                            DriftFlag.__table__.select().where(
                                DriftFlag.publishedItemId == ids["published_item_id"]
                            )
                        )
                    ).fetchall()
                )
                return len(rows)
        finally:
            await engine.dispose()

    assert asyncio.run(fetch_flag_count()) == 1  # not 2

    asyncio.run(_cleanup(ids))


def test_resolve_drift_accept_external_updates_baseline(monkeypatch: pytest.MonkeyPatch) -> None:
    ids = asyncio.run(_fixture({"title": "Saved card story", "description": "d"}))

    async def fake_fetch(_conn: object, _key: str) -> RemoteIssueState:
        return RemoteIssueState(key="KAN-101", title="Renamed externally", description="d", status="To Do")

    monkeypatch.setattr(
        "app.routers.drift.get_jira_connection", lambda: CloudTokenConnection("e", "t", "https://x")
    )
    monkeypatch.setattr("app.routers.drift.jira_fetch_issue", fake_fetch)

    client = TestClient(app)
    try:
        check = client.post(f"/projects/{ids['project_id']}/drift-check")
    finally:
        _dispose()

    async def fetch_flag_id() -> str:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                row = (
                    await session.execute(
                        DriftFlag.__table__.select().where(
                            DriftFlag.publishedItemId == ids["published_item_id"]
                        )
                    )
                ).first()
                assert row is not None
                return str(row.id)
        finally:
            await engine.dispose()

    flag_id = asyncio.run(fetch_flag_id())
    _dispose()

    client2 = TestClient(app)
    try:
        resolve = client2.post(
            f"/drift-flags/{flag_id}/resolve",
            json={"resolution": "ACCEPT_EXTERNAL", "resolved_by_user_id": "u1"},
        )
    finally:
        _dispose()

    assert resolve.status_code == 200
    assert resolve.json()["resolution"] == "ACCEPT_EXTERNAL"

    async def fetch_state() -> dict[str, object] | None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                published = await session.get(PublishedItem, ids["published_item_id"])
                assert published is not None
                return published.lastKnownState
        finally:
            await engine.dispose()

    state = asyncio.run(fetch_state())
    assert state is not None and state["title"] == "Renamed externally"

    # A follow-up drift check against the same (still "Renamed externally") remote
    # state is now clean — SpecMate adopted the external change as its baseline.
    client3 = TestClient(app)
    try:
        recheck = client3.post(f"/projects/{ids['project_id']}/drift-check")
    finally:
        _dispose()
    assert recheck.json()["drifted_count"] == 0

    asyncio.run(_cleanup(ids))
    assert check.status_code == 200
