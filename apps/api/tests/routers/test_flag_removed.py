"""Flag-removed endpoint tests (Issue 9.4) — real Postgres, fake connector auth +
comment functions via dependency/monkeypatch overrides."""

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
from app.models import DraftItem, Project, PublishedItem, PublishMapping, Workspace
from app.services.connectors.jira_auth import CloudTokenConnection
from tests.audit_cleanup import purge_audit_events


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose() -> None:
    asyncio.run(db_module.engine.dispose())


async def _fixture(flagged: bool = True, published: bool = True) -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            ws = Workspace(name="Flag Removed WS", createdAt=_now(), updatedAt=_now())
            session.add(ws)
            await session.flush()
            project = Project(workspaceId=ws.id, name="Flag Removed Project", createdAt=_now(), updatedAt=_now())
            session.add(project)
            await session.flush()

            item = DraftItem(
                projectId=project.id, type="STORY", title="Order history",
                description="d", status="APPROVED",
                flags={"sourceRemoved": True} if flagged else None,
                createdAt=_now(), updatedAt=_now(),
            )
            session.add(item)
            await session.flush()

            if published:
                session.add(
                    PublishMapping(
                        projectId=project.id, tool="JIRA", remoteProject="KAN",
                        typeMap={"STORY": "Story"}, createdAt=_now(), updatedAt=_now(),
                    )
                )
                session.add(
                    PublishedItem(
                        draftItemId=item.id, targetTool="JIRA", externalKey="KAN-101",
                        externalUrl="https://x/browse/KAN-101", createdAt=_now(),
                    )
                )

            ids = {"workspace_id": ws.id, "project_id": project.id, "item_id": item.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


async def _cleanup(ids: dict[str, str]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(delete(PublishedItem).where(PublishedItem.draftItemId == ids["item_id"]))
            await session.execute(delete(PublishMapping).where(PublishMapping.projectId == ids["project_id"]))
            await session.execute(delete(DraftItem).where(DraftItem.id == ids["item_id"]))
            await session.execute(delete(Project).where(Project.id == ids["project_id"]))
            await purge_audit_events(session, ids["workspace_id"])
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def test_flag_removed_posts_a_comment_and_marks_flagged_externally(monkeypatch: pytest.MonkeyPatch) -> None:
    ids = asyncio.run(_fixture())

    posted: list[tuple[str, str]] = []

    async def fake_add_comment(_conn: object, issue_key: str, text: str) -> None:
        posted.append((issue_key, text))

    monkeypatch.setattr(
        "app.services.connectors.jira_auth.get_jira_connection",
        lambda: CloudTokenConnection("e", "t", "https://x"),
    )
    monkeypatch.setattr("app.routers.flag_removed.get_jira_connection", lambda: CloudTokenConnection("e", "t", "https://x"))
    monkeypatch.setattr("app.routers.flag_removed.jira_add_comment", fake_add_comment)

    client = TestClient(app)
    try:
        response = client.post(
            f"/draft-items/{ids['item_id']}/flag-removed",
            json={"workspace_id": ids["workspace_id"]},
        )
    finally:
        _dispose()

    assert response.status_code == 200
    body = response.json()
    assert body["tool"] == "JIRA"
    assert body["external_key"] == "KAN-101"
    assert posted == [("KAN-101", posted[0][1])]
    assert "NOT auto-closed" in posted[0][1]

    async def fetch_flags() -> dict[str, object] | None:
        engine = create_async_engine(settings.database_url)
        try:
            async with AsyncSession(engine) as session:
                item = await session.get(DraftItem, ids["item_id"])
                assert item is not None
                return item.flags
        finally:
            await engine.dispose()

    flags = asyncio.run(fetch_flags())
    assert flags is not None and flags.get("sourceRemovedFlaggedExternally") is True

    asyncio.run(_cleanup(ids))


def test_flag_removed_rejects_an_item_not_flagged_as_removed() -> None:
    ids = asyncio.run(_fixture(flagged=False))

    client = TestClient(app)
    try:
        response = client.post(
            f"/draft-items/{ids['item_id']}/flag-removed",
            json={"workspace_id": ids["workspace_id"]},
        )
    finally:
        _dispose()

    assert response.status_code == 409

    asyncio.run(_cleanup(ids))


def test_flag_removed_404s_when_item_was_never_published() -> None:
    ids = asyncio.run(_fixture(published=False))

    client = TestClient(app)
    try:
        response = client.post(
            f"/draft-items/{ids['item_id']}/flag-removed",
            json={"workspace_id": ids["workspace_id"]},
        )
    finally:
        _dispose()

    assert response.status_code == 404

    asyncio.run(_cleanup(ids))
