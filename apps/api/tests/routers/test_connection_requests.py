"""ConnectionRequest router tests — real Postgres (same sync-test + asyncio.run
pattern as test_github_oauth.py, for the same event-loop reasons documented
there)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import db as db_module
from app.core.config import settings
from app.main import app
from app.models import ConnectionRequest, User, Workspace


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dispose_app_engine() -> None:
    asyncio.run(db_module.engine.dispose())


async def _create_workspace_and_user_async() -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            workspace = Workspace(name="Connection Request Test WS", createdAt=now, updatedAt=now)
            session.add(workspace)
            await session.flush()
            user = User(
                email=f"admin-{workspace.id}@example.com",
                name="Test Admin",
                passwordHash="not-a-real-hash",
                createdAt=now,
                updatedAt=now,
            )
            session.add(user)
            await session.flush()
            ids = {"workspace_id": workspace.id, "user_id": user.id}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


def _create_workspace_and_user() -> dict[str, str]:
    return asyncio.run(_create_workspace_and_user_async())


async def _create_request_row_async(
    workspace_id: str, user_id: str, tool_key: str, status: str, expires_in_future: bool
) -> dict[str, str]:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            now = _now()
            delta = timedelta(days=1) if expires_in_future else -timedelta(days=1)
            cr = ConnectionRequest(
                workspaceId=workspace_id,
                toolKey=tool_key,
                requestedByUserId=user_id,
                token=f"test-token-{now.timestamp()}",
                status=status,
                createdAt=now,
                expiresAt=now + delta,
            )
            session.add(cr)
            await session.flush()
            ids = {"id": cr.id, "token": cr.token}
            await session.commit()
            return ids
    finally:
        await engine.dispose()


def _create_request_row(
    workspace_id: str,
    user_id: str,
    tool_key: str = "github",
    status: str = "SENT",
    expires_in_future: bool = True,
) -> dict[str, str]:
    return asyncio.run(
        _create_request_row_async(workspace_id, user_id, tool_key, status, expires_in_future)
    )


async def _cleanup_async(ids: dict[str, str]) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            await session.execute(
                delete(ConnectionRequest).where(ConnectionRequest.workspaceId == ids["workspace_id"])
            )
            await session.execute(delete(User).where(User.id == ids["user_id"]))
            await session.execute(delete(Workspace).where(Workspace.id == ids["workspace_id"]))
            await session.commit()
    finally:
        await engine.dispose()


def _cleanup(ids: dict[str, str]) -> None:
    asyncio.run(_cleanup_async(ids))


def test_create_connection_request_returns_sent_status_with_token() -> None:
    ids = _create_workspace_and_user()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.post(
            f"/workspaces/{ids['workspace_id']}/connection-requests",
            json={"tool_key": "jira", "requested_by_user_id": ids["user_id"]},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["tool_key"] == "jira"
        assert body["status"] == "SENT"
        assert body["token"]
        assert "Jira admin" in body["instructions"]
    finally:
        _cleanup(ids)


def test_get_connection_request_returns_instructions_and_status() -> None:
    ids = _create_workspace_and_user()
    try:
        row = _create_request_row(ids["workspace_id"], ids["user_id"], tool_key="github")
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(f"/connection-requests/{row['token']}")
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "SENT"
        assert "GitHub authorization" in body["instructions"]
    finally:
        _cleanup(ids)


def test_get_connection_request_returns_404_if_unknown_token() -> None:
    _dispose_app_engine()
    client = TestClient(app)
    res = client.get("/connection-requests/nonexistent-token")
    assert res.status_code == 404


def test_get_connection_request_marks_expired_when_past_ttl() -> None:
    ids = _create_workspace_and_user()
    try:
        row = _create_request_row(ids["workspace_id"], ids["user_id"], expires_in_future=False)
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(f"/connection-requests/{row['token']}")
        assert res.status_code == 200
        assert res.json()["status"] == "EXPIRED"
    finally:
        _cleanup(ids)


def test_complete_connection_request_marks_completed() -> None:
    ids = _create_workspace_and_user()
    try:
        row = _create_request_row(ids["workspace_id"], ids["user_id"])
        _dispose_app_engine()
        client = TestClient(app)
        res = client.post(f"/connection-requests/{row['token']}/complete")
        assert res.status_code == 200
        assert res.json()["status"] == "COMPLETED"
    finally:
        _cleanup(ids)


def test_complete_connection_request_returns_409_if_already_completed() -> None:
    ids = _create_workspace_and_user()
    try:
        row = _create_request_row(ids["workspace_id"], ids["user_id"], status="COMPLETED")
        _dispose_app_engine()
        client = TestClient(app)
        res = client.post(f"/connection-requests/{row['token']}/complete")
        assert res.status_code == 409
    finally:
        _cleanup(ids)


def test_complete_connection_request_returns_409_if_expired() -> None:
    ids = _create_workspace_and_user()
    try:
        row = _create_request_row(ids["workspace_id"], ids["user_id"], expires_in_future=False)
        _dispose_app_engine()
        client = TestClient(app)
        res = client.post(f"/connection-requests/{row['token']}/complete")
        assert res.status_code == 409
    finally:
        _cleanup(ids)


def test_complete_connection_request_returns_404_if_unknown_token() -> None:
    _dispose_app_engine()
    client = TestClient(app)
    res = client.post("/connection-requests/nonexistent-token/complete")
    assert res.status_code == 404


def test_list_connection_requests_returns_all_for_workspace_newest_first() -> None:
    ids = _create_workspace_and_user()
    try:
        _create_request_row(ids["workspace_id"], ids["user_id"], tool_key="jira")
        newest = _create_request_row(ids["workspace_id"], ids["user_id"], tool_key="github")
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(f"/workspaces/{ids['workspace_id']}/connection-requests")
        assert res.status_code == 200
        body = res.json()
        assert len(body) == 2
        assert body[0]["id"] == newest["id"]
    finally:
        _cleanup(ids)


def test_list_connection_requests_returns_empty_for_workspace_with_none() -> None:
    ids = _create_workspace_and_user()
    try:
        _dispose_app_engine()
        client = TestClient(app)
        res = client.get(f"/workspaces/{ids['workspace_id']}/connection-requests")
        assert res.status_code == 200
        assert res.json() == []
    finally:
        _cleanup(ids)
